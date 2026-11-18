// Fake nodes. They send real encoded port 1 bytes, so they go through the same decoder and store
// as the real nodes. Acceptance (Team 2 doc): 20 devices, every ~5 s.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::Utc;
use tokio::sync::mpsc::Sender;

use crate::source::{RawUplink, Source};
use crate::uplink::encode_measurement;

struct Rng(u64);
impl Rng {
    fn seeded() -> Self {
        let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
        Rng(t | 1)
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    /// Uniform in [0, 1).
    fn unit(&mut self) -> f32 { (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32 }
    /// Uniform in [-1, 1).
    fn signed(&mut self) -> f32 { self.unit() * 2.0 - 1.0 }
}

struct Sim {
    base_db: f32,
    noise: f32,
    crowd: f32,
    temp: f32,
    humidity: f32,
    batt_mv: f32,
}

impl Sim {
    fn new(rng: &mut Rng) -> Self {
        let base_db = 55.0 + rng.unit() * 30.0;
        Sim {
            base_db,
            noise: base_db,
            crowd: 20.0 + rng.unit() * 300.0,
            temp: 12.0 + rng.unit() * 8.0,
            humidity: 50.0 + rng.unit() * 35.0,
            batt_mv: 4300.0 + rng.unit() * 500.0,
        }
    }

    fn step(&mut self, rng: &mut Rng) -> Vec<u8> {
        self.noise = (self.noise + rng.signed() * 3.0).clamp(self.base_db - 12.0, self.base_db + 12.0);
        self.crowd = (self.crowd + rng.signed() * 15.0).clamp(0.0, 800.0);
        self.temp = (self.temp + rng.signed() * 0.2).clamp(-5.0, 35.0);
        self.humidity = (self.humidity + rng.signed() * 1.0).clamp(20.0, 100.0);
        self.batt_mv = (self.batt_mv - rng.unit()).max(3500.0);
        let peak = self.noise + 6.0 + rng.unit() * 12.0;
        encode_measurement(self.noise, peak, self.crowd as u16, self.temp, self.humidity as u8, self.batt_mv as u16)
    }
}

pub fn sim_id(i: usize) -> String { format!("sim-{:02}", i + 1) }

pub async fn run(tx: Sender<RawUplink>, count: usize, every: Duration) {
    let mut rng = Rng::seeded();
    let mut sims: Vec<Sim> = (0..count).map(|_| Sim::new(&mut rng)).collect();
    let mut tick = tokio::time::interval(every);
    let mut f_cnt = 0u32;
    println!("[sim] {count} simulated devices, one uplink each every {} s", every.as_secs());
    loop {
        tick.tick().await;
        f_cnt = f_cnt.wrapping_add(1);
        for (i, sim) in sims.iter_mut().enumerate() {
            let up = RawUplink {
                dev_id: sim_id(i),
                port: 1,
                f_cnt,
                received_at: Utc::now(),
                payload: sim.step(&mut rng),
                rssi: Some(-80 - (i as i16 % 30)),
                snr: Some(7.5),
                source: Source::Simulated,
            };
            if tx.send(up).await.is_err() {
                return;
            }
        }
    }
}
