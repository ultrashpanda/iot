// SoundScape node protocol: pure packing / parsing logic (no Arduino deps).
// Byte layouts follow Team 1's Roskilde-Node-Message-Protocol.md. All multi-byte fields big-endian.
// Compiles on the Pro Mini and on a PC (see ../test/test_protocol.cpp).
#ifndef SOUNDSCAPE_PROTOCOL_H
#define SOUNDSCAPE_PROTOCOL_H

#include <stdint.h>
#include <stddef.h>
#include <math.h>

// ---- LoRaWAN ports (port = message type) ----
#define PORT_MEASUREMENT 1
#define PORT_GEOLOCATION 2
#define PORT_SLEEP       3
#define PORT_BOOT        4   // NEW v0.3: boot info, 5 bytes, once per boot after port 2

// ---- Port 1 flags (byte 7) ----
#define FLAG_CROWD_IS_NETWORKS 0x01   // v0.6: cleared, crowd = phones nearby
#define FLAG_DHT_FAILED        0x02
#define FLAG_MIC_CLIPPED       0x04
#define FLAG_WIFI_FAILED       0x08
#define FLAG_HASH_LIST_FULL    0x10   // ESP's device list filled up: crowd is a lower bound
#define FLAG_BATT_LOW_WIFI     0x20   // lowest voltage under ESP load < WIFI_WARN_MV
#define FLAG_MIC_FAULT         0x40   // NEW v0.3: mic resting level far from mid-scale -> noise values invalid

#define MEASUREMENT_LEN 11     // 8 + battery %, rest voltage, ESP-load voltage
#define CHECKIN_LEN 3          // sleep left (2) + battery %
#define BOOT_LEN 5             // fw major, fw minor, reset cause, boot count (2)
#define WIFI_WARN_MV 4300      // ESP adapter regulator needs ~4.2-4.3 V under load
#define MAX_APS 5
#define GEO_MAX_LEN (1 + 7 * MAX_APS)  // 36

// ---- Defaults / limits ----
#define DEFAULT_INTERVAL_MIN 5
#define DEFAULT_SCAN_SEC     10
#define DEFAULT_CHECKIN_MIN  30

struct Measurement {
  float avgDb;        // Leq over the window
  float peakDb;       // loudest moment
  bool  micClipped;
  bool  crowdValid;   // false = Wi-Fi scan failed
  uint16_t crowd;     // 0..65534, phones nearby (v0.6; Wi-Fi networks before)
  bool  crowdIsNetworks;
  bool  dhtOk;
  float tempC;        // -40..80
  float humidity;     // 0..100
  uint16_t battRestMv;  // before the ESP-01 switches on
  uint16_t battLoadMv;  // lowest while the ESP-01 runs
  bool  micFault;       // last on purpose: older initialisers leave it false
  bool  hashListFull;   // v0.6, also last for the same reason
};

struct Ap {
  uint8_t bssid[6];
  int8_t  rssi;       // dBm
};

// dB -> byte (dB x 2, 0.5 dB steps, 0..127.5 dB)
static inline uint8_t encodeDb(float db) {
  if (!(db > 0.0f)) return 0;           // also catches NaN
  float v = roundf(db * 2.0f);
  if (v > 255.0f) v = 255.0f;
  return (uint8_t)v;
}

// Approximate state of charge of 3 x AA alkaline from the rest voltage.
// Generic alkaline curve per cell: 1.60 V 100 %, 1.50 85, 1.40 65, 1.30 45, 1.20 25, 1.10 10, 1.00 0.
// Refine after a test-to-empty run (and update the thresholds in the protocol file).
static inline uint8_t battPercent(uint16_t mv) {
  static const uint16_t V[] = { 4800, 4500, 4200, 3900, 3600, 3300, 3000 };
  static const uint8_t  P[] = {  100,   85,   65,   45,   25,   10,    0 };
  if (mv >= V[0]) return 100;
  for (uint8_t i = 1; i < sizeof(V) / sizeof(V[0]); i++) {
    if (mv >= V[i]) return P[i] + (uint32_t)(mv - V[i]) * (P[i - 1] - P[i]) / (V[i - 1] - V[i]);
  }
  return 0;
}

// Millivolts in one byte: (mV - 2000) / 20, covers 2.00 - 7.10 V
static inline uint8_t mvToByte(uint16_t mv) {
  if (mv <= 2000) return 0;
  uint16_t v = (mv - 2000 + 10) / 20;
  return v > 255 ? 255 : v;
}

static inline void putU16(uint8_t *p, uint16_t v) { p[0] = v >> 8; p[1] = v & 0xFF; }

// Port 1, 11 bytes. On failure: flag AND sentinel (7F FF / FF / FF FF) as agreed with Team 2.
static inline void packMeasurement(uint8_t out[MEASUREMENT_LEN], const Measurement &m) {
  uint8_t flags = 0;
  if (m.crowdIsNetworks) flags |= FLAG_CROWD_IS_NETWORKS;
  if (m.micClipped)      flags |= FLAG_MIC_CLIPPED;
  if (m.micFault)        flags |= FLAG_MIC_FAULT;
  if (m.hashListFull)    flags |= FLAG_HASH_LIST_FULL;

  out[0] = encodeDb(m.avgDb);
  out[1] = encodeDb(m.peakDb);

  if (m.crowdValid) {
    uint16_t c = m.crowd > 65534 ? 65534 : m.crowd;
    putU16(&out[2], c);
  } else {
    flags |= FLAG_WIFI_FAILED;
    putU16(&out[2], 0xFFFF);
  }

  if (m.dhtOk) {
    float t = m.tempC;
    if (t < -40.0f) t = -40.0f;
    if (t >  80.0f) t =  80.0f;
    int16_t t10 = (int16_t)lroundf(t * 10.0f);
    putU16(&out[4], (uint16_t)t10);       // two's complement, high byte first
    float h = m.humidity;
    if (h < 0.0f)   h = 0.0f;
    if (h > 100.0f) h = 100.0f;
    out[6] = (uint8_t)lroundf(h);
  } else {
    flags |= FLAG_DHT_FAILED;
    putU16(&out[4], 0x7FFF);
    out[6] = 0xFF;
  }
  if (m.battLoadMv < WIFI_WARN_MV) flags |= FLAG_BATT_LOW_WIFI;
  out[7] = flags;
  out[8] = battPercent(m.battRestMv);
  out[9] = mvToByte(m.battRestMv);
  out[10] = mvToByte(m.battLoadMv);
}

// Port 2: n, then n x (6 byte BSSID, rssi+128). Sent on EVERY power-up, also with n = 0 (-> single byte 00).
// Returns number of bytes written.
static inline size_t packGeolocation(uint8_t *out, const Ap *aps, uint8_t n) {
  if (n > MAX_APS) n = MAX_APS;
  out[0] = n;
  size_t k = 1;
  for (uint8_t i = 0; i < n; i++) {
    for (uint8_t b = 0; b < 6; b++) out[k++] = aps[i].bssid[b];
    int16_t r = (int16_t)aps[i].rssi + 128;
    if (r < 0) r = 0;
    if (r > 255) r = 255;
    out[k++] = (uint8_t)r;
  }
  return k;
}

// Port 3: minutes left (big-endian, 0 = until woken) + battery %.
static inline void packSleepCheckin(uint8_t out[CHECKIN_LEN], uint16_t minutesLeft, uint16_t battRestMv) {
  putU16(out, minutesLeft);
  out[2] = battPercent(battRestMv);
}

// Port 4 (NEW v0.3): boot info, sent once after port 2 on every boot.
// Reset cause = the ATmega328P MCUSR bits: 0x01 power-on, 0x02 reset pin, 0x04 brown-out, 0x08 watchdog.
// Measured 13 Nov: a quick power-off/on shows as BROWN-OUT (0x04), and with the MiniCore bootloader a
// reset-pin press shows as WATCHDOG (0x08). So: 0x01 or 0x04 + battery % jump = new batteries;
// 0x04 without a jump = real brown-out (battery nearly empty); 0x08 = node hung and recovered.
static inline void packBootInfo(uint8_t out[BOOT_LEN], uint8_t fwMajor, uint8_t fwMinor,
                                uint8_t resetCause, uint16_t bootCount) {
  out[0] = fwMajor;
  out[1] = fwMinor;
  out[2] = resetCause & 0x0F;
  putU16(&out[3], bootCount);
}

// ---- Node settings + sleep state, changed by downlinks ----
struct NodeState {
  uint8_t  intervalMin;     // 1..240, persisted in EEPROM
  uint8_t  scanSec;         // 5..60,  persisted in EEPROM
  bool     sleeping;        // RAM only: a power-cycle always wakes the node
  uint16_t sleepTotalMin;   // 0 = until woken
  uint16_t sleepLeftMin;    // counted down by the main loop (only meaningful if sleepTotalMin != 0)
  uint8_t  checkinMin;      // 5..255
};

static inline void stateInit(NodeState &s) {
  s.intervalMin = DEFAULT_INTERVAL_MIN;
  s.scanSec = DEFAULT_SCAN_SEC;
  s.sleeping = false;
  s.sleepTotalMin = 0;
  s.sleepLeftMin = 0;
  s.checkinMin = DEFAULT_CHECKIN_MIN;
}

// Effects of a downlink that the main sketch must act on
#define DL_SAVE_SETTINGS 0x01   // write intervalMin / scanSec to EEPROM
#define DL_BLINK         0x02   // run the LED pattern
#define DL_SLEEP_STARTED 0x04
#define DL_WOKE          0x08
#define DL_REBOOT        0x10   // v0.8: restart through the watchdog after this downlink

// Parse one downlink payload (port 1). Out-of-range or malformed commands are ignored.
// Returns a bitmask of DL_* effects.
static inline uint8_t applyDownlink(NodeState &s, const uint8_t *b, size_t len) {
  if (len < 1) return 0;
  switch (b[0]) {
    case 0x01:  // Interval 01 mm, 1..240
      if (len == 2 && b[1] >= 1 && b[1] <= 240) { s.intervalMin = b[1]; return DL_SAVE_SETTINGS; }
      return 0;
    case 0x02:  // Scan time 02 ss, 5..60
      if (len == 2 && b[1] >= 5 && b[1] <= 60) { s.scanSec = b[1]; return DL_SAVE_SETTINGS; }
      return 0;
    case 0x03:  // Blink
      return len == 1 ? DL_BLINK : 0;
    case 0x04: {  // Sleep 04 [hh ll [cc]]
      uint16_t total = 0;
      uint8_t cc = DEFAULT_CHECKIN_MIN;
      if (len == 1) {
        // bare 04: until woken, default check-in
      } else if (len == 3 || len == 4) {
        total = ((uint16_t)b[1] << 8) | b[2];
        if (len == 4) {
          if (b[3] < 5) return 0;   // cc 5..255 (a byte can't exceed 255)
          cc = b[3];
        }
      } else {
        return 0;
      }
      s.sleeping = true;
      s.sleepTotalMin = total;
      s.sleepLeftMin = total;
      s.checkinMin = cc;
      return DL_SLEEP_STARTED;
    }
    case 0x05:  // Wake
      if (len == 1 && s.sleeping) { s.sleeping = false; return DL_WOKE; }
      return 0;
    case 0x06:  // Reboot (v0.8)
      return len == 1 ? DL_REBOOT : 0;
    default:
      return 0;
  }
}

// One sleep period has passed (the node slept min(checkinMin, left) minutes).
// Returns the minutes to put in the port 3 check-in, or -1 if a timed sleep just ended
// (then do NOT send port 3: resume measuring, because 0 would mean "until woken").
static inline int32_t sleepPeriodMinutes(const NodeState &s) {
  if (s.sleepTotalMin == 0) return s.checkinMin;
  return s.sleepLeftMin < s.checkinMin ? s.sleepLeftMin : s.checkinMin;
}

static inline int32_t sleepAfterPeriod(NodeState &s) {
  if (s.sleepTotalMin == 0) return 0;                 // until woken
  uint16_t p = (uint16_t)sleepPeriodMinutes(s);
  s.sleepLeftMin = (s.sleepLeftMin > p) ? (s.sleepLeftMin - p) : 0;
  if (s.sleepLeftMin == 0) { s.sleeping = false; return -1; }
  return s.sleepLeftMin;
}

#endif
