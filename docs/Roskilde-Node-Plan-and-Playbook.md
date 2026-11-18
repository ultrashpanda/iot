# Roskilde Sensor Node — Project Plan and Playbook

DTU 34365 IoT Prototyping · Battery-powered LoRaWAN nodes measuring sound level, crowd density (Wi-Fi probe requests), temperature and humidity at the Roskilde Festival campsite, shown on a noise and crowd map for visitors with hearing impairments or sensory sensitivities.

This file is the plan and the working playbook. The big picture is in `Roskilde-Node-Project-Overview.md`, every byte of every message in `Roskilde-Node-Message-Protocol.md`, and the diagrams and schematic in `Roskilde-Node-Hardware-Map.pdf`.

Updated 2026-11-12: the radio is now the **RN2483A** LoRaWAN modem (replacing RFM95 + LMIC), and the demo firmware uses the ESP-01's stock AT firmware until the phone-sniffer firmware exists.

---

## 1. Deadlines

| Date | Milestone |
|---|---|
| Fri 20 Nov | One working node sending data to the server |
| Sun 29 Nov | 5 nodes built and sending, app showing the map |
| Thu 3 Dec | Poster presentation |
| Thu 10 Dec | Report hand-in |

---

## 2. Plan by week

### Week 46 · 6–15 Nov — parts working on their own
- Set up the toolchain and repository (Step 0)
- Bench-check power and the ESP switch (Step 1)
- Mic, DHT22 and RN2483A each working alone (Steps 2–4) ✅
- Demo firmware: TTN join, port 1 and port 2 received ✅
- ESP-01 sniffer firmware, LOCATE and SCAN tested over USB (Steps 5–6)

### Week 47 · 16–22 Nov — one complete node
- Pro Mini ↔ ESP link, router list, geolocation chain (Steps 7–9)
- Full cycle with sleep, current measured, downlink working (Steps 10–11)
- **Milestone: one node sending to the server by 20 Nov**

### Week 48 · 23–29 Nov — five nodes and the app
- Calibrate the dB offset (Step 12)
- 24-hour endurance run on node 1 (Step 13)
- Build and register nodes 2–5 (Step 14)
- App/map MVP on live data (Step 15)

### Week 49 · 30 Nov–3 Dec — data and poster
- Collect a few days of data from all nodes
- Poster: system diagram, photo of the node, map screenshot, measured power budget
- Rehearse the live demo (downlink LED blink)

### 4–10 Dec — report
- Write up method, results, power measurements, privacy, limitations

---

## 3. Decisions (summary)

**Hardware and power**
- 3×AA Li-ion cells (steady 4.5 V) → Pro Mini RAW. Pro Mini LDO gives 3.3 V to the MCU and the RN2483A. The ESP-01 gets switched 4.5 V into its adapter's own LDO.
- MAX4466 powered from D7, DHT22 from D5. Both off between measurements.
- ESP power: IRF4905 high-side switch, 2N2222A driver from A3 (HIGH = on). Planned additions: 100 kΩ base-to-GND and 220–470 µF at the ESP input.
- Before cutting power, set D3, D4 and D6 to plain INPUT (no pull-up).
- Watchdog deep sleep in 8 s steps. Pro Mini power LED removed.
- ESP adapter exposes all pins (GPIO0, GPIO2, EN, RST, TX, RX).
- Radio: RN2483A LoRaWAN modem on SoftwareSerial D10 (its UART_TX) / D11 (its UART_RX) at 9600 baud (autobaud), RESET on D9, 3.3 V from the Pro Mini LDO, antenna on RFH. No LMIC, so flash and RAM are no longer tight. The hardware serial port stays free for uploads and debug output.
- D13 is now only the on-board LED (no longer shared with SPI).

**Firmware and data**
- Sound: 10 s window, DC offset removed, Leq from mean of squares, plus peak. dB = 20·log10(Vrms/Vref) + calibration offset. Mic gain fixed after calibration.
- Serial protocol (9600 baud): `READY` · `SCAN <s> <router hashes>` → `COUNT n`, `AP <hashes heard>`, `END` · `LOCATE` → up to 5 × BSSID + RSSI, `END`.
- Phone privacy: the ESP makes a new random salt at the start of every scan (hardware RNG). Probe MACs are hashed with it, kept in RAM only. Only the count leaves the node.
- Crowd count: the ESP stores each phone as a 4-byte salted hash in a set of up to 4,096 entries (16 KB). Each phone counts once per scan, even if heard on several channels. If the set fills, the count stops at 4,096 and a "list full" status bit is set. Only probe requests stronger than about −80 dBm are counted (tune at the bench). Each uplink is a snapshot of one scan; counts are never added together. MAC randomisation can still count one phone twice, so the value is a relative crowd index.
- Router filter: beacon senders are routers and are never counted. The Pro Mini stores router hashes only (2 bytes, fixed salt, no timestamps) in two RAM lists of up to 48: *this hour* and *last hour*. Hourly rotation means a router is forgotten 1–2 h after it was last heard. Fallback if RAM is short: 2 × 32.
- RAM chosen over EEPROM: with no clock, stored ages are meaningless after a reset anyway.
- Uplink port 1 (8 bytes): avg dB ×2, peak dB ×2, device count (uint16, up to 65,535), temperature ×10 (int16), humidity %, status flags (incl. "list full").
- Uplink port 2 (power-up): AP count + up to 5 × (BSSID + RSSI) = 36 bytes max.
- Uplink port 3 (sleep mode): 2-byte check-in every 30 min (adjustable).
- Downlink port 1: `0x01` interval (1–240 min), `0x02` scan time (s), `0x03` LED blink twice (200 ms), `0x04` sleep (for a time or until woken), `0x05` wake. Interval and scan time saved to EEPROM only when changed.

**Geolocation and server**
- Google Maps Platform Geolocation API, called from the server (key stays on the server, billing enabled, needs ≥ 2 APs).
- Fewer than 3 APs → flag → server keeps the previous position and warns "might have moved". Same warning if a new fix is > 100 m from the previous position.
- Installation position recorded with a phone's GPS, validated on a map, stored as the first previous position, editable on the server.
- Expect campsite APs to be mostly temporary, so the installation position will often be the one used. Test on site and mention in the report.

---

## 4. Build and test steps

Each step has a pass criterion. Don't move on until it passes. Tick the box and write the date.

| # | Step | Pass criterion | Done |
|---|---|---|---|
| 0 | Toolchain: Arduino IDE. Libraries: rn2xx3 (JP Meijers, install as ZIP from GitHub), DHT sensor library + Adafruit Unified Sensor, Low-Power (Rocket Scream, only for deep sleep); ESP8266 Arduino core for the sniffer firmware | Blink sketch uploads to Pro Mini | ☑ 11 Nov |
| 1 | Power bench check: battery → RAW, 3.3 V on VCC; A3 toggled by a test sketch | VCC 3.3 V ±0.1 V; ESP adapter VCC follows A3; Pro Mini doesn't reset when ESP turns on; IRF4905 drop measured | ☑ 12 Nov (IRF4905 drop still to measure) |
| 2 | Mic alone (D7 power, A0) | Quiet room gives resting value ≈ 512 counts; clapping raises RMS clearly; no clipping at loud music | ☑ 11 Nov (`test_sensors.ino`; gain not yet set for loud music) |
| 3 | DHT22 alone (D5 power, D6 data) | 5 valid readings in a row after power-on, matching a reference within ±1 °C / ±5 %RH | ☑ 11 Nov |
| 4 | RN2483A: OTAA join and uplinks (`roskilde_node_demo.ino`) | Join accepted; port 1 and port 2 visible in TTN Live data | ☑ 12 Nov |
| 5 | ESP-01 flashed, `LOCATE` tested over USB serial | Returns up to 5 BSSID + RSSI, then `END` | ☐ |
| 6 | ESP `SCAN` over USB serial: probe counting + beacon filter | `COUNT` changes when phones nearby toggle Wi-Fi; your own router's address never counted; a phone at the far end of the room drops out as the −80 dBm threshold is tuned; "list full" tested with a temporarily small cap | ☐ |
| 7 | Pro Mini ↔ ESP with the power switch | Pro Mini powers ESP, gets `READY`, sends `SCAN`, receives `COUNT`/`AP`/`END`, powers ESP off; repeats 20 times without hanging | ☐ |
| 8 | Router list on Pro Mini | Hashes added each scan; rotation after 1 h removes stale ones (test with a shortened period) | ☐ |
| 9 | Geolocation chain: port 2 uplink → TTN formatter → server → Google | Server stores a position within ~50 m of the true spot (indoor test); fallback flag tested by forcing < 3 APs | ☐ |
| 10 | Full cycle with sleep, current measured | Runs 10 cycles unattended; sleep current measured and logged per phase | ☐ |
| 11 | Downlink commands + LED (`server/send_downlink.py`) | 0x01 and 0x02 change behaviour and survive a reset; 0x03 blinks twice; 0x04 stops measuring and sends port 3 check-ins; 0x05 resumes | ☐ |
| 12 | dB calibration | Offset found; node within ±2 dB of reference SLM over 60–100 dB | ☐ |
| 13 | 24 h endurance (node 1) | 24 h of uplinks with no gaps or resets; average current computed | ☐ |
| 14 | Nodes 2–5 built and registered | All 5 joined and sending | ☐ |
| 15 | App/map MVP | Map shows all nodes with latest dB, crowd index, temperature; "might have moved" visible | ☐ |

Test sketches so far: `test_sensors.ino` (mic + DHT22), `test_dht22.ino`, `test_esp.ino` (ESP power, baud, AT bridge). Keep them after use — they're the quickest way to find a fault on nodes 2–5.

---

## 5. Playbooks

### 5.1 Flashing the Pro Mini
1. Programmer jumper set to **3.3 V** (this also sets its TX voltage).
2. Four wires only: programmer GND → BLK (GND), TX → RXI, RX → TXO, DTR → GRN. **Leave VCC unconnected**; the battery powers the node (the ESP-01 needs the 4.5 V battery rail).
3. Battery on first, then plug in USB.
4. Board: Pro Mini, **ATmega328P 3.3 V 8 MHz**. Serial monitor 9600 baud.
5. No DTR pin? Press the Pro Mini's reset button when the IDE shows "Uploading…".

### 5.2 Flashing the ESP-01
1. Unplug the ESP's TX/RX from D3/D4.
2. Programmer TX→ESP RX, RX→ESP TX, GND→GND.
3. Power the adapter from the battery or 5 V USB, **not** the programmer's 3.3 V pin.
4. Hold GPIO0 to GND while powering on, flash, then release GPIO0 and power-cycle.
5. Check EN and RST read 3.3 V when powered.

### 5.3 TTN setup
1. Create one TTN application for the project, EU868 frequency plan.
2. Register each node as an OTAA end device: LoRaWAN 1.0.2, RP001 1.0.2 rev B (matches RN2483 firmware 1.0.5). Keys go into the sketch exactly as TTN shows them (no byte reversal with the RN2483).
3. If joins are rejected with "DevNonce already used": device → General settings → Network layer → Advanced → tick **Resets join nonces** (testing only).
4. Paste `ttn/payload_formatter.js` into the uplink and downlink payload formatters (ports 1, 2, 3 and all downlinks).
5. Add a custom webhook with ID `soundscape-server` (needed for downlinks; point it at the server once it runs).
6. Add an API key with **Write downlink application traffic** for `send_downlink.py`.
7. Keep each node's keys and API keys in `.env` / private files, never in shared folders or the repo.

### 5.4 Measuring current
1. Multimeter in series in the battery + lead (or a µCurrent / power profiler if the lab has one).
2. Measure each phase separately: sleep, measure (10 s), ESP scan, LoRa TX/RX.
3. For sleep, use the µA range; switch range only while the node is asleep, or the burden voltage can reset it.
4. Log duration × current for each phase, compute average current and expected battery life. Compare with the estimate (≈ 4.5 mA, ESP scan ≈ 90 %).

### 5.5 Calibrating the dB offset
1. Set the mic gain trimmer first; don't touch it afterwards.
2. Place the node and a reference sound level meter side by side.
3. Play pink noise or music at 4–5 levels from ~60 to ~100 dB.
4. Offset = average of (reference dB − node dB without offset).
5. Set the meter to **Z or C weighting**: the node is unweighted, so comparing with dB(A) gives a level-dependent error. Write this in the report.
6. Repeat the check for each of the 5 nodes (mics vary).

### 5.6 Installing a node
1. Record node ID, phone GPS position and accuracy, photo of the spot.
2. Enter the position on the server and check it on the map right away.
3. Switch the battery on and watch TTN Live data: port 2 uplink, then port 1 within one interval.
4. Check the server's position and warnings for that node.
5. If the node is moved, update its position on the server.

### 5.7 Demo checklist (poster day)
- [ ] All nodes recently seen in TTN
- [ ] Map open with live data
- [ ] `python send_downlink.py blink` → LED blinks twice after the next uplink (interval set short beforehand with `interval 1`)
- [ ] Spare charged AA cells

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| OTAA join never accepted | Keys don't match TTN, no antenna, no gateway, DevNonce rejected | Compare DevEUI/JoinEUI/AppKey with TTN; antenna on RFH; check Live data for errors; tick "Resets join nonces" |
| "No answer from RN2483" | Wires on D10/D11 swapped or missing | RN2483 UART_TX → D10, UART_RX ← D11; check 3.3 V on VDD |
| Wi-Fi scan failed after ~4.5 s | ESP not powered (running from programmer's 3.3 V) or wrong baud | Battery on, programmer VCC off; run `test_esp.ino` |
| Pro Mini resets when ESP turns on | Supply dip from ESP inrush | Add 220–470 µF at ESP input; check battery contacts |
| No `READY` from ESP | EN/RST low, GPIO0 held low, wrong baud | Measure EN/RST; release GPIO0; both sides 9600 |
| ESP partly on while "off" | Back-powering through TX/RX, or base floating | D3/D4 to INPUT before A3 LOW; add 100 kΩ base pull-down |
| DHT22 returns NaN | Read too soon after power-on, missing pull-up | Wait ≥ 1 s; check 10 kΩ DATA→D5 |
| dB stuck at max | Gain too high, mic clipping | Lower gain, then recalibrate |
| Random crashes after adding code | RAM exhausted | Check free RAM; shrink router list to 2 × 32; avoid `String` |
| Mic DC far from 512 in the demo | Mic output not settled after power-on | Wait ≥ 2 s after D7 HIGH (fixed in the demo) |
| Mic DC jumps, RMS constant, CLIP every second | A0 not connected (floating input) | Check the OUT → A0 wire (A0 is next to D13) |
| High sleep current | Power LED, pin left HIGH, module back-powered | Remove LED; check every pin state before sleep |

---

## 7. Repository layout

```
firmware/
  promini/        main Pro Mini firmware
  esp01/          ESP-01 firmware
  tests/          one sketch per build step
ttn/
  payload_formatter.js   uplink decoder (ports 1, 2, 3) + downlink encoder
server/           send_downlink.py (done), webhook receiver, decoder, storage, Google lookup (planned)
app/              map front end
docs/             this file, diagrams, measurements, calibration data
```

---

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| ESP-01 sniffer firmware takes longer than planned | No phone count for the demo | Demo firmware sends Wi-Fi network count (flag bit 0) meanwhile |
| Wi-Fi geolocation poor at the campsite | Wrong or missing positions | GPS installation position as fallback; "might have moved" warnings |
| Battery life shorter than expected | Nodes die during demo | Measure early (Step 10); lengthen interval or shorten scan via downlink |
| Gateway coverage | No data | Check TTN coverage map for the deployment site early |
| Phone MAC randomisation | Count isn't a headcount | Present it as a relative crowd index in app and report |

---

## 9. Privacy (for the report)
- Phone MAC addresses are hashed with a per-scan random salt, kept only in the ESP's RAM for the length of one scan, and never stored or sent.
- Only an aggregate count leaves the node.
- Router BSSIDs (infrastructure, not personal devices) are sent unhashed only for geolocation at power-up.
