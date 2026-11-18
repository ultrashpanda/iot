# Roskilde Sensor Node — Message Protocol

DTU 34365 IoT Prototyping · SoundScape (TTN application `soundscape`)

This is the shared reference for every message between the nodes, TTN and our server. If you change a byte anywhere (firmware, TTN formatter or server), update this file in the same go, and add a line to the changelog at the bottom.

| Part | File |
|---|---|
| Node firmware | `roskilde_node_demo/roskilde_node_demo.ino` |
| TTN payload formatter | `ttn/payload_formatter.js` |
| Downlink script | `server/send_downlink.py` |
| Settings (never shared) | `server/.env` (template: `server/.env.example`) |

---

## 1. How a message travels

```
Node (Pro Mini + RN2483A) ──LoRa──▶ gateway ──▶ TTN ──webhook (JSON)──▶ server ──▶ database ──▶ app
          ▲                                       │
          └────────── downlink after the node's next uplink ◀── server queues it via TTN API
```

- All multi-byte fields are **big-endian** (high byte first).
- The **LoRaWAN port** is the message type. A changed layout gets a new port, so old data stays readable.
- No sequence byte: LoRaWAN's frame counter (`f_cnt`) numbers every message.
- No timestamp or signal strength from the node: TTN adds `received_at`, and the gateways add `rssi`/`snr`.
- In the webhook JSON, the node's bytes are in `uplink_message.frm_payload` as **base64**. Decode with `base64.b64decode()`.

---

## 2. Uplinks (node → server)

### Port 1 · measurement · 8 bytes · every interval

| Byte | Field | Encoding | Example |
|---|---|---|---|
| 0 | Sound avg | Leq over 10 s, dB × 2 (0–127.5 dB, 0.5 dB steps) | `7C` = 62.0 dB |
| 1 | Sound peak | dB × 2 | `AE` = 87.0 dB |
| 2–3 | Crowd count | unsigned, 0–65,535 | `00 1A` = 26 |
| 4–5 | Temperature | signed, °C × 10 | `00 D8` = 21.6 °C |
| 6 | Humidity | % (0–100) | `29` = 41 % |
| 7 | Flags | see below | `01` |

**Flags (byte 7)**

| Bit | Meaning |
|---|---|
| 0 | Crowd count is Wi-Fi networks, not phones (demo firmware with ESP AT firmware) |
| 1 | DHT22 read failed |
| 2 | Mic clipped |
| 3 | Wi-Fi scan failed |
| 4 | Phone hash list full (sniffer firmware, later) |
| 5–7 | Reserved, sent as 0 |

Full example: `7C AE 00 1A 00 D8 29 01` (base64 `fK4AGgDYKQE=`) = 62.0 dB, 87.0 dB, 26, 21.6 °C, 41 %, flag bit 0.

### Port 2 · geolocation · 1 + 7 × n bytes (max 36) · at power-up

| Byte | Field | Encoding |
|---|---|---|
| 0 | AP count | 0–5, strongest first |
| 1–6 | AP 1 BSSID | 6 bytes, as written (`00:2A:10:…` → `00 2A 10 …`) |
| 7 | AP 1 RSSI | dBm + 128 (`43` = −61 dBm) |
| 8–35 | AP 2–5 | 7 bytes each, same layout |

Server rules:
- Send the APs to Google Geolocation API with `"considerIp": false`.
- Fewer than 3 APs, or Google finds nothing → keep the previous position, flag "might have moved".
- New position more than 100 m from the previous → store it, flag "might have moved".
- The installation position (phone GPS) is the first previous position.

Only access-point addresses (infrastructure) are sent. Phone addresses never leave the node.

### Port 3 · sleep-mode check-in · 2 bytes · every check-in period while asleep

| Byte | Field | Encoding |
|---|---|---|
| 0–1 | Sleep left | minutes of sleep remaining, 0 = until woken |

---

## 3. Downlinks (server → node)

All on **port 1**. LoRaWAN Class A: TTN holds the command and sends it right after the node's next uplink.

| Command | Bytes | Effect | Range |
|---|---|---|---|
| Interval | `01 mm` | Measure every mm minutes. Saved in EEPROM. | 1–240 |
| Scan time | `02 ss` | Wi-Fi scan time in seconds. Saved in EEPROM. | 5–60 |
| Blink | `03` | LED on 200 ms, off 200 ms, on 200 ms, then sleep | — |
| Sleep | `04 [hh ll [cc]]` | Stop measuring for hhll minutes (0 or omitted = until woken), check in every cc minutes | hhll 0–65,535 · cc 5–255, default 30 |
| Wake | `05` | Resume measuring right after the check-in that received it | — |

Examples:
- `01 05` → measure every 5 min
- `04` → sleep until woken
- `04 01 E0` → sleep 480 min (8 h), then resume by itself
- `04 01 E0 3C` → sleep 8 h, check in every 60 min

**When does a command arrive?**
- Awake node: within one measurement interval.
- Sleeping node: within one check-in period.
- A node that never transmits can never be reached. That is why sleep mode still sends port 3 check-ins.
- Sleep mode is kept in RAM only: switching the node off and on always wakes it.

---

## 4. Sending a downlink

**From the TTN console (quick test)**
Device → Messaging → Downlink → FPort `1` → either bytes (e.g. `03`) or JSON through the formatter:

| JSON | Bytes |
|---|---|
| `{ "interval_min": 5 }` | `01 05` |
| `{ "scan_s": 15 }` | `02 0F` |
| `{ "blink": true }` | `03` |
| `{ "sleep_min": 0 }` | `04 00 00` |
| `{ "sleep_min": 480, "checkin_min": 60 }` | `04 01 E0 3C` |
| `{ "wake": true }` | `05` |

**From the server script**
```
python send_downlink.py blink
python send_downlink.py interval 5
python send_downlink.py scan 15
python send_downlink.py sleep                  # until woken
python send_downlink.py sleep 480 --checkin 60
python send_downlink.py wake
python send_downlink.py --device 2-soundscape-device blink   # other node
```

Setup (once per person):
1. TTN → application → API keys → add a key with **Write downlink application traffic**.
2. TTN → Integrations → Webhooks → custom webhook with ID `soundscape-server`.
3. Copy `server/.env.example` to `server/.env` and fill in your values.

---

## 5. Test checklist

| Test | Expected | Done |
|---|---|---|
| Port 1 arrives in TTN Live data | Decoded values match the serial monitor | ☐ |
| Port 2 arrives after power-up | AP list with 3–5 entries | ☐ |
| `blink` | LED blinks twice after the next uplink | ☐ |
| `interval 2` | Uplinks every 2 min; still 2 min after a reset | ☐ |
| `sleep 10 --checkin 5` | No port 1 for 10 min, port 3 every 5 min, then port 1 again | ☐ |
| `sleep` then `wake` | Port 3 check-ins until wake, then port 1 at once | ☐ |
| Power-cycle while asleep | Node measures again (port 2, then port 1) | ☐ |

---

## 6. Rules for the team

- Never put API keys or TTN keys in files that get shared. They belong in `.env` only.
- Change a byte layout → update firmware, `payload_formatter.js`, the server decoder and this file together.
- New layout → new port number; don't silently reuse an old one.
- Ranges in this file are checked in the firmware and the script. Keep them in sync.

---

## 7. Changelog

| Date | Change | Who |
|---|---|---|
| 2026-11-12 | Port 1 (8 bytes), port 2, downlinks 0x01–0x03 | |
| 2026-11-12 | Blink changed to 2 × 200 ms | |
| 2026-11-12 | Sleep (0x04), wake (0x05), port 3 check-in; interval range 1–240 min | |
