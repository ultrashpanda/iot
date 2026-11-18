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
use crate::geo::{self, Fix};
use crate::uplink::{self, Ap, CrowdSource, DecodeError, Downlink, Measurement, Uplink};

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
                eprintln!("{} [config] {path} is not valid JSON ({e}). Real nodes get a placeholder position.", crate::source::hms());
                HashMap::new()
            }
        },
        Err(_) => {
            println!("{} [config] no {path}: real nodes get a placeholder position (see devices.example.json)", crate::source::hms());
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
    position_source: &'static str, // "installation" (devices.json), "wifi" (Google), "placeholder"
    position_accuracy_m: Option<f64>,
    interval_min: u32,
    /// Commands queued at TTN, front = delivered with the next uplink (class A, one per uplink).
    pending: Vec<Command>,
    checkin_min: u32,
    last_seen: Option<DateTime<Utc>>,
    last_port: Option<u8>,
    last: Option<Measurement>,
    measured_at: Option<DateTime<Utc>>,
    battery_pct: Option<u8>,
    battery_v: Option<f32>,
    powered_up_at: Option<DateTime<Utc>>,
    firmware: Option<(u8, u8)>,
    rssi: Option<i16>,
    snr: Option<f32>,
}

/// A command for a real node, sent as a port 1 downlink.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Command {
    Interval(u8),
    Reboot,
}

impl Command {
    pub fn downlink(self) -> Downlink {
        match self { Command::Interval(minutes) => Downlink::Interval { minutes }, Command::Reboot => Downlink::Reboot }
    }
    fn kind(self) -> &'static str {
        match self { Command::Interval(_) => "interval", Command::Reboot => "reboot" }
    }
    fn value(self) -> Option<i64> {
        match self { Command::Interval(m) => Some(m as i64), Command::Reboot => None }
    }
}

/// Firmware that understands the reboot downlink (06).
const REBOOT_FIRMWARE: (u8, u8) = (0, 8);

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
    position_source: &'static str,
    position_accuracy_m: Option<f64>,
    interval_min: Option<u32>,         // physical nodes only
    pending_interval_min: Option<u32>, // sent, not yet delivered
    pending_reboot: bool,
    reboot_supported: Option<bool>,    // None = firmware version not known yet
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

pub struct GeoRequest {
    pub dev_id: String,
    pub received_at: DateTime<Utc>,
    pub aps: Vec<Ap>,
}

/// Team 2 position rules, plus: fixes worse than MAX_ACCURACY_M are ignored, and a node with only a
/// placeholder position takes its first good fix without a "moved" warning.
fn apply_position(d: &mut Device, n_aps: usize, fix: Option<Fix>) {
    match fix {
        Some(f) if n_aps >= geo::MIN_APS && f.accuracy_m <= geo::MAX_ACCURACY_M => {
            let moved = d.position_source != "placeholder" && geo::distance_m((d.lat, d.lon), (f.lat, f.lon)) > geo::MOVED_M;
            d.lat = f.lat;
            d.lon = f.lon;
            d.might_have_moved = moved;
            d.position_source = "wifi";
            d.position_accuracy_m = Some(f.accuracy_m);
        }
        _ => d.might_have_moved = true,
    }
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
                bytes BLOB NOT NULL, kind TEXT NOT NULL, value INTEGER, state TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS ap_scans (
                dev_id TEXT NOT NULL, received_at TEXT NOT NULL, n_aps INTEGER NOT NULL, aps_json TEXT NOT NULL,
                lat REAL, lon REAL, accuracy_m REAL, error TEXT);",
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
        // Downlinks: a 'sent' interval is the node's current interval, 'pending' ones are still queued at TTN.
        let downlinks = {
            let mut stmt = store.db.prepare(
                "SELECT dev_id, kind, value, state FROM downlinks WHERE state IN ('sent', 'pending') ORDER BY id",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, String>(3)?))
            })?;
            let downlinks: Vec<(String, String, Option<i64>, String)> = rows.collect::<rusqlite::Result<_>>()?;
            downlinks
        };
        for (dev_id, kind, value, state) in downlinks {
            let cmd = match (kind.as_str(), value) {
                ("interval", Some(m)) => Command::Interval(m as u8),
                ("reboot", _) => Command::Reboot,
                _ => continue,
            };
            if let Some(d) = store.devices.get_mut(&dev_id) {
                match (state.as_str(), cmd) {
                    ("sent", Command::Interval(m)) => d.interval_min = m as u32,
                    ("pending", _) => d.pending.push(cmd),
                    _ => {}
                }
            }
        }
        // Wi-Fi geolocation results, in order, so the position rules end in the same state (no Google calls).
        let scans = {
            let mut stmt = store.db.prepare(
                "SELECT dev_id, n_aps, lat, lon, accuracy_m FROM ap_scans ORDER BY received_at",
            )?;
            let rows = stmt.query_map([], |r| {
                let fix = match (r.get::<_, Option<f64>>(2)?, r.get::<_, Option<f64>>(3)?, r.get::<_, Option<f64>>(4)?) {
                    (Some(lat), Some(lon), Some(accuracy_m)) => Some(Fix { lat, lon, accuracy_m }),
                    _ => None,
                };
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize, fix))
            })?;
            let scans: Vec<(String, usize, Option<Fix>)> = rows.collect::<rusqlite::Result<_>>()?;
            scans
        };
        for (dev_id, n_aps, fix) in &scans {
            if let Some(d) = store.devices.get_mut(dev_id) {
                apply_position(d, *n_aps, *fix);
            }
        }
        // Configured nodes show up on the map (as offline) before their first uplink.
        let configured: Vec<String> = store.config.keys().cloned().collect();
        for id in configured {
            store.device_mut(&id, Source::Physical);
        }
        println!("{} [db] {path}: replayed {} stored uplinks from {} devices", crate::source::hms(), history.len(), store.devices.len());
        Ok(store)
    }

    /// Entry point for every uplink, real or simulated. Returns a geolocation request for a fresh
    /// port 2 uplink from a real node (the caller asks Google, then calls apply_geolocation).
    pub fn ingest(&mut self, raw: RawUplink) -> Option<GeoRequest> {
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
                Ok(0) => return None, // duplicate (dev_id, f_cnt, received_at)
                Ok(_) => {
                    // TTN delivers the oldest queued downlink right after this uplink.
                    if let Err(e) = self.db.execute(
                        "UPDATE downlinks SET state = 'sent' WHERE id =
                            (SELECT MIN(id) FROM downlinks WHERE dev_id = ?1 AND state = 'pending')",
                        params![raw.dev_id],
                    ) {
                        eprintln!("{} [db] could not update downlinks for {}: {e}", crate::source::hms(), raw.dev_id);
                    }
                }
                Err(e) => eprintln!("{} [db] could not store uplink from {}: {e}", crate::source::hms(), raw.dev_id),
            }
        }

        let decoded = self.apply(&raw);
        if !physical {
            return None;
        }
        let hex: Vec<String> = raw.payload.iter().map(|b| format!("{b:02X}")).collect();
        match &decoded {
            Ok(Uplink::Measurement(m)) => {
                println!(
                    "{} [uplink] {} port 1 #{}: {:.1} dB avg, {:.1} dB peak, crowd {:?}, {:?} °C, {:?} %, battery {:?}", crate::source::hms(),
                    raw.dev_id, raw.f_cnt, m.noise_avg, m.noise_peak, m.crowd.as_ref().map(|c| c.count),
                    m.temperature, m.humidity, m.battery.map(|b| b.pct)
                );
                self.store_measurement(&raw, m);
            }
            Ok(other) => println!("{} [uplink] {} port {} #{}: {:?}", crate::source::hms(), raw.dev_id, raw.port, raw.f_cnt, other),
            Err(e) => eprintln!("{} [uplink] {} port {} #{}: {e}. Raw bytes kept: {}", crate::source::hms(), raw.dev_id, raw.port, raw.f_cnt, hex.join(" ")),
        }
        match decoded {
            Ok(Uplink::Geolocation(aps)) => Some(GeoRequest { dev_id: raw.dev_id, received_at: raw.received_at, aps }),
            _ => None,
        }
    }

    /// Stores the outcome of one Wi-Fi scan and applies the position rules. `fix` is None when there
    /// were too few routers or Google could not locate them.
    pub fn apply_geolocation(&mut self, req: &GeoRequest, fix: Option<Fix>, error: Option<String>) {
        let aps_json = serde_json::to_string(
            &req.aps.iter().map(|a| serde_json::json!({ "mac": geo::mac(&a.bssid), "rssi": a.rssi_dbm })).collect::<Vec<_>>(),
        ).unwrap_or_default();
        let result = self.db.execute(
            "INSERT INTO ap_scans (dev_id, received_at, n_aps, aps_json, lat, lon, accuracy_m, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![req.dev_id, iso(req.received_at), req.aps.len() as i64, aps_json,
                    fix.map(|f| f.lat), fix.map(|f| f.lon), fix.map(|f| f.accuracy_m), error],
        );
        if let Err(e) = result {
            eprintln!("{} [db] could not store Wi-Fi scan from {}: {e}", crate::source::hms(), req.dev_id);
        }
        if let Some(d) = self.devices.get_mut(&req.dev_id) {
            apply_position(d, req.aps.len(), fix);
            println!(
                "{} [geo] {}: {} routers → {} ({:.5}, {:.5}){}", crate::source::hms(),
                req.dev_id, req.aps.len(),
                match fix { Some(f) => format!("fix ±{:.0} m", f.accuracy_m), None => "no fix".into() },
                d.lat, d.lon,
                if d.might_have_moved { ", might have moved" } else { "" }
            );
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
            eprintln!("{} [db] could not store measurement from {}: {e}", crate::source::hms(), raw.dev_id);
        }
    }

    /// Updates the in-memory device from one uplink. No database writes (also used for replay).
    fn apply(&mut self, raw: &RawUplink) -> Result<Uplink, DecodeError> {
        let decoded = uplink::decode(raw.port, &raw.payload);
        let dev = self.device_mut(&raw.dev_id, raw.source);
        if !dev.pending.is_empty() {
            match dev.pending.remove(0) {
                Command::Interval(m) => {
                    dev.interval_min = m as u32;
                    println!("{} [downlink] {}: interval {m} min delivered with this uplink", crate::source::hms(), raw.dev_id);
                }
                Command::Reboot => println!("{} [downlink] {}: restart delivered with this uplink, node reboots now", crate::source::hms(), raw.dev_id),
            }
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
            Ok(Uplink::Boot(b)) => dev.firmware = Some((b.fw_major, b.fw_minor)),
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
                println!("{} [config] new device {id} has no position: add it to devices.json", crate::source::hms());
            }
            Device {
                id: id.to_string(),
                name: cfg.and_then(|c| c.name.clone()).unwrap_or_else(|| id.to_string()),
                lat,
                lon,
                source,
                // Without a configured position we can't know where a real node is.
                might_have_moved: cfg.is_none() && source == Source::Physical,
                position_source: if cfg.is_some() { "installation" } else { "placeholder" },
                position_accuracy_m: None,
                interval_min: cfg.and_then(|c| c.interval_min).unwrap_or(default_interval),
                pending: Vec::new(),
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

    /// The node's TTN queue after adding `cmd`: a new interval replaces a queued one, a restart
    /// always goes last. Err when the command can't be sent to this device.
    pub fn plan_command(&self, id: &str, cmd: Command) -> Result<Vec<Command>, String> {
        let d = self.devices.get(id).filter(|d| d.source == Source::Physical)
            .ok_or_else(|| format!("{id} is not a real node"))?;
        let mut queue: Vec<Command> = d.pending.clone();
        match cmd {
            Command::Interval(_) => {
                queue.retain(|c| !matches!(c, Command::Interval(_)));
                let at = queue.iter().position(|c| *c == Command::Reboot).unwrap_or(queue.len());
                queue.insert(at, cmd);
            }
            Command::Reboot => {
                if let Some(fw) = d.firmware.filter(|fw| *fw < REBOOT_FIRMWARE) {
                    return Err(format!("firmware {}.{} can't restart remotely, flash v0.8 or later", fw.0, fw.1));
                }
                if queue.contains(&Command::Reboot) {
                    return Err("a restart is already queued".into());
                }
                queue.push(cmd);
            }
        }
        Ok(queue)
    }

    /// Records the queue that was handed to TTN (it replaced the previous one there).
    pub fn commit_queue(&mut self, id: &str, queue: Vec<Command>) {
        let now = iso(Utc::now());
        let mut result = self.db.execute(
            "UPDATE downlinks SET state = 'replaced' WHERE dev_id = ?1 AND state = 'pending'",
            params![id],
        ).map(|_| ());
        for cmd in &queue {
            if result.is_err() { break; }
            let bytes = cmd.downlink().encode().unwrap_or_default();
            result = self.db.execute(
                "INSERT INTO downlinks (dev_id, created_at, port, bytes, kind, value, state)
                 VALUES (?1, ?2, 1, ?3, ?4, ?5, 'pending')",
                params![id, now, bytes, cmd.kind(), cmd.value()],
            ).map(|_| ());
        }
        if let Err(e) = result {
            eprintln!("{} [db] could not store downlinks for {id}: {e}", crate::source::hms());
        }
        println!("{} [downlink] {id}: queued at TTN {:?}, one is delivered after each uplink", crate::source::hms(), queue);
        if let Some(d) = self.devices.get_mut(id) {
            d.pending = queue;
        }
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
                position_source: d.position_source,
                position_accuracy_m: d.position_accuracy_m,
                interval_min: (d.source == Source::Physical).then_some(d.interval_min),
                pending_interval_min: d.pending.iter().rev().find_map(|c| match c { Command::Interval(m) => Some(*m as u32), _ => None }),
                pending_reboot: d.pending.contains(&Command::Reboot),
                reboot_supported: (d.source == Source::Physical).then_some(d.firmware.map(|fw| fw >= REBOOT_FIRMWARE)).flatten(),
                powered_up_at: d.powered_up_at.map(iso),
                firmware: d.firmware.map(|(major, minor)| format!("{major}.{minor}")),
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
