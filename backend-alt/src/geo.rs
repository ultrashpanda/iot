// Wi-Fi geolocation: the routers a node sees at power-up (port 2) → Google Geolocation API → position.
// The key stays on the server (GOOGLE_API_KEY in .env). Errors never print the request URL,
// because the key is in it.

use std::time::Duration;

use serde_json::{json, Value};

use crate::uplink::Ap;

/// Fixes less precise than this are ignored (the node keeps its previous position).
pub const MAX_ACCURACY_M: f64 = 250.0;
/// Fewer routers than this give no reliable fix (Team 2 position rule).
pub const MIN_APS: usize = 3;
/// A fix further than this from the previous position means the node might have moved.
pub const MOVED_M: f64 = 100.0;

#[derive(Debug, Clone, Copy)]
pub struct Fix {
    pub lat: f64,
    pub lon: f64,
    pub accuracy_m: f64,
}

#[derive(Clone)]
pub struct Geolocator {
    http: reqwest::Client,
    key: String,
}

impl Geolocator {
    pub fn new(key: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("could not build HTTP client");
        Geolocator { http, key }
    }

    pub async fn locate(&self, aps: &[Ap]) -> Result<Fix, String> {
        let body = json!({
            "considerIp": false,
            "wifiAccessPoints": aps.iter()
                .map(|a| json!({ "macAddress": mac(&a.bssid), "signalStrength": a.rssi_dbm }))
                .collect::<Vec<_>>(),
        });
        let response = self.http
            .post("https://www.googleapis.com/geolocation/v1/geolocate")
            .query(&[("key", self.key.as_str())])
            .json(&body)
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        let status = response.status();
        let v: Value = response.json().await.map_err(|e| e.without_url().to_string())?;
        if !status.is_success() {
            let msg = v["error"]["message"].as_str().unwrap_or("no details");
            return Err(format!("Google returned {status}: {msg}"));
        }
        Ok(Fix {
            lat: v["location"]["lat"].as_f64().ok_or("no location.lat in Google's answer")?,
            lon: v["location"]["lng"].as_f64().ok_or("no location.lng in Google's answer")?,
            accuracy_m: v["accuracy"].as_f64().unwrap_or(f64::MAX),
        })
    }
}

/// BSSID bytes → "00:2A:10:A1:B2:C3".
pub fn mac(b: &[u8; 6]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect::<Vec<_>>().join(":")
}

/// Great-circle distance in metres.
pub fn distance_m(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (la1, lo1, la2, lo2) = (a.0.to_radians(), a.1.to_radians(), b.0.to_radians(), b.1.to_radians());
    let h = ((la2 - la1) / 2.0).sin().powi(2) + la1.cos() * la2.cos() * ((lo2 - lo1) / 2.0).sin().powi(2);
    2.0 * 6_371_000.0 * h.sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_format() { assert_eq!(mac(&[0x00, 0x2A, 0x10, 0xA1, 0xB2, 0xC3]), "00:2A:10:A1:B2:C3"); }

    #[test]
    fn distance() {
        let d = distance_m((55.6170, 12.0790), (55.6179, 12.0790)); // 0.0009° latitude ≈ 100 m
        assert!((d - 100.0).abs() < 1.0, "{d}");
    }
}
