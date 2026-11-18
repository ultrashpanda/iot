# mcu

Firmware for the sensor nodes (Arduino Pro Mini + RN2483A LoRa + ESP-01): sampling, sleep and uplink.

| Folder | Contents |
|---|---|
| `Roskilde_Node/` | Main node firmware (currently v0.8) |
| `esp_sniffer/` | ESP-01 firmware: Wi-Fi scan and phone counting |
| `tools/batt_cal/` | Battery voltage calibration sketch |
| `tools/wdt_test/` | Watchdog test sketch |
| `tools/loudness_logger/` | Python live plot + CSV log of loudness over serial, plus test data |

## Before flashing

1. Copy `Roskilde_Node/secrets.example.h` to `Roskilde_Node/secrets.h`.
2. Fill in the TTN keys for that node from the TTN console.
3. `secrets.h` is ignored by git. Never commit it.

## Versions

The version lives in `FW_MAJOR` / `FW_MINOR` in `config.h` (the server sees it on port 4).
With every new version: bump those, add a changelog entry in the `.ino` header, commit, and tag it (`fw-vX.Y`).
No version folders: git history replaces them.

## Build settings (from v0.4)

MiniCore, Board ATmega328, Variant 328P or 328PB (check the avrdude signature), External 8 MHz, BOD 2.7 V, Bootloader Yes (UART0), upload baud 38400.

## ESP-01 (from v0.6)

Runs `esp_sniffer/esp_sniffer.ino` (board "Generic ESP8266 Module", upload 115200). To flash with the CP2102: VCC and CHPD to 3.3 V (the breadboard adapter has no regulator, never 5 V), GND, TXD↔RXD crossed, GP0 to GND only while flashing; close the Serial Monitor first. Protocol to the Pro Mini at 9600 baud: RDY → `S<seconds>` → PH / RN / NW / AP / NF → END.

## EEPROM map (Pro Mini)

0–2 settings (magic, interval, scan time) · 8–9 boot count · 10 boot-loop flag (v0.7).

## Version history

- v0.4 (13 Nov 2026): own calibrated deep sleep instead of Low-Power; CAL_OFFSET_DB 55.0 with the trimmer fully clockwise; BATT_CAL 0.993 (node 1); interval 5 min; reset-cause notes for the MiniCore bootloader.
- v0.5 (13 Nov 2026): `LORA_DR` in config.h (0 = SF12 … 5 = SF7). If the SF7 join fails, the join is retried at LORA_DR, and uplinks go out at LORA_DR. Set to 0 for coverage tests; set back to 5 for deployment (SF12 allows only ~20 uplinks/day under TTN fair use).
- v0.6 (13 Nov 2026): phone counting. The ESP-01 sniffs for 45 s (downlink 02) in parallel with the sound/DHT measurement (`SNIFF_PARALLEL`); crowd on port 1 = phones nearby (flag 0x01 cleared, 0x10 = list full). Interval 10 min. New EEPROM magic, so stored settings are replaced by the new defaults once. Tested 13 Nov: full cycle works, ESP adds no mic noise.
- v0.8 (18 Nov 2026): downlink `06` restarts the node through the watchdog (remote restart, also triggers a fresh Wi-Fi scan on port 2). FW_MINOR fixed (v0.7 reported 0.6).
- v0.7 (13 Nov 2026): port 2 and port 4 sent confirmed (up to 3 attempts, 60 s apart); boot-loop guard in EEPROM (a boot that ran < 60 min makes the next boot send port 2/4 unconfirmed); link check every 8 h. Downlink budget: ~3/day normally, +3 on a boot day.
