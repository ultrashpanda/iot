// Roskilde node: pins, timing and calibration. No secrets here (see secrets.h).
#ifndef ROSKILDE_CONFIG_H
#define ROSKILDE_CONFIG_H

#include <Arduino.h>

// ------------------------------------------------------------------ build switches
#define USE_DEEP_SLEEP 1   // 0 = delay() between cycles (debugging), 1 = watchdog sleep (real use, current tests)
#define SELF_TEST      0   // 1 = print the 4 shared test messages at boot, to compare with the protocol file
#define WDT_TEST       0   // 1 = hang on purpose after the first cycle: the node must reboot with "Reset cause: WATCHDOG"

#define FW_MAJOR 0
#define FW_MINOR 6

// ------------------------------------------------------------------ LoRa data rate (v0.5)
// EU868 data rate for joining and uplinks (ADR off). Airtime for the 11-byte port 1 message:
//   5 = SF7  ~0.06 s  (default, 5-min interval OK)      2 = SF10 ~0.37 s
//   4 = SF8  ~0.11 s                                     1 = SF11 ~0.74 s
//   3 = SF9  ~0.21 s                                     0 = SF12 ~1.48 s  (range tests only)
// TTN fair use = 30 s airtime per node per day: SF12 allows ~20 uplinks/day (interval >= ~75 min).
#define LORA_DR 0

// ------------------------------------------------------------------ robustness (v0.3)
#define USE_WATCHDOG        1      // 8 s hardware watchdog while awake: a hang resets the node
#define JITTER_S            15     // +- random seconds on every interval, so nodes don't stay in sync
#define BOOT_JITTER_S       20     // random 0..20 s wait before the first join
#define LINK_CHECK_EVERY_MIN 360   // every 6 h one uplink is sent confirmed (uses 1 TTN downlink)
#define LINK_MISSES_REJOIN  2      // rejoin after this many link checks without an ack
#define MIC_DC_MIN          412    // mic resting level must be within 512 +- 100 counts,
#define MIC_DC_MAX          612    // otherwise flag bit 6 (mic fault)

// ------------------------------------------------------------------ defaults (when EEPROM is blank)
#define NODE_DEFAULT_INTERVAL_MIN 10   // 1 breaks TTN fair use (30 s airtime/day). Only used when EEPROM is blank:
                                       // nodes flashed before keep their stored value -> send downlink 01 05
#define NODE_DEFAULT_SCAN_S       45   // phone sniffing time in s (downlink 02, 5..60)
#define SNIFF_PARALLEL            1    // 1 = ESP sniffs while the mic/DHT measure; 0 = after (if the ESP adds mic noise)

// ------------------------------------------------------------------ sound
#define SOUND_WINDOW_MS 10000UL   // Leq over 10 s
#define MIC_SETTLE_MS   2000UL    // mic output needs ~2 s to settle at VCC/2 after power-on (DHT22 too)
#define PEAK_BLOCK_MS   125UL     // peak = loudest 125 ms block ("Fast", like a sound level meter's Max)
// dB = 20*log10(rms in ADC counts) + CAL_OFFSET_DB. Depends on the MAX4466 gain pot setting!
// Rough guide (3.3 V, -44 dBV/Pa capsule): min gain ~60, mid gain ~45-50. Calibrate against a reference meter.
// Calibrated 13 Nov with the trimmer FULLY CLOCKWISE: 1 count rms = 55 dB, clips from ~96 dB (music).
#define CAL_OFFSET_DB   55.0f

// ------------------------------------------------------------------ battery (3 x AA alkaline, ~4.8 V fresh, ~3.0 V empty)
// Divider: BAT+ -> R_TOP -> A1 -> R_BOTTOM -> GND, plus 100 nF (ceramic, marked "104") from A1 to GND.
// Fitted 13 Nov: 2 x 1 MOhm -> fresh 4.8 V reads as 2.4 V on A1.
#define BATT_R_TOP_KOHM    1000.0f
#define BATT_R_BOTTOM_KOHM 1000.0f
const float BATT_DIVIDER = (BATT_R_TOP_KOHM + BATT_R_BOTTOM_KOHM) / BATT_R_BOTTOM_KOHM;
// Reference for the battery reading:
//   1 = internal 1.1 V. Only for dividers that keep A1 below ~1.0 V (e.g. 1 MOhm / 220 kOhm).
//   0 = the 3.3 V supply, measured against the internal 1.1 V on every reading, so the result
//       stays right even when the regulator drops out near empty. Needed for 2 x 1 MOhm (A1 up to 2.4 V).
#define BATT_USE_INTERNAL_REF 0
// Corrects resistor tolerance and the +-10 % spread of the internal 1.1 V. Once per node (playbook 5.4b):
//   BATT_CAL = multimeter reading on RAW / "Battery rest" printed in the serial monitor
// Node 1, 13 Nov: 4.735 V multimeter / 4.768 V printed. OTHER NODES NEED THEIR OWN VALUE.
const float BATT_CAL     = 0.993f;
// Percentage table and the 4.3 V Wi-Fi warning are in protocol.h (battPercent, WIFI_WARN_MV).

// ------------------------------------------------------------------ pins (hardware map)
const uint8_t PIN_ESP_RX   = 3;    // ESP TX  -> D3
const uint8_t PIN_ESP_TX   = 4;    // D4      -> ESP RX
const uint8_t PIN_ESP_PWR  = A3;   // HIGH = ESP-01 powered (2N2222A + IRF4905)
const uint8_t PIN_DHT_PWR  = 5;
const uint8_t PIN_DHT_DATA = 6;
const uint8_t PIN_MIC_PWR  = 7;
const uint8_t PIN_LORA_RST = 9;
const uint8_t PIN_LORA_RX  = 10;   // RN2483 UART_TX -> D10
const uint8_t PIN_LORA_TX  = 11;   // D11 -> RN2483 UART_RX
const uint8_t PIN_LED      = 13;
const uint8_t PIN_MIC      = A0;
const uint8_t PIN_BATT     = A1;   // battery divider

#endif
