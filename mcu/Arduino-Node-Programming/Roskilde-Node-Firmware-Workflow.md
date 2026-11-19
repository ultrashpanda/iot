# Roskilde node firmware: how changes are saved

Every change to the node firmware gets a new version folder. Older version folders are never edited.

**Location:** `OneDrive-DanmarksTekniskeUniversitet/IoT - Prototyping/Final Project/`

**Folder per version:** `Roskilde_Node_v.X.Y/`
- `Roskilde_Node_v.X.Y.ino` (the Arduino IDE needs the folder name to match the sketch name)
- `config.h`
- `protocol.h`
- `secrets.h`: copied in by the user, never written by Claude (it holds the TTN keys)

**With every new version:**
1. Set `FW_MAJOR` / `FW_MINOR` in config.h to X.Y. The server sees this on port 4.
2. Add a changelog entry for X.Y in the header comment of the .ino.
3. Start from the latest version folder, not from older copies.

**Build settings (from v0.4):** MiniCore, Board ATmega328, Variant 328P or 328PB (check the avrdude signature), External 8 MHz, BOD 2.7 V, Bootloader Yes (UART0), upload baud 38400.

**ESP-01 (from v0.6):** runs `Test_scripts/esp_sniffer/esp_sniffer.ino` (board "Generic ESP8266 Module", upload 115200). To flash with the CP2102: VCC and CHPD to 3.3 V (the breadboard adapter has no regulator, never 5 V), GND, TXD↔RXD crossed, GP0 to GND only while flashing; close the Serial Monitor first. Protocol to the Pro Mini at 9600 baud: RDY → `S<seconds>` → PH / RN / NW / AP / NF → END.

**EEPROM map (Pro Mini):** 0–2 settings (magic, interval, scan time) · 8–9 boot count · 10 boot-loop flag (v0.7).

**Versions**
- v0.4 (13 Nov 2026): own calibrated deep sleep instead of Low-Power; CAL_OFFSET_DB 55.0 with the trimmer fully clockwise; BATT_CAL 0.993 (node 1); interval 5 min; reset-cause notes for the MiniCore bootloader.
- v0.5 (13 Nov 2026): `LORA_DR` in config.h (0 = SF12 … 5 = SF7). If the SF7 join fails, the join is retried at LORA_DR, and uplinks go out at LORA_DR. Set to 0 for coverage tests; set back to 5 for deployment (SF12 allows only ~20 uplinks/day under TTN fair use).
- v0.6 (13 Nov 2026): phone counting. The ESP-01 sniffs for 45 s (downlink 02) in parallel with the sound/DHT measurement (`SNIFF_PARALLEL`); crowd on port 1 = phones nearby (flag 0x01 cleared, 0x10 = list full). Interval 10 min. New EEPROM magic, so stored settings are replaced by the new defaults once. Tested 13 Nov: full cycle works, ESP adds no mic noise.
- v0.7 (13 Nov 2026): port 2 and port 4 sent confirmed (up to 3 attempts, 60 s apart); boot-loop guard in EEPROM (a boot that ran < 60 min makes the next boot send port 2/4 unconfirmed); link check every 8 h. Downlink budget: ~3/day normally, +3 on a boot day.
