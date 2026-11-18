# SoundScape — Roskilde Sensor Node Project Overview

DTU 34365 IoT Prototyping · Last updated 2026-11-12

Battery-powered sensor nodes at the Roskilde Festival campsite measure sound level, crowd density (Wi-Fi), temperature and humidity. They send the data over LoRaWAN (The Things Network, EU868) to our server, and a web/mobile app shows a noise and crowd map for visitors with hearing impairments or sensory sensitivities. We build 5 nodes.

This file is the big picture. Details live in:

| Document | What it holds |
|---|---|
| `Roskilde-Node-Message-Protocol.md` | Every byte of every uplink and downlink |
| `Roskilde-Node-Hardware-Map.pdf` | Block diagram, flowcharts, full schematic, pinouts, bench checks |
| `Roskilde-Node-Plan-and-Playbook.md` | Week plan, build steps with progress, how-tos (flashing, TTN, current, calibration, installation), troubleshooting, risks |

Course requirements and where we meet them:

| Requirement | How |
|---|---|
| Arduino Pro Mini | ATmega328P 3.3 V / 8 MHz runs the node |
| LoRaWAN | RN2483A modem, OTAA join, TTN EU868 |
| Analog sensor | MAX4466 microphone amplifier |
| Digital sensor | DHT22 temperature/humidity |
| Low-power design | Sensors and ESP-01 switched off between cycles, sleep modes, sleep-mode downlink |
| Geolocation | Wi-Fi access-point scan → Google Geolocation API on the server |
| Downlink / actuation | Commands 0x01–0x05; 0x03 blinks the on-board LED |

---

## 1. System architecture

```
 ┌──────────────── Sensor node (×5) ────────────────┐
 │                                                   │
 │  MAX4466 mic ──A0──┐                              │
 │  DHT22 ────────D6──┤                              │
 │                    ▼                              │
 │  ESP-01 ◀─D3/D4─▶ Pro Mini ◀─D10/D11─▶ RN2483A ───┼──LoRa 868 MHz──┐
 │  (Wi-Fi scan)   (measure, pack,   (LoRaWAN modem) │                │
 │     ▲            sleep, decide)                   │                │
 │     └─ power switch (A3) ◀─┘                      │                │
 │  3×AA 4.5 V ──▶ RAW / LDO 3.3 V                   │                │
 └───────────────────────────────────────────────────┘                │
                                                                      ▼
                                                            LoRaWAN gateway(s)
                                                                      │ internet
                                                                      ▼
                                                       The Things Network (TTN)
                                                       checks, decrypts, de-duplicates
                                                                      │ webhook (HTTPS, JSON)
                                                                      ▼
                         ┌──────────────────── Server (Python) ───────────────────┐
                         │  /ttn/uplink  → decode by port → database (SQLite)      │
                         │  port 2       → Google Geolocation API → position rules │
                         │  send_downlink.py → TTN API → queued downlink           │
                         │  read API (/nodes, /readings) for the app               │
                         └────────────────────────────────────────────────────────┘
                                                                      │
                                                                      ▼
                                                     Web / mobile app: noise + crowd map
```

**Responsibilities**

| Part | Does | Does not |
|---|---|---|
| Node | Measures, scans Wi-Fi, packs bytes, sleeps, obeys downlinks | Know time or position; store data |
| Gateway | Receives radio, forwards to TTN | Read the content (it is encrypted) |
| TTN | Join, decryption, de-duplication, downlink queue, webhook | Store data long-term, geolocate, show a map |
| Server | Decode, store, geolocate, apply rules, send commands, serve the app | Talk to nodes directly |
| App | Show map, levels, warnings | Talk to TTN |

---

## 2. Hardware

### 2.1 Parts per node

| Part | Role |
|---|---|
| Arduino Pro Mini 3.3 V / 8 MHz (ATmega328P) | Main controller |
| Microchip RN2483A | LoRaWAN modem (full stack on the module) + 868 MHz antenna on RFH (λ/4 wire = 8.6 cm) |
| ESP-01 on breadboard adapter (own 3.3 V regulator) | Wi-Fi scanning and geolocation scan |
| MAX4466 electret mic amplifier | Sound level (analog) |
| DHT22 | Temperature and humidity (digital) |
| IRF4905 P-MOSFET + 2N2222A NPN | High-side switch that cuts ESP-01 power |
| 3×AA USB-C rechargeable 1.5 V Li-ion, holder with switch, DC jack | 4.5 V supply |
| 100 µF at RAW, 100 nF at each module | Decoupling |
| Suggested: 220–470 µF at ESP input, 100 kΩ base-to-GND on 2N2222A | Supply dips; ESP stays off during reset |

### 2.2 Power tree

```
3×AA 4.5 V ─┬─ 100 µF
            ├─ Pro Mini RAW ── on-board LDO ── 3.3 V ──┬─ ATmega328P
            │                                          └─ RN2483A VDD
            └─ IRF4905 (switched by A3) ── ESP adapter LDO ── ESP-01

Pro Mini pins as power switches:  D7 → MAX4466 VCC    D5 → DHT22 VCC
```

- The ESP-01 (up to ~300 mA) never loads the Pro Mini regulator.
- Before cutting power, D3, D4 and D6 are set to plain input so no module is powered through a data pin.
- During development: programmer on GND/TX/RX/DTR only, **its VCC disconnected**, battery on.

### 2.3 Pin map (Pro Mini)

| Pin | Connects to | Note |
|---|---|---|
| RAW | BAT+ 4.5 V | 100 µF to GND |
| VCC | RN2483A VDD | 3.3 V out of the LDO |
| GND | Common ground | |
| TXO / RXI (D1/D0) | Programmer | Upload + serial monitor (9600 baud) |
| D3 | ESP-01 TX | SoftwareSerial RX, 9600 baud |
| D4 | ESP-01 RX | SoftwareSerial TX |
| A3 | 10 kΩ → 2N2222A base | HIGH = ESP-01 on |
| D5 | DHT22 VCC (pin 1) | + 10 kΩ pull-up to DATA |
| D6 | DHT22 DATA (pin 2) | |
| D7 | MAX4466 VCC | |
| A0 | MAX4466 OUT | Rests at ~512 counts (½ VCC) |
| D9 | RN2483A RESET | Active low |
| D10 | RN2483A UART_TX | SoftwareSerial RX, 9600 baud (autobaud) |
| D11 | RN2483A UART_RX | SoftwareSerial TX |
| D13 | On-board LED | Downlink blink |
| Free | D2, D8, D12, A1, A2, A4, A5 | |

Transistor pinouts (front view, text facing you, legs down): **IRF4905: G D S** (tab = D) · **2N2222A: E B C**.

---

## 3. Firmware behaviour (Pro Mini)

**Power-up (once)**
1. Safe pin states (ESP off, sensors off), load interval/scan time from EEPROM.
2. Reset RN2483A, autobaud to 9600, OTAA join (retry every 30 s).
3. ESP-01 on → Wi-Fi scan → keep 5 strongest APs → ESP-01 off.
4. Send port 2 (geolocation).

**Measurement cycle (default 5 min; demo 1 min)**
1. Mic + DHT22 on, wait 2 s to settle.
2. 10 s window: sample A0 continuously (~7,000 samples/s), DC removed, Leq + peak; DHT22 read every 2 s.
3. Sensors off. ESP-01 on → scan → ESP-01 off.
4. Pack 8 bytes, send port 1, handle any downlink.
5. RN2483A to sleep, Pro Mini sleeps for the rest of the interval.

**Sleep mode (downlink 0x04)**
- No measurements and no Wi-Fi scans.
- Every check-in period (default 30 min) the node sends a 2-byte port 3 message so the server can reach it.
- Ends when the sleep time runs out, when 0x05 arrives, or when the node is switched off and on.

**Phone counting (planned)**
The demo uses the ESP-01's stock AT firmware, which cannot see phones, so the crowd field is the number of Wi-Fi networks seen (flag bit 0). The custom ESP firmware will sniff probe requests on channels 1–13, hash each phone address with a new random salt per scan (4-byte hashes in RAM, up to 4,096), ignore addresses that send beacons (routers), count only signals above about −80 dBm, and return only the count.

---

## 4. Messages (summary)

Full byte tables: `Roskilde-Node-Message-Protocol.md`.

| Direction | Port | Size | When | Content |
|---|---|---|---|---|
| Up | 1 | 8 B | Every interval | Sound avg/peak, crowd count, temperature, humidity, flags |
| Up | 2 | ≤ 36 B | Power-up | Up to 5 × (BSSID + RSSI) for geolocation |
| Up | 3 | 2 B | Sleep mode, every check-in | Minutes of sleep left |
| Down | 1 | 1–4 B | After any uplink | 0x01 interval · 0x02 scan time · 0x03 blink · 0x04 sleep · 0x05 wake |

---

## 5. Information flow, end to end

Example: one measurement from node `1-soundscape-device`.

| Step | Where | What happens | Data looks like |
|---|---|---|---|
| 1 | Sensors → Pro Mini | 10 s of samples → values | 62.0 dB, 87.0 dB, 26, 21.6 °C, 41 % |
| 2 | Pro Mini | Scale and pack | `7C AE 00 1A 00 D8 29 01` |
| 3 | Pro Mini → RN2483A | Serial text command | `mac tx uncnf 1 7CAE001A00D82901` |
| 4 | RN2483A | Add address + counter, encrypt, sign, transmit (SF7 ≈ 60 ms) | LoRaWAN frame |
| 5 | Gateway | Receive, add RSSI/SNR/time, forward | encrypted frame + metadata |
| 6 | TTN | Check signature, de-duplicate, decrypt | 8 bytes again |
| 7 | TTN → server | Webhook POST with secret header | JSON, `frm_payload: "fK4AGgDYKQE="` |
| 8 | Server | base64 → bytes → decode by port → store raw + decoded | DB row |
| 9 | Server → app | Read API | latest values per node on the map |

Geolocation (port 2) follows the same path; at step 8 the server also calls Google Geolocation (`considerIp: false`) and applies the position rules:
- fewer than 3 APs or no result → keep previous position, "might have moved";
- more than 100 m from previous → new position, "might have moved";
- first previous position = phone GPS recorded at installation (editable on the server).

Downlinks go the other way: server → TTN API → queued → delivered after the node's next uplink (Class A).

---

## 6. Server (planned)

```
server/
  app.py              FastAPI: POST /ttn/uplink (webhook), GET /nodes, GET /readings
  decoder.py          decode_port1/2/3, unit tests with real payloads
  geolocate.py        Google call + position rules
  db.py               SQLite: nodes, readings, ap_scans, positions (raw bytes always stored)
  send_downlink.py    queue commands via TTN API (done)
  .env                TTN_API_KEY, TTN_APP_ID, TTN_WEBHOOK_ID, GOOGLE_API_KEY, WEBHOOK_SECRET
```

- Webhook protected by a secret header; replies 200 at once.
- Duplicates skipped on (device, frame counter, received time).
- Development: laptop + tunnel (Cloudflare Tunnel / ngrok). Test and poster: always-on host (not a free tier that sleeps).
- Google API key: restricted to Geolocation API, with a daily quota and a budget alert.

---

## 7. Low power

Rough budget at default settings (to be replaced with measurements):

| Phase | Duration | Current |
|---|---|---|
| Sleep | ≈ 270 s | ≈ 0.01–0.1 mA |
| Measure | 12 s | ≈ 4–6 mA |
| ESP-01 scan | ≈ 16 s | ≈ 70–90 mA |
| LoRa TX + RX | ≈ 1–3 s | TX ≈ 40 mA, RX ≈ 14 mA |

≈ 4.5 mA average; about 90 % goes to the Wi-Fi scan, so scan time (0x02) and interval (0x01) are the main battery levers. Sleep mode cuts the node to a 2-byte check-in every 30 min. To do: remove the Pro Mini power LED, enable `USE_DEEP_SLEEP`, measure each phase with a multimeter in the battery lead.

---

## 8. Privacy

- Phone MAC addresses are hashed with a random salt that changes every scan, kept only in the ESP-01's RAM, and never stored or sent. Only a count leaves the node.
- Router BSSIDs (infrastructure, not personal devices) are sent at power-up for geolocation only.
- The crowd count is a relative index, not a headcount (phones randomise their addresses).

---

## 9. Status (2026-11-12)

| Item | Status |
|---|---|
| Power, Pro Mini, battery | ✅ Working |
| MAX4466 + DHT22 (test sketch) | ✅ Working (DC ≈ 512, 22 °C / 51 %) |
| RN2483A OTAA join on TTN | ✅ Joined, RSSI −53 dBm at `ttig-pro-1` |
| Port 1 uplink | ✅ Received (`7C AE 00 1A 00 D8 29 01`) |
| ESP-01 power switch + Wi-Fi scan | ✅ Working on battery |
| Port 2 uplink | ✅ Received, 5 APs |
| TTN payload formatter | ⬜ Paste latest `payload_formatter.js` |
| Downlink blink (0x03) | ⬜ To test |
| Sleep / wake (0x04 / 0x05) | ⬜ To test |
| Server (webhook, decoder, DB, Google) | ⬜ To build |
| ESP sniffer firmware (phone count) | ⬜ To build |
| dB calibration | ⬜ Needs reference sound level meter |
| Current measurements | ⬜ To do |
| Nodes 2–5 | ⬜ After node 1 is complete |
| App / map | ⬜ To build |

---

## 10. Next steps

1. Test downlinks (blink, interval, sleep/wake) with `send_downlink.py`.
2. Build the server: decoder with tests → webhook → SQLite → Google lookup.
3. Firmware: keep only one BSSID per physical access point (same first 5 bytes) in the port 2 scan.
4. ESP-01 sniffer firmware for phone counting.
5. Calibrate dB against a reference meter; fix the mic gain.
6. Measure current per phase; enable deep sleep.
7. Build and register nodes 2–5.
8. App with map; poster 3 December; report 10 December.

---

## 11. Decisions log

| Decision | Reason |
|---|---|
| RN2483A instead of RFM95 + LMIC | Full LoRaWAN stack on the module frees Pro Mini flash/RAM; D13 no longer shared with SPI |
| RN2483A on SoftwareSerial D10/D11 at 9600 | Keeps the hardware serial port free for uploads and debug output |
| ESP-01 behind a MOSFET switch | It draws the most power; fully off between scans |
| Random salt per scan, generated on the ESP | Hashes can't be linked between scans; no salt downlink needed |
| Router list as 2-byte hashes in RAM, two 1-hour lists | No clock on the node; EEPROM ages would be meaningless after a reset |
| Crowd count 2 bytes, 4-byte phone hashes, cap 4,096 | Room for busy campsites; negligible hash clashes |
| Google Geolocation from the server | API key stays on the server; MLS is shut down; Semtech LoRa Cloud geolocation discontinued |
| Port number = message type | No type byte needed; layout changes get a new port |
| Sleep mode with check-ins | Class A nodes can only be reached right after they transmit |
