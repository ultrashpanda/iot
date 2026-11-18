// TTN uplinks over MQTT (TLS). TTN has already decrypted the LoRaWAN payload: no crypto here.

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::{DateTime, Utc};
use rumqttc::{AsyncClient, Event, EventLoop, MqttOptions, Outgoing, Packet, QoS, Transport};
use serde_json::Value;
use tokio::sync::mpsc::Sender;

use crate::source::{RawUplink, Source};

pub struct TtnConfig {
    pub app_id: String,
    pub host: String,
    pub api_key: String,
}

/// Handle for sending downlinks. Cheap to clone; the MQTT connection is shared with the uplink loop.
#[derive(Clone)]
pub struct Ttn {
    client: AsyncClient,
    app_id: String,
}

impl Ttn {
    /// Replaces the device's downlink queue at TTN with this one message. TTN delivers it after the
    /// node's next uplink (class A). Needs the API key right "Write downlink application traffic".
    pub async fn send_downlink(&self, dev_id: &str, port: u8, bytes: &[u8]) -> Result<(), String> {
        let topic = format!("v3/{}@ttn/devices/{}/down/replace", self.app_id, dev_id);
        let body = serde_json::json!({
            "downlinks": [{ "f_port": port, "frm_payload": B64.encode(bytes), "priority": "NORMAL" }]
        });
        self.client
            .publish(topic, QoS::AtLeastOnce, false, body.to_string())
            .await
            .map_err(|e| format!("MQTT publish failed: {e}"))
    }
}

/// Connects to TTN, spawns the uplink loop and returns the handle for downlinks.
pub fn start(cfg: TtnConfig, tx: Sender<RawUplink>) -> Ttn {
    let client_id = format!("soundscape-backend-{}", std::process::id());
    let mut opts = MqttOptions::new(client_id, cfg.host.clone(), 8883);
    opts.set_credentials(format!("{}@ttn", cfg.app_id), cfg.api_key);
    opts.set_keep_alive(Duration::from_secs(30));
    opts.set_max_packet_size(256 * 1024, 256 * 1024); // TTN uplink JSON is a few kB
    opts.set_transport(Transport::tls_with_default_config());

    let (client, eventloop) = AsyncClient::new(opts, 10);
    println!("[ttn] connecting to {} as {}@ttn", cfg.host, cfg.app_id);
    let topic = format!("v3/{}@ttn/devices/+/up", cfg.app_id);
    tokio::spawn(run(client.clone(), eventloop, topic, tx));
    Ttn { client, app_id: cfg.app_id }
}

async fn run(client: AsyncClient, mut eventloop: EventLoop, topic: String, tx: Sender<RawUplink>) {
    loop {
        match eventloop.poll().await {
            // Subscribe on every (re)connect: a clean session forgets subscriptions.
            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                println!("[ttn] connected, subscribing to {topic}");
                if let Err(e) = client.try_subscribe(topic.clone(), QoS::AtLeastOnce) {
                    eprintln!("[ttn] subscribe failed: {e}");
                }
            }
            Ok(Event::Incoming(Packet::SubAck(_))) => println!("[ttn] subscribed, waiting for uplinks"),
            Ok(Event::Incoming(Packet::Publish(p))) => match parse_uplink(&p.payload) {
                Ok(Some(up)) => {
                    if tx.send(up).await.is_err() {
                        return;
                    }
                }
                Ok(None) => {} // uplink without application payload (MAC only)
                Err(e) => eprintln!("[ttn] ignored message on {}: {e}", p.topic),
            },
            Ok(Event::Outgoing(Outgoing::Publish(_))) => println!("[ttn] downlink sent to TTN"),
            Ok(_) => {}
            Err(e) => {
                eprintln!("[ttn] connection error: {e}. Check TTN_API_KEY (rights) and TTN_APP_ID. Retrying in 5 s");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

/// TTN v3 uplink JSON → RawUplink (field mapping from docs/SoundScape-Messages-Team2-Backend.md).
fn parse_uplink(body: &[u8]) -> Result<Option<RawUplink>, String> {
    let v: Value = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    let dev_id = v["end_device_ids"]["device_id"].as_str().ok_or("no device_id")?.to_string();
    let up = &v["uplink_message"];
    let Some(frm) = up["frm_payload"].as_str() else { return Ok(None) };
    let port = up["f_port"].as_u64().ok_or("no f_port")? as u8;
    let f_cnt = up["f_cnt"].as_u64().unwrap_or(0) as u32; // TTN leaves out f_cnt = 0
    let received_at = v["received_at"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);
    let payload = B64.decode(frm).map_err(|e| format!("bad base64: {e}"))?;

    // Strongest gateway, and its SNR.
    let best = up["rx_metadata"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| {
            let rssi = g["rssi"].as_f64().or_else(|| g["channel_rssi"].as_f64())?;
            Some((rssi, g["snr"].as_f64()))
        })
        .max_by(|a, b| a.0.total_cmp(&b.0));

    Ok(Some(RawUplink {
        dev_id,
        port,
        f_cnt,
        received_at,
        payload,
        rssi: best.map(|(r, _)| r.round() as i16),
        snr: best.and_then(|(_, s)| s).map(|s| s as f32),
        source: Source::Physical,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ttn_uplink() {
        let body = br#"{
          "end_device_ids": { "device_id": "1-soundscape-device" },
          "received_at": "2026-11-18T10:00:00.123456789Z",
          "uplink_message": {
            "f_port": 1, "f_cnt": 42, "frm_payload": "fK4AGgDYKQE=",
            "rx_metadata": [ { "rssi": -110, "snr": -3.5 }, { "rssi": -97, "channel_rssi": -97, "snr": 6.25 } ]
          }
        }"#;
        let up = parse_uplink(body).unwrap().unwrap();
        assert_eq!((up.dev_id.as_str(), up.port, up.f_cnt), ("1-soundscape-device", 1, 42));
        assert_eq!(up.payload, vec![0x7C, 0xAE, 0x00, 0x1A, 0x00, 0xD8, 0x29, 0x01]);
        assert_eq!((up.rssi, up.snr), (Some(-97), Some(6.25)));
    }

    #[test]
    fn skips_mac_only_uplink() {
        let body = br#"{ "end_device_ids": { "device_id": "x" }, "uplink_message": { "f_cnt": 3 } }"#;
        assert!(parse_uplink(body).unwrap().is_none());
    }
}
