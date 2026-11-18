# SoundScape: How the node sends data (Team 1, prototype)

DTU 34365 IoT Prototyping · TTN application `soundscape` · 12 Nov 2026

This guide covers what the node must send, in what format, and what the server and app do with it. The byte layouts come from `Roskilde-Node-Message-Protocol.md`. Points marked **NEW** are agreed with Team 2 but not yet in that file. Please add them.

---

## 1. The big picture

```
Node ──LoRa 868 MHz──▶ gateway ──▶ TTN ──MQTT──▶ server ──▶ SQLite ──▶ web app
  ▲                                                │
  └──── downlink, after the node's next uplink ◀───┘ (TTN API)
```

* The node only measures, packs bytes, sends, sleeps and obeys downlinks.
* The node does **not** know the time, its position or its signal strength. TTN adds `received_at`, and the gateways add RSSI and SNR.
* Encryption is standard LoRaWAN, done by the RN2483A. TTN decrypts. There is no extra AES layer.
* **NEW:** The server gets data from TTN over **MQTT**, not a webhook. Please update section 1 and setup step 2 of the protocol file. `send_downlink.py` stays as it is.

---

## 2. Rules every message follows

* All multi-byte fields are **big-endian** (high byte first).
* The **LoRaWAN port is the message type**. A new layout gets a new port, and an old port is never silently reused.
* There is no sequence byte. LoRaWAN's `f_cnt` numbers the messages.
* The server decodes the raw bytes. The TTN payload formatter is only for viewing in the TTN console.
* If a byte changes, update the firmware, `payload_formatter.js`, the server decoder and the protocol file **together**, and tell Team 2.

---

## 3. Port 1: measurement (8 bytes, every interval)

| Byte | Field | Encoding | Range | Error value (**NEW**) |
|---|---|---|---|---|
| 0 | Sound avg | Leq over 10 s, dB × 2 | 0 to 127.5 dB, 0.5 dB steps | none, always measured |
| 1 | Sound peak | dB × 2 | 0 to 127.5 dB | none, see flag bit 2 |
| 2 to 3 | Crowd count | unsigned int16 | 0 to 65,534 | `FF FF` |
| 4 to 5 | Temperature | **signed** int16, °C × 10 | −40.0 to 80.0 °C | `7F FF` |
| 6 | Humidity | % | 0 to 100 | `FF` |
| 7 | Flags | bits, see below | | |

**Flags (byte 7)**

| Bit | Value | Meaning |
|---|---|---|
| 0 | `0x01` | Crowd count is Wi-Fi networks, not phones (demo firmware) |
| 1 | `0x02` | DHT22 read failed |
| 2 | `0x04` | Mic clipped |
| 3 | `0x08` | Wi-Fi scan failed |
| 4 | `0x10` | Phone hash list full (sniffer firmware, later) |
| 5 to 7 | | Reserved, always 0 |

**NEW: what to send when something fails.** Always set the flag **and** write the error value into the field. The server trusts the flag first and uses the error value as a second check.

* DHT22 failed: set bit 1, temperature `7F FF`, humidity `FF`.
* Wi-Fi scan failed: set bit 3, crowd `FF FF`.
* Mic clipped: set bit 2 but still send the real numbers. The app shows the peak as "at least this loud".

**Test messages.** Please check that the firmware produces exactly these bytes.

| Case | Bytes | Base64 | Means |
|---|---|---|---|
| Normal | `7C AE 00 1A 00 D8 29 01` | `fK4AGgDYKQE=` | 62.0 dB, 87.0 dB, 26 networks, 21.6 °C, 41 % |
| Cold night | `60 85 00 0C FF D8 58 01` | `YIUADP/YWAE=` | 48.0 dB, 66.5 dB, 12, **−4.0 °C**, 88 % |
| Mic clipped | `F0 FF 00 28 00 99 3C 05` | `8P8AKACZPAU=` | 120.0 dB, 127.5 dB (clipped), 40, 15.3 °C, 60 % |
| DHT + Wi-Fi failed | `6F 8C FF FF 7F FF FF 0B` | `b4z//3///ws=` | 55.5 dB, 70.0 dB, no crowd, no temp, no humidity |

Note on the cold night case: −4.0 °C = −40 = `FF D8` in two's complement. If the firmware stores the temperature in an `int16_t` and shifts the high byte out first, this works automatically.

---

## 4. Port 2: geolocation (1 + 7 × n bytes, max 36, at power-up)

| Byte | Field | Encoding |
|---|---|---|
| 0 | AP count | 0 to 5, strongest first |
| 1 to 6 | AP 1 BSSID | 6 bytes as written (`00:2A:10:…` → `00 2A 10 …`) |
| 7 | AP 1 RSSI | dBm + 128 (`43` = −61 dBm) |
| 8 to 35 | AP 2 to 5 | 7 bytes each, same layout |

Example with 3 APs (22 bytes):
`03 00 2A 10 A1 B2 C3 43 F4 F2 6D 11 22 33 3A 3C 37 86 AA BB CC 32`

**Why the server cares about port 2:**

* It looks up the position with Google Geolocation. With fewer than 3 APs, or a jump of more than 100 m, the app shows "might have moved".
* **NEW:** The server treats **every port 2 message as "the node was just switched on"**. It uses this to start the battery estimate. Please make sure port 2 is sent on every power-up, also when the scan finds 0 APs (send `00`).
* To do from your own next steps: send only one BSSID per physical access point.

---

## 5. Port 3: sleep check-in (2 bytes, while asleep)

| Byte | Field | Encoding |
|---|---|---|
| 0 to 1 | Sleep left | minutes remaining, unsigned, 0 = until woken |

Example: `00 F0` = 240 min left. The app shows the node as **sleeping**, not offline.

---

## 6. Downlinks (server → node, all on port 1)

| Command | Bytes | Effect | Range |
|---|---|---|---|
| Interval | `01 mm` | Measure every mm minutes, saved in EEPROM | 1 to 240 |
| Scan time | `02 ss` | Wi-Fi scan seconds, saved in EEPROM | 5 to 60 |
| Blink | `03` | LED 200 ms on, 200 off, 200 on | |
| Sleep | `04 [hh ll [cc]]` | Stop for hhll minutes (0 = until woken), check in every cc min | hhll 0 to 65,535, cc 5 to 255 (default 30) |
| Wake | `05` | Resume after the check-in that received it | |

* Class A: a command arrives only right after the node transmits.
* Out-of-range values are ignored by the firmware. The server checks them too.
* Sleep mode is kept in RAM, so a power-cycle always wakes the node.

---

## 7. Timing the server and app rely on

| Setting | Value | What depends on it |
|---|---|---|
| Default interval | 5 min | App marks a node **offline** after 3 missed intervals (15 min) |
| Demo interval | 1 min | Tell Team 2 when you switch |
| Default check-in | 30 min | A sleeping node is marked offline after 2 missed check-ins |
| Device IDs | `1-soundscape-device` … `5-soundscape-device` | Must stay the same once registered |

---

## 8. What we need from you

1. Add the error values (section 3) and "port 2 on every power-up" (section 4) to the protocol file.
2. Change webhook to MQTT in the protocol file.
3. Measure the current in each phase (sleep, measure, Wi-Fi scan, TX). The server uses it for the battery estimate.
4. Send the installation GPS position of each node to Team 2 when nodes are placed.
5. Run the four test messages in section 3 through the firmware and check the bytes.

---

## 9. Battery (decided)

There is no voltage byte for now. The server estimates the battery from the time and number of messages since the last power-up (port 2), using your current measurements and the cell capacity. The cells are 1.5 V alkaline AA. Their voltage drops gradually, so a voltage divider from RAW to A1 (with flag bit 5 or a new port) would give a real reading later if there is time.
