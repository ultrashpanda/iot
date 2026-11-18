# SoundScape backend: uplink → API

Source of truth for bytes: Team 1's `Roskilde-Node-Message-Protocol.md`. Reference decoder: `uplink.rs` (std only, 8 tests pass).

## Model

```
UplinkSource ──RawUplink──▶ decode(port, bytes) ──Uplink──▶ Store ──▶ GET /api/devices
 (TtnMqtt | Simulator)                                        │
                                       DownlinkSink ◀── Downlink::encode()
```

```rust
trait UplinkSource { async fn next(&mut self) -> RawUplink; }      // TtnMqtt, Simulator
trait DownlinkSink { async fn send(&self, dev: &str, d: Downlink) -> Result<()>; }

struct RawUplink { dev_id: String, port: u8, f_cnt: u32, received_at: DateTime<Utc>,
                   payload: Vec<u8>, rssi: Option<i16>, snr: Option<f32> }

enum Uplink { Measurement(Measurement), Geolocation(Vec<Ap>), SleepCheckIn { minutes_left: Option<u16> } }
fn decode(port: u8, b: &[u8]) -> Result<Uplink, DecodeError>;     // UnknownPort | BadLength
```

Simulator implements `UplinkSource` and emits real encoded bytes, so it runs the full pipeline. Acceptance: 20 devices, every ~5 s.

## Invariants

* Big-endian. Port = type. Unknown port → store raw, log, don't guess.
* TTN already decrypted. No crypto on our side.
* Always persist `payload` raw next to the decoded values, so rows can be re-decoded.
* Dedupe on `(dev_id, f_cnt, received_at)`. `f_cnt` resets on rejoin.
* Flag wins over the sentinel. A sentinel without its flag still → `None`.

## Wire formats

**Port 1, 8 B:** `>BBHhBB` = avg, peak, crowd, temp, hum, flags

| Field | Decode | Sentinel → None |
|---|---|---|
| noise_avg / noise_peak | `u8 / 2.0` dB | none |
| crowd | `u16` | `0xFFFF` or flag 3 |
| temperature | `i16 / 10.0` °C | `0x7FFF` or flag 1 |
| humidity | `u8` % | `0xFF` or flag 1 |

Flags: `0` crowd is networks (else phones) · `1` DHT failed · `2` mic clipped (values kept) · `3` Wi-Fi failed · `4` hash list full · `5..7` reserved

**Port 2, 1 + 7n B (n ≤ 5):** `n`, then `n × ([u8;6] bssid, u8 rssi + 128)`. Side effect: **power-up event**.

**Port 3, 2 B:** `u16` minutes left, `0` = until woken.

**Downlink, port 1:**

```rust
enum Downlink { Interval { minutes: u8 },     // 01 mm      1..=240
                ScanTime { seconds: u8 },     // 02 ss      5..=60
                Blink,                        // 03
                Sleep { minutes: Option<u16>, checkin_min: Option<u8> }, // 04 hh ll [cc], cc 5..=255
                Wake }                        // 05
impl Downlink { fn encode(&self) -> Result<Vec<u8>, OutOfRange>; }
```

Class A: queued at TTN until the node's next uplink. `state: Pending → Sent` on the next uplink from that device.

## Test vectors

| Port | Base64 | Expect |
|---|---|---|
| 1 | `fK4AGgDYKQE=` | 62.0, 87.0, 26 networks, 21.6, 41 |
| 1 | `YIUADP/YWAE=` | 48.0, 66.5, 12, −4.0, 88 |
| 1 | `8P8AKACZPAU=` | 120.0, 127.5 clipped, 40, 15.3, 60 |
| 1 | `b4z//3///ws=` | 55.5, 70.0, None, None, None |
| 2 | `AwAqEKGyw0P08m0RIjM6PDeGqrvMMg==` | 3 APs, −61 / −70 / −78 dBm |
| 3 | `APA=` | Some(240) |
| ↓1 | `AQU=` · `BAHgPA==` | Interval 5 · Sleep 480 checkin 60 |

## TTN transport (MQTT, both directions)

| | |
|---|---|
| Broker | `eu1.cloud.thethings.network:8883`, TLS |
| Auth | user `soundscape@ttn`, pass = API key (read uplink + write downlink) |
| Up | sub `v3/soundscape@ttn/devices/+/up` |
| Down | pub `v3/soundscape@ttn/devices/{dev}/down/push` |

Uplink JSON → `RawUplink`:

```
end_device_ids.device_id      → dev_id
received_at                   → received_at
uplink_message.f_port         → port
uplink_message.f_cnt          → f_cnt
uplink_message.frm_payload    → base64 → payload
uplink_message.rx_metadata[]  → max rssi, its snr
uplink_message.decoded_payload → ignore
```

Downlink body: `{"downlinks":[{"f_port":1,"frm_payload":"<base64>","priority":"NORMAL"}]}`

## State rules (pure functions of stored state + `now`)

```rust
enum Status { Online, Sleeping, Offline }
fn status(d: &Device, now: DateTime<Utc>) -> Status;
//  last port ∈ {1,2} && age ≤ 3 × interval_min (default 5)  → Online
//  last port == 3    && age ≤ 2 × checkin_min  (default 30) → Sleeping
//  else                                                      → Offline

fn battery_pct(powered_up_at, now, avg_ma: Option<f32>, capacity_mah: Option<f32>) -> Option<u8>;
//  100 × (1 − hours × avg_ma / capacity_mah), clamped. None until Team 1 measures current.

fn position(prev: Pos, fix: Option<Pos>, n_aps: usize) -> (Pos, might_have_moved: bool);
//  n_aps < 3 || fix.is_none() → (prev, true)
//  dist(prev, fix) > 100 m    → (fix, true)
//  else                       → (fix, false)
//  first prev = installation GPS (manual, editable)
```

`interval_min` / `checkin_min` per device are updated when we send `Interval` / `Sleep`. Geolocation: Google Geolocation API, `considerIp: false`, key server-side only.

## Store

| Table | Columns |
|---|---|
| devices | dev_id PK, name, lat, lon, source, might_have_moved, powered_up_at, interval_min, checkin_min, last_seen, last_port |
| measurements | dev_id, received_at, f_cnt, raw, noise_avg, noise_peak, noise_clipped, crowd_count, crowd_source, temperature, humidity, flags, rssi, snr |
| ap_scans | dev_id, received_at, raw, aps_json, lat, lon, accuracy_m |
| downlinks | id, dev_id, bytes, created_at, state |

Times: ISO 8601 UTC. SQLite on a mounted volume.

## API (Team 3 contract, see their guide for the full example)

`GET /api/devices` → `{ generated_at, devices: [Device] }`, polled every 5 s, same origin (we serve their static files, no CORS).

```
id                     String
name                   String
latitude, longitude    f64
might_have_moved       bool
noise_avg, noise_peak  Option<f32>
noise_clipped          bool
crowd_count            Option<u16>
crowd_source           "networks" | "phones"
temperature            Option<f32>
humidity               Option<u8>
battery_voltage        null (always, for now)
battery_estimate_pct   Option<u8>
status                 "online" | "offline" | "sleeping"
source                 "physical" | "simulated"
last_updated           Option<String>   // ISO 8601 UTC
```

Every key always present; `None` → `null`. Enums `snake_case`.

## Suggested crates

`tokio`, `rumqttc` (TLS), `serde` / `serde_json`, `base64`, `rusqlite`, `axum`, `chrono`, `tower-http` (static files).

## Config (`.env`, not in git)

`TTN_APP_ID`, `TTN_MQTT_HOST`, `TTN_API_KEY`, `GOOGLE_API_KEY`

## Open

* Team 1: sentinels + MQTT into their protocol file; current per phase (blocks `battery_pct`).
* Team 3: OK on `might_have_moved`, `noise_clipped`, `crowd_*`, `battery_estimate_pct`, `sleeping`.
