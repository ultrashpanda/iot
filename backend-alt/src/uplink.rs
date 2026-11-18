// uplink.rs — std only. Port = message type.
#![allow(dead_code)] // downlinks and some flags are not used by the backend yet
//
// Based on Team 2's reference decoder. Extended for firmware v0.3+ (see mcu/Roskilde_Node/protocol.h):
//   port 1: 8 bytes (old) or 11 bytes (+ battery %, rest voltage, voltage under ESP load)
//   port 3: 2 bytes (old) or 3 bytes (+ battery %)
//   port 4: boot info, 5 bytes
//   flags 0x20 battery low under Wi-Fi load, 0x40 mic fault (noise values invalid)

#[derive(Debug, PartialEq)]
pub enum Uplink {
    Measurement(Measurement), // port 1
    Geolocation(Vec<Ap>),     // port 2, also = "just powered up"
    SleepCheckIn { minutes_left: Option<u16>, battery_pct: Option<u8> }, // port 3, None = until woken
    Boot(Boot),               // port 4, sent once after port 2 on every boot
}

#[derive(Debug, PartialEq, Clone)]
pub struct Measurement {
    pub noise_avg: f32,
    pub noise_peak: f32,
    pub noise_clipped: bool,
    pub crowd: Option<Crowd>,
    pub temperature: Option<f32>, // °C
    pub humidity: Option<u8>,     // %
    pub flags: Flags,
    pub battery: Option<Battery>, // 11 byte format only
}

impl Measurement {
    /// False when the node flagged a mic fault: the noise values must not be shown.
    pub fn noise_valid(&self) -> bool { !self.flags.has(Flags::MIC_FAULT) }
}

#[derive(Debug, PartialEq, Clone)]
pub struct Crowd { pub count: u16, pub source: CrowdSource }

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum CrowdSource { Networks, Phones }

#[derive(Debug, PartialEq, Clone, Copy)]
pub struct Battery {
    pub pct: u8,
    pub rest_v: f32, // before the ESP-01 switches on
    pub load_v: f32, // lowest while the ESP-01 runs
}

#[derive(Debug, PartialEq, Clone)]
pub struct Ap { pub bssid: [u8; 6], pub rssi_dbm: i16 }

#[derive(Debug, PartialEq, Clone, Copy)]
pub struct Boot { pub fw_major: u8, pub fw_minor: u8, pub reset_cause: u8, pub boot_count: u16 }

#[derive(Debug, PartialEq, Clone, Copy)]
pub struct Flags(pub u8);
impl Flags {
    pub const CROWD_IS_NETWORKS: u8 = 1 << 0;
    pub const DHT_FAILED: u8 = 1 << 1;
    pub const MIC_CLIPPED: u8 = 1 << 2;
    pub const WIFI_FAILED: u8 = 1 << 3;
    pub const HASH_LIST_FULL: u8 = 1 << 4;
    pub const BATT_LOW_WIFI: u8 = 1 << 5;
    pub const MIC_FAULT: u8 = 1 << 6;
    pub const RESERVED: u8 = 0b1000_0000;
    pub fn has(self, bit: u8) -> bool { self.0 & bit != 0 }
}

#[derive(Debug, PartialEq)]
pub enum DecodeError {
    UnknownPort(u8),
    BadLength { port: u8, expected: usize, got: usize },
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::UnknownPort(p) => write!(f, "unknown port {p}"),
            DecodeError::BadLength { port, expected, got } => write!(f, "port {port}: expected {expected} bytes, got {got}"),
        }
    }
}

pub fn decode(port: u8, b: &[u8]) -> Result<Uplink, DecodeError> {
    match port {
        1 => port1(b).map(Uplink::Measurement),
        2 => port2(b).map(Uplink::Geolocation),
        3 => port3(b),
        4 => port4(b).map(Uplink::Boot),
        p => Err(DecodeError::UnknownPort(p)),
    }
}

fn len(port: u8, b: &[u8], expected: &[usize]) -> Result<(), DecodeError> {
    if expected.contains(&b.len()) { Ok(()) } else {
        Err(DecodeError::BadLength { port, expected: *expected.last().unwrap(), got: b.len() })
    }
}

/// Millivolt byte from the node: (mV - 2000) / 20, so 2.00 to 7.10 V.
fn byte_to_volts(b: u8) -> f32 { (2000.0 + b as f32 * 20.0) / 1000.0 }

fn port1(b: &[u8]) -> Result<Measurement, DecodeError> {
    len(1, b, &[8, 11])?;
    let crowd = u16::from_be_bytes([b[2], b[3]]);
    let temp = i16::from_be_bytes([b[4], b[5]]);
    let f = Flags(b[7]);
    let dht_ok = !f.has(Flags::DHT_FAILED) && temp != i16::MAX;
    let wifi_ok = !f.has(Flags::WIFI_FAILED) && crowd != u16::MAX;
    Ok(Measurement {
        noise_avg: b[0] as f32 / 2.0,
        noise_peak: b[1] as f32 / 2.0,
        noise_clipped: f.has(Flags::MIC_CLIPPED),
        crowd: wifi_ok.then(|| Crowd {
            count: crowd,
            source: if f.has(Flags::CROWD_IS_NETWORKS) { CrowdSource::Networks } else { CrowdSource::Phones },
        }),
        temperature: dht_ok.then(|| temp as f32 / 10.0),
        humidity: (dht_ok && b[6] != u8::MAX).then_some(b[6]),
        flags: f,
        battery: (b.len() == 11).then(|| Battery {
            pct: b[8].min(100),
            rest_v: byte_to_volts(b[9]),
            load_v: byte_to_volts(b[10]),
        }),
    })
}

fn port2(b: &[u8]) -> Result<Vec<Ap>, DecodeError> {
    let n = *b.first().ok_or(DecodeError::BadLength { port: 2, expected: 1, got: 0 })? as usize;
    len(2, b, &[1 + 7 * n])?;
    Ok(b[1..].chunks_exact(7).map(|c| Ap {
        bssid: c[..6].try_into().unwrap(),
        rssi_dbm: c[6] as i16 - 128,
    }).collect())
}

fn port3(b: &[u8]) -> Result<Uplink, DecodeError> {
    len(3, b, &[2, 3])?;
    let m = u16::from_be_bytes([b[0], b[1]]);
    Ok(Uplink::SleepCheckIn { minutes_left: (m != 0).then_some(m), battery_pct: b.get(2).map(|p| (*p).min(100)) })
}

fn port4(b: &[u8]) -> Result<Boot, DecodeError> {
    len(4, b, &[5])?;
    Ok(Boot { fw_major: b[0], fw_minor: b[1], reset_cause: b[2] & 0x0F, boot_count: u16::from_be_bytes([b[3], b[4]]) })
}

// ---- encoding, used by the simulator so it sends real bytes ----

/// Builds an 11 byte port 1 payload the same way the firmware's packMeasurement() does.
pub fn encode_measurement(avg_db: f32, peak_db: f32, crowd_phones: u16, temp_c: f32, humidity: u8, batt_mv: u16) -> Vec<u8> {
    let db = |v: f32| (v * 2.0).round().clamp(0.0, 255.0) as u8;
    let mv = |v: u16| ((v.saturating_sub(2000) + 10) / 20).min(255) as u8;
    let t = ((temp_c.clamp(-40.0, 80.0) * 10.0).round() as i16).to_be_bytes();
    let c = crowd_phones.min(65534).to_be_bytes();
    let pct = (batt_mv.saturating_sub(3000) as u32 * 100 / 1800).min(100) as u8;
    vec![db(avg_db), db(peak_db), c[0], c[1], t[0], t[1], humidity.min(100), 0, pct, mv(batt_mv), mv(batt_mv.saturating_sub(150))]
}

// ---- downlinks (all port 1) ----

#[derive(Debug)]
pub enum Downlink {
    Interval { minutes: u8 },                          // 1..=240
    ScanTime { seconds: u8 },                          // 5..=60
    Blink,
    Sleep { minutes: Option<u16>, checkin_min: Option<u8> }, // None = until woken; checkin 5..=255
    Wake,
    Reboot,                                            // firmware v0.8+
}

#[derive(Debug, PartialEq)]
pub struct OutOfRange;

impl Downlink {
    pub const PORT: u8 = 1;
    pub fn encode(&self) -> Result<Vec<u8>, OutOfRange> {
        use Downlink::*;
        Ok(match *self {
            Interval { minutes: m @ 1..=240 } => vec![0x01, m],
            ScanTime { seconds: s @ 5..=60 } => vec![0x02, s],
            Blink => vec![0x03],
            Sleep { minutes, checkin_min: None } => sleep(minutes),
            Sleep { minutes, checkin_min: Some(c @ 5..=255) } => { let mut v = sleep(minutes); v.push(c); v }
            Wake => vec![0x05],
            Reboot => vec![0x06],
            _ => return Err(OutOfRange),
        })
    }
}
fn sleep(m: Option<u16>) -> Vec<u8> {
    let [h, l] = m.unwrap_or(0).to_be_bytes();
    vec![0x04, h, l]
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hex(s: &str) -> Vec<u8> { s.split(' ').map(|x| u8::from_str_radix(x, 16).unwrap()).collect() }
    fn m(s: &str) -> Measurement { match decode(1, &hex(s)).unwrap() { Uplink::Measurement(m) => m, _ => panic!() } }

    // ---- Team 2's original tests (8 byte format) ----
    #[test] fn normal() {
        let x = m("7C AE 00 1A 00 D8 29 01");
        assert_eq!((x.noise_avg, x.noise_peak, x.temperature, x.humidity), (62.0, 87.0, Some(21.6), Some(41)));
        assert_eq!(x.crowd, Some(Crowd { count: 26, source: CrowdSource::Networks }));
        assert_eq!(x.battery, None);
    }
    #[test] fn negative_temp() { assert_eq!(m("60 85 00 0C FF D8 58 01").temperature, Some(-4.0)); }
    #[test] fn clipped() { let x = m("F0 FF 00 28 00 99 3C 05"); assert!(x.noise_clipped); assert_eq!(x.noise_peak, 127.5); }
    #[test] fn failures() {
        let x = m("6F 8C FF FF 7F FF FF 0B");
        assert_eq!((x.crowd, x.temperature, x.humidity), (None, None, None));
    }
    #[test] fn geo() {
        let u = decode(2, &hex("03 00 2A 10 A1 B2 C3 43 F4 F2 6D 11 22 33 3A 3C 37 86 AA BB CC 32")).unwrap();
        match u { Uplink::Geolocation(a) => { assert_eq!(a.len(), 3); assert_eq!(a[0].rssi_dbm, -61); assert_eq!(a[2].rssi_dbm, -78); } _ => panic!() }
    }
    #[test] fn checkin() { assert_eq!(decode(3, &hex("00 F0")).unwrap(), Uplink::SleepCheckIn { minutes_left: Some(240), battery_pct: None }); }
    #[test] fn bad() {
        assert_eq!(decode(9, &[0]), Err(DecodeError::UnknownPort(9)));
        assert!(matches!(decode(1, &[0; 7]), Err(DecodeError::BadLength { .. })));
        assert!(matches!(decode(1, &[0; 9]), Err(DecodeError::BadLength { .. })));
        assert!(matches!(decode(2, &hex("02 00")), Err(DecodeError::BadLength { .. })));
    }
    #[test] fn downlinks() {
        assert_eq!(Downlink::Interval { minutes: 5 }.encode().unwrap(), hex("01 05"));
        assert_eq!(Downlink::Sleep { minutes: Some(480), checkin_min: Some(60) }.encode().unwrap(), hex("04 01 E0 3C"));
        assert_eq!(Downlink::Sleep { minutes: None, checkin_min: None }.encode().unwrap(), hex("04 00 00"));
        assert_eq!(Downlink::Interval { minutes: 0 }.encode(), Err(OutOfRange));
        assert_eq!(Downlink::ScanTime { seconds: 61 }.encode(), Err(OutOfRange));
        assert_eq!(Downlink::Sleep { minutes: None, checkin_min: Some(4) }.encode(), Err(OutOfRange));
        assert_eq!(Downlink::Reboot.encode().unwrap(), hex("06"));
    }

    // ---- firmware v0.3+ formats ----
    // Bytes produced by packMeasurement() in protocol.h: 62.0 / 87.0 dB, 26 phones, 21.6 °C, 41 %,
    // rest 4520 mV, load 4180 mV (< 4300 -> flag 0x20).
    #[test] fn eleven_bytes() {
        let x = m("7C AE 00 1A 00 D8 29 20 56 7E 6D");
        assert_eq!(x.crowd, Some(Crowd { count: 26, source: CrowdSource::Phones }));
        assert!(x.flags.has(Flags::BATT_LOW_WIFI));
        assert!(x.noise_valid());
        let b = x.battery.unwrap();
        assert_eq!(b.pct, 86);
        assert!((b.rest_v - 4.52).abs() < 0.001 && (b.load_v - 4.18).abs() < 0.001);
    }
    #[test] fn mic_fault() { assert!(!m("7C AE 00 1A 00 D8 29 40 56 7E 6D").noise_valid()); }
    #[test] fn checkin_with_battery() {
        assert_eq!(decode(3, &hex("00 00 4B")).unwrap(), Uplink::SleepCheckIn { minutes_left: None, battery_pct: Some(75) });
    }
    #[test] fn boot() {
        assert_eq!(decode(4, &hex("00 07 08 01 2C")).unwrap(),
                   Uplink::Boot(Boot { fw_major: 0, fw_minor: 7, reset_cause: 8, boot_count: 300 }));
    }
    #[test] fn simulator_bytes_decode() {
        let x = m(&encode_measurement(71.3, 88.0, 140, -2.5, 55, 4400).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" "));
        assert_eq!((x.noise_avg, x.noise_peak, x.temperature, x.humidity), (71.5, 88.0, Some(-2.5), Some(55)));
        assert_eq!(x.crowd, Some(Crowd { count: 140, source: CrowdSource::Phones }));
        assert!((x.battery.unwrap().rest_v - 4.4).abs() < 0.001);
    }
}
