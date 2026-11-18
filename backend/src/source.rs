// Where uplinks come from: TTN over MQTT (real nodes) or the simulator (fake nodes).
// Both produce the same RawUplink, so the simulator runs the full pipeline.

use chrono::{DateTime, Utc};

/// Local clock time for log lines.
pub fn hms() -> String { chrono::Local::now().format("%H:%M:%S").to_string() }

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Source { Physical, Simulated }

impl Source {
    pub fn as_str(self) -> &'static str {
        match self { Source::Physical => "physical", Source::Simulated => "simulated" }
    }
}

#[derive(Debug, Clone)]
pub struct RawUplink {
    pub dev_id: String,
    pub port: u8,
    pub f_cnt: u32,
    pub received_at: DateTime<Utc>,
    pub payload: Vec<u8>,
    pub rssi: Option<i16>,
    pub snr: Option<f32>,
    pub source: Source,
}
