// Device state in memory + every real uplink in SQLite.
//
// SQLite keeps the raw payload of every physical uplink. On startup those rows are replayed through
// the decoder, so the map shows the last state straight away and old rows are re-decoded with the
// current decoder. Simulated uplinks are kept in memory only.

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::source::{RawUplink, Source};
use crate::uplink::{self, CrowdSource, DecodeError, Measurement, Uplink};

/// Map centre used for devices without a configured position (same as frontend/js/config.js).
const CENTER: (f64, f64) = (55.607, 12.071);

/// One entry in devices.json: installation position of a real node, keyed by TTN device id.
#[derive(Debug, Deserialize)]
pub struct DeviceConfig {
    pub name: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    pub interval_min: Option<u32>,
}

pub fn load_device_config(path: &str) -> HashMap<String, DeviceConfig> {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(map) => map,
            Err(e) => {
                eprintln!("[config] {path} is not valid JSON ({e}). Real nodes get a placeholder position.");
                HashMap::new()
            }
        },
        Err(_) => {
            println!("[config] no {path}: real nodes get a placeholder position (see devices.example.json)");
            HashMap::new()
        }
    }
}

pub struct Device {
    id: String,
    name: String,
    lat: f64,
    lon: f64,
    source: Source,
    might_have_moved: bool,
    interval_min: u32,
    /// Interval sent by downlink, applied when the node's next uplink arrives (class A).
    pending_interval_min: Option<u32>,
    checkin_min: u32,
    last_seen: Option<DateTime<Utc>>,
    last_port: Option<u8>,
    last: Option<Measurement>,
    measured_at: Option<DateTime<Utc>>,
    battery_pct: Option<u8>,
    battery_v: Option<f32>,
    powered_up_at: Option<DateTime<Utc>>,
    firmware: Option<String>,
    rssi: Option<i16>,
    snr: Option<f32>,
}

/// GET /api/devices item. Every key is always present; None → null.
#[derive(Serialize)]
pub struct DeviceJson {
    id: String,
    name: String,
    latitude: f64,
    longitude: f64,
    might_have_moved: bool,
    noise_avg: Option<f32>,
    noise_peak: Option<f32>,
    noise_clipped: bool,
    crowd_count: Option<u16>,
    crowd_source: Option<&'static str>,
    temperature: Option<f32>,
    humidity: Option<u8>,
    battery_voltage: Option<f32>,
    battery_estimate_pct: Option<u8>,
    status: &'static str,
    source: &'static str,
    last_updated: Option<String>,
    // Extras, not in the Team 3 contract yet:
    interval_min: Option<u32>,         // physical nodes only
    pending_interval_min: Option<u32>, // sent, not yet delivered
    last_seen: Option<String>,
    powered_up_at: Option<String>,
    firmware: Option<String>,
    rssi: Option<i16>,
    snr: Option<f32>,
}

pub fn iso(t: DateTime<Utc>) -> String { t.to_rfc3339_opts(SecondsFormat::Millis, true) }

/// Placeholder positions on a spiral around the map centre, so markers don't overlap.
fn spiral(n: usize) -> (f64, f64) {
    let angle = n as f64 * 2.399_963; // golden angle in radians
    let r = 0.0012 * ((n + 1) as f64).sqrt();
    let lon_scale = CENTER.0.to_radians().cos();
    (CENTER.0 + r * angle.cos(), CENTER.1 + r * angle.sin() / lon_scale)
}

pub struct Store {
    db: Connection,
    devices: BTreeMap<String, Device>,
    config: HashMap<String, DeviceConfig>,
    default_interval_min: u32,
}

impl Store {
    pub fn open(path: &str, config: HashMap<String, DeviceConfig>, default_interval_min: u32) -> rusqlite::Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS uplinks (
                dev_id TEXT NOT NULL, received_at TEXT NOT NULL, f_cnt INTEGER NOT NULL, port INTEGER NOT NULL,
                raw BLOB NOT NULL, rssi INTEGER, snr REAL, error TEXT,
                UNIQUE (dev_id, f_cnt, received_at));
             CREATE TABLE IF NOT EXISTS measurements (
                dev_id TEXT NOT NULL, received_at TEXT NOT NULL, f_cnt INTEGER NOT NULL, raw BLOB NOT NULL,
                noise_avg REAL, noise_peak REAL, noise_clipped INTEGER NOT NULL, crowd_count INTEGER,
                crowd_source TEXT, temperature REAL, humidity INTEGER, flags INTEGER NOT NULL,
                battery_pct INTEGER, battery_rest_v REAL, battery_load_v REAL, rssi INTEGER, snr REAL);
             CREATE TABLE IF NOT EXISTS downlinks (
                id INTEGER PRIMARY KEY, dev_id TEXT NOT NULL, created_at TEXT NOT NULL, port INTEGER NOT NULL,
                bytes BLOB NOT NULL, kind TEXT NOT NULL, value INTEGER, state TEXT NOT NULL);",
        )?;

        let history = {
            let mut stmt = db.prepare(
                "SELECT dev_id, port, f_cnt, received_at, raw, rssi, snr FROM uplinks ORDER BY received_at",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(RawUplink {
                    dev_id: r.get(0)?,
                    port: r.get::<_, i64>(1)? as u8,
                    f_cnt: r.get::<_, i64>(2)? as u32,
                    received_at: r.get::<_, String>(3)?.parse::<DateTime<Utc>>().unwrap_or_else(|_| Utc::now()),
                    payload: r.get(4)?,
                    rssi: r.get::<_, Option<i64>>(5)?.map(|v| v as i16),
                    snr: r.get::<_, Option<f64>>(6)?.map(|v| v as f32),
                    source: Source::Physical,
                })
            })?;
            let history: Vec<RawUplink> = rows.collect::<rusqlite::Result<_>>()?;
            history
        };

        let mut store = Store { db, devices: BTreeMap::new(), config, default_interval_min };
        for raw in &history {
            let _ = store.apply(raw);
        }
        // Interval downlinks: 'sent' ones are the node's current interval, a 'pending' one is still queued at TTN.
        let downlinks = {
            let mut stmt = store.db.prepare(
                "SELECT dev_id, value, state FROM downlinks WHERE kind = 'interval' ORDER BY created_at",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))?;
            let downlinks: Vec<(String, i64, String)> = rows.collect::<rusqlite::Result<_>>()?;
            downlinks
        };
        for (dev_id, minutes, state) in downlinks {
            if let Some(d) = store.devices.get_mut(&dev_id) {
                if state == "sent" { d.interval_min = minutes as u32 } else { d.pending_interval_min = Some(minutes as u32) }
            }
        }
        // Configured nodes show up on the map (as offline) before their first uplink.
        let configured: Vec<String> = store.config.keys().cloned().collect();
        for id in configured {
            store.device_mut(&id, Source::Physical);
        }
        println!("[db] {path}: replayed {} stored uplinks from {} devices", history.len(), store.devices.len());
        Ok(store)
    }

    /// Entry point for every uplink, real or simulated.
    pub fn ingest(&mut self, raw: RawUplink) {
        let physical = raw.source == Source::Physical;
        if physical {
            let error = uplink::decode(raw.port, &raw.payload).err().map(|e| e.to_string());
            let inserted = self.db.execute(
                "INSERT OR IGNORE INTO uplinks (dev_id, received_at, f_cnt, port, raw, rssi, snr, error)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![raw.dev_id, iso(raw.received_at), raw.f_cnt as i64, raw.port as i64, raw.payload,
                        raw.rssi.map(|v| v as i64), raw.snr.map(|v| v as f64), error],
            );
            match inserted {
                Ok(0) => return, // duplicate (dev_id, f_cnt, received_at)
                Ok(_) => {
                    // TTN delivers a queued downlink right after this uplink.
                    if let Err(e) = self.db.execute(
                        "UPDATE downlinks SET state = 'sent' WHERE dev_id = ?1 AND state = 'pending'",
                        params![raw.dev_id],
                    ) {
                        eprintln!("[db] could not update downlinks for {}: {e}", raw.dev_id);
                    }
                }
                Err(e) => eprintln!("[db] could not store uplink from {}: {e}", raw.dev_id),
            }
        }

        let decoded = self.apply(&raw);
        if !physical {
            return;
        }
        let hex: Vec<String> = raw.payload.iter().map(|b| format!("{b:02X}")).collect();
        match &decoded {
            Ok(Uplink::Measurement(m)) => {
                println!(
                    "[uplink] {} port 1 #{}: {:.1} dB avg, {:.1} dB peak, crowd {:?}, {:?} °C, {:?} %, battery {:?}",
                    raw.dev_id, raw.f_cnt, m.noise_avg, m.noise_peak, m.crowd.as_ref().map(|c| c.count),
                    m.temperature, m.humidity, m.battery.map(|b| b.pct)
                );
                self.store_measurement(&raw, m);
            }
            Ok(other) => println!("[uplink] {} port {} #{}: {:?}", raw.dev_id, raw.port, raw.f_cnt, other),
            Err(e) => eprintln!("[uplink] {} port {} #{}: {e}. Raw bytes kept: {}", raw.dev_id, raw.port, raw.f_cnt, hex.join(" ")),
        }
    }

    fn store_measurement(&self, raw: &RawUplink, m: &Measurement) {
        let crowd_source = m.crowd.as_ref().map(|c| crowd_source_str(c.source));
        let result = self.db.execute(
            "INSERT INTO measurements (dev_id, received_at, f_cnt, raw, noise_avg, noise_peak, noise_clipped,
                crowd_count, crowd_source, temperature, humidity, flags, battery_pct, battery_rest_v,
                battery_load_v, rssi, snr)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                raw.dev_id, iso(raw.received_at), raw.f_cnt as i64, raw.payload,
                m.noise_valid().then_some(m.noise_avg as f64), m.noise_valid().then_some(m.noise_peak as f64),
                m.noise_clipped, m.crowd.as_ref().map(|c| c.count as i64), crowd_source,
                m.temperature.map(|t| t as f64), m.humidity.map(|h| h as i64), m.flags.0 as i64,
                m.battery.map(|b| b.pct as i64), m.battery.map(|b| b.rest_v as f64), m.battery.map(|b| b.load_v as f64),
                raw.rssi.map(|v| v as i64), raw.snr.map(|v| v as f64)
            ],
        );
        if let Err(e) = result {
            eprintln!("[db] could not store measurement from {}: {e}", raw.dev_id);
        }
    }

    /// Updates the in-memory device from one uplink. No database writes (also used for replay).
    fn apply(&mut self, raw: &RawUplink) -> Result<Uplink, DecodeError> {
        let decoded = uplink::decode(raw.port, &raw.payload);
        let dev = self.device_mut(&raw.dev_id, raw.source);
        if let Some(minutes) = dev.pending_interval_min.take() {
            dev.interval_min = minutes;
            println!("[downlink] {}: interval {minutes} min delivered with this uplink", raw.dev_id);
        }
        dev.last_seen = Some(raw.received_at);
        dev.last_port = Some(raw.port);
        dev.rssi = raw.rssi;
        dev.snr = raw.snr;
        match &decoded {
            Ok(Uplink::Measurement(m)) => {
                dev.measured_at = Some(raw.received_at);
                if let Some(b) = m.battery {
                    dev.battery_pct = Some(b.pct);
                    dev.battery_v = Some(b.rest_v);
                }
                dev.last = Some(m.clone());
            }
            Ok(Uplink::Geolocation(_)) => dev.powered_up_at = Some(raw.received_at),
            Ok(Uplink::SleepCheckIn { battery_pct, .. }) => {
                if battery_pct.is_some() {
                    dev.battery_pct = *battery_pct;
                }
            }
            Ok(Uplink::Boot(b)) => dev.firmware = Some(format!("{}.{}", b.fw_major, b.fw_minor)),
            Err(_) => {}
        }
        decoded
    }

    fn device_mut(&mut self, id: &str, source: Source) -> &mut Device {
        let n = self.devices.len();
        let cfg = self.config.get(id);
        let default_interval = self.default_interval_min;
        self.devices.entry(id.to_string()).or_insert_with(|| {
            let (lat, lon) = cfg.map(|c| (c.latitude, c.longitude)).unwrap_or_else(|| spiral(n));
            if cfg.is_none() && source == Source::Physical {
                println!("[config] new device {id} has no position: add it to devices.json");
            }
            Device {
                id: id.to_string(),
                name: cfg.and_then(|c| c.name.clone()).unwrap_or_else(|| id.to_string()),
                lat,
                lon,
                source,
                // Without a configured position we can't know where a real node is.
                might_have_moved: cfg.is_none() && source == Source::Physical,
                interval_min: cfg.and_then(|c| c.interval_min).unwrap_or(default_interval),
                pending_interval_min: None,
                checkin_min: 30,
                last_seen: None,
                last_port: None,
                last: None,
                measured_at: None,
                battery_pct: None,
                battery_v: None,
                powered_up_at: None,
                firmware: None,
                rssi: None,
                snr: None,
            }
        })
    }

    pub fn is_physical(&self, id: &str) -> bool {
        self.devices.get(id).is_some_and(|d| d.source == Source::Physical)
    }

    /// Records an interval downlink that was handed to TTN. It becomes the interval on the next uplink.
    pub fn record_interval_downlink(&mut self, id: &str, minutes: u32, bytes: &[u8]) {
        // A newer command replaces the queue at TTN, so older pending rows will never be delivered.
        let result = self.db.execute(
            "UPDATE downlinks SET state = 'replaced' WHERE dev_id = ?1 AND state = 'pending'",
            params![id],
        ).and_then(|_| self.db.execute(
            "INSERT INTO downlinks (dev_id, created_at, port, bytes, kind, value, state)
             VALUES (?1, ?2, 1, ?3, 'interval', ?4, 'pending')",
            params![id, iso(Utc::now()), bytes, minutes as i64],
        ));
        if let Err(e) = result {
            eprintln!("[db] could not store downlink for {id}: {e}");
        }
        if let Some(d) = self.devices.get_mut(id) {
            d.pending_interval_min = Some(minutes);
        }
        println!("[downlink] {id}: interval {minutes} min queued at TTN, delivered after the next uplink");
    }

    pub fn snapshot(&self, now: DateTime<Utc>) -> Vec<DeviceJson> {
        self.devices.values().map(|d| {
            let m = d.last.as_ref();
            let noise_ok = m.is_some_and(|m| m.noise_valid());
            DeviceJson {
                id: d.id.clone(),
                name: d.name.clone(),
                latitude: d.lat,
                longitude: d.lon,
                might_have_moved: d.might_have_moved,
                noise_avg: m.filter(|_| noise_ok).map(|m| m.noise_avg),
                noise_peak: m.filter(|_| noise_ok).map(|m| m.noise_peak),
                noise_clipped: m.is_some_and(|m| m.noise_clipped),
                crowd_count: m.and_then(|m| m.crowd.as_ref()).map(|c| c.count),
                crowd_source: m.and_then(|m| m.crowd.as_ref()).map(|c| crowd_source_str(c.source)),
                temperature: m.and_then(|m| m.temperature),
                humidity: m.and_then(|m| m.humidity),
                battery_voltage: d.battery_v,
                battery_estimate_pct: d.battery_pct,
                status: status(d, now),
                source: d.source.as_str(),
                last_updated: d.measured_at.map(iso),
                last_seen: d.last_seen.map(iso),
                interval_min: (d.source == Source::Physical).then_some(d.interval_min),
                pending_interval_min: d.pending_interval_min,
                powered_up_at: d.powered_up_at.map(iso),
                firmware: d.firmware.clone(),
                rssi: d.rssi,
                snr: d.snr,
            }
        }).collect()
    }
}

fn crowd_source_str(s: CrowdSource) -> &'static str {
    match s { CrowdSource::Networks => "networks", CrowdSource::Phones => "phones" }
}

/// Team 2 state rules: online if the last measurement-type uplink is recent enough for the node's
/// interval, sleeping if the last uplink is a recent check-in, else offline.
fn status(d: &Device, now: DateTime<Utc>) -> &'static str {
    let Some(seen) = d.last_seen else { return "offline" };
    let age = now - seen;
    match d.last_port {
        Some(3) if age <= Duration::minutes(2 * d.checkin_min as i64) => "sleeping",
        Some(p) if p != 3 && age <= Duration::minutes(3 * d.interval_min as i64) => "online",
        _ => "offline",
    }
}
