/*
  Roskilde sensor node - firmware v0.8
  Board: Arduino Pro Mini 3.3 V 8 MHz (ATmega328P or 328PB clone)
  Arduino IDE: MiniCore -> Board "ATmega328", Variant 328P or 328PB (check the avrdude signature),
               Clock External 8 MHz, BOD 2.7 V, Bootloader Yes (UART0), upload baud 38400.
               The old Pro Mini bootloader reboot-loops after a watchdog reset: burn the MiniCore one.

  Built on roskilde_node_demo v0.1 (same wiring, same ESP-01 / RN2483 handling).

  Files in this sketch folder
    roskilde_node.ino   main flow (this file)
    config.h            pins, timing, calibration, build switches
    secrets.h           TTN keys for this node  (never share; template: secrets.example.h)
    protocol.h          message packing + downlink rules (tested on a PC, see ../roskilde_node_tests)

  What changed from v0.1
    - Keys moved to secrets.h; Google key removed (it belongs on the server only).
    - Failures send flag AND error value (temp 7F FF, humidity FF, crowd FF FF).
    - Downlinks 04 Sleep / 05 Wake + port 3 check-ins. Interval range 1-240 min.
    - Peak = loudest 125 ms block (same scale as the average) instead of one sample.
    - Battery as in demo v0.1 (folder version): % + rest V + lowest V under ESP load, flag bit 5.
    - Join gives up after 3 tries and sleeps 10 min; port 2 is retried; no_free_ch is retried once.
    - Downlink 02 (scan time) now sets the Wi-Fi scan timeout.

  v0.3 (robustness)
    - 8 s watchdog while awake (paused around the rn2xx3 library calls, which can block longer).
    - Random jitter on the interval and before the first join.
    - Link check: every 6 h one uplink is confirmed; 2 checks without an ack -> rejoin.
    - Reset cause + boot count + firmware version on port 4 after port 2 (BOD fuse check in the log).
    - Mic fault: flag bit 6 when the mic's resting level is far from mid-scale.

  v0.4 (bench tests 13 Nov)
    - Own deep sleep (avr/sleep.h) instead of the Low-Power library (328PB support, fewer libraries).
    - Sleep times are corrected for the watchdog oscillator: it is measured against the crystal
      before every sleep (one board ran ~25 % fast: "8 s" was ~6.1 s).
    - Pin-change wake-ups from the radio's serial line are blocked during sleep.
    - Reset cause with the MiniCore bootloader: a reset-pin press is reported as watchdog (0x08).
      In the field: 0x01 / 0x04 = power lost (new batteries if battery % jumps), 0x08 = hang recovered.

  v0.8 (18 Nov, remote restart)
    - Downlink 06 = reboot: after the uplink that received it, the node restarts through the
      watchdog (reset cause 0x08 on port 4). The next boot sends port 2 (fresh Wi-Fi scan) and port 4.
    - FW_MINOR fixed: v0.7 reported itself as 0.6 on port 4.

  v0.7 (13 Nov, delivery of the once-per-boot messages)
    - Port 2 and port 4 are sent CONFIRMED (up to BOOT_SEND_TRIES attempts, 60 s apart), so the
      server gets location and reset cause even when single uplinks are lost. Port 1 stays unconfirmed.
    - Boot-loop protection (EEPROM address 10): a boot that did not run for BOOT_HEALTHY_MIN minutes
      makes the next boot send port 2/4 unconfirmed, so a node stuck in resets cannot use up the
      downlink budget (TTN fair use: 10 per day).
    - Link check every 8 h instead of 6 h (3 downlinks per day).

  v0.6 (13 Nov, phone counting)
    - ESP-01 runs esp_sniffer.ino (Test_scripts) instead of the AT firmware: it counts nearby phones
      (probe requests / client data frames, salted hashes, nothing identifiable leaves the ESP).
    - Crowd on port 1 = phones (flag 0x01 cleared); flag 0x10 when the ESP's hash list filled up.
    - Sniffing (scan time, default 45 s, downlink 02) runs in parallel with the sound/DHT measurement
      (SNIFF_PARALLEL in config.h). Port 2 at boot uses a scan without sniffing.
    - Interval 10 min. New EEPROM magic: settings reset to the new defaults on first boot.

  v0.5 (13 Nov, coverage tests)
    - LORA_DR in config.h (0 = SF12 ... 5 = SF7). If the library's SF7 join fails, the join is
      retried at LORA_DR; uplinks are then sent at LORA_DR. Set LORA_DR 5 again for deployment.

  Ports: 1 measurement (11 B) | 2 geolocation (1+7n B, every boot) | 3 sleep check-in (3 B) | 4 boot info (5 B)

  Libraries: rn2xx3 (JP Meijers), DHT sensor library (Adafruit) + Adafruit Unified Sensor
  Serial monitor: 9600 baud.
*/

#include <SoftwareSerial.h>
#include <EEPROM.h>
#include <rn2xx3.h>
#include <DHT.h>
#include "config.h"
#include "secrets.h"
#include "protocol.h"

#include <avr/wdt.h>
#include <avr/boot.h>
#if USE_DEEP_SLEEP
#include <avr/sleep.h>
#include <avr/interrupt.h>
#endif

// ------------------------------------------------------------------ reset cause (read before setup)
// The old Pro Mini bootloader leaves MCUSR alone; Optiboot clears it and passes it in r2.
// Both are caught here, and the watchdog is switched off before anything else runs.
uint8_t resetCause __attribute__((section(".noinit")));
uint8_t optibootR2 __attribute__((section(".noinit")));
#ifdef __AVR__
void earlyReset(void) __attribute__((naked, used, section(".init3")));
void earlyReset(void) {
  __asm__ __volatile__("sts %0, r2" : "=m"(optibootR2));
  resetCause = MCUSR;
  MCUSR = 0;
  wdt_disable();
}
#endif

// ------------------------------------------------------------------ objects + state
SoftwareSerial esp(PIN_ESP_RX, PIN_ESP_TX);
SoftwareSerial lora(PIN_LORA_RX, PIN_LORA_TX);
rn2xx3 rn(lora);
DHT dht(PIN_DHT_DATA, DHT22);

NodeState state;               // interval, scan time, sleep mode (protocol.h)

struct Saved { uint8_t magic; uint8_t intervalMin; uint8_t scanSec; };   // same layout as v0.1
const uint8_t CFG_MAGIC = 0xA6;   // v0.6: new defaults (10 min, 45 s sniff) replace stored values once

Ap aps[MAX_APS];
uint8_t apCount = 0;
uint16_t netsSeen = 0;

uint16_t minutesSinceLinkCheck = 0;
uint8_t linkMisses = 0;
bool lastTxNoAck = false;      // set when a confirmed uplink got no ack (mac_err)

uint8_t dl[16];                // last downlink payload
uint8_t dlLen = 0;
uint8_t dlPort = 0;
bool loraAsleep = false;

// Battery tracking during the ESP-01 phase (lowest raw ADC value seen)
bool battTrack = false;
uint16_t battMinRaw = 1023;
unsigned long battLastMs = 0;

void battSample();   // defined further down; used while waiting for the ESP

// ================================================================== watchdog

void wdtOn() {
#if USE_WATCHDOG
  wdt_enable(WDTO_8S);
#endif
}
void wdtOff() {
#if USE_WATCHDOG
  wdt_disable();
#endif
}
void wdtKick() {
#if USE_WATCHDOG
  wdt_reset();
#endif
}

// delay() that keeps the watchdog fed (use for anything longer than a second or two)
void safeDelay(unsigned long ms) {
  unsigned long t0 = millis();
  while (millis() - t0 < ms) { wdtKick(); delay(50); }
}

// Random seconds in [-JITTER_S, +JITTER_S]
long jitterMs() {
  return (random(0, 2 * JITTER_S + 1) - JITTER_S) * 1000L;
}

// ================================================================== helpers

// Read one line (CR/LF stripped) into buf. Returns length, or -1 on timeout.
int readLine(Stream &s, char *buf, uint8_t size, unsigned long timeoutMs) {
  uint8_t i = 0;
  unsigned long t0 = millis();
  while (millis() - t0 < timeoutMs) {
    wdtKick();
    if (!s.available()) {
      battSample();                  // no-op unless the ESP phase is being tracked
      continue;
    }
    char c = s.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (i == 0) continue;
      buf[i] = 0;
      return i;
    }
    if (i < size - 1) buf[i++] = c;
  }
  buf[i] = 0;
  return -1;
}

bool isHexChar(char c) {
  return (c >= '0' && c <= '9') || ((c | 0x20) >= 'a' && (c | 0x20) <= 'f');
}

uint8_t hexVal(char c) {
  return (c <= '9') ? c - '0' : (c | 0x20) - 'a' + 10;
}

void printHex(const uint8_t *b, uint8_t n) {
  for (uint8_t i = 0; i < n; i++) {
    if (b[i] < 16) Serial.print('0');
    Serial.print(b[i], HEX);
    Serial.print(' ');
  }
  Serial.println();
}

void blinkLed() {
  // Downlink 0x03: on 200 ms, off 200 ms, on 200 ms (as in the protocol file)
  digitalWrite(PIN_LED, HIGH); delay(200);
  digitalWrite(PIN_LED, LOW);  delay(200);
  digitalWrite(PIN_LED, HIGH); delay(200);
  digitalWrite(PIN_LED, LOW);
}

#if USE_DEEP_SLEEP
// ---- deep sleep with the watchdog as timer (interrupt mode, no reset) ----
// The watchdog runs on its own ~128 kHz oscillator, which can be 25 % or more off.
// wdtMeasure() times a nominal 500 ms period against millis() (crystal) so sleeps come out right.
volatile bool wdtFired = false;
ISR(WDT_vect) { wdtFired = true; }

const uint8_t WDT_INT_8S   = _BV(WDIE) | _BV(WDP3) | _BV(WDP0);
const uint8_t WDT_INT_1S   = _BV(WDIE) | _BV(WDP2) | _BV(WDP1);
const uint8_t WDT_INT_500M = _BV(WDIE) | _BV(WDP2) | _BV(WDP0);

void wdtStartInterrupt(uint8_t bits) {
  cli();
  wdt_reset();
  MCUSR &= ~_BV(WDRF);
  WDTCSR = _BV(WDCE) | _BV(WDE);               // timed sequence
  WDTCSR = bits;                               // interrupt only, WDE = 0
  wdtFired = false;
  sei();
}

// Real length in ms of a nominal 500 ms watchdog period (falls back to 500 if implausible)
uint16_t wdtMeasure() {
  wdtStartInterrupt(WDT_INT_500M);
  unsigned long t0 = millis();
  while (!wdtFired && millis() - t0 < 2000) { }
  unsigned long dt = millis() - t0;
  wdt_disable();
  return (dt >= 250 && dt <= 1000) ? (uint16_t)dt : 500;
}

void powerDownFor(uint8_t bits) {
  wdtStartInterrupt(bits);
  ADCSRA &= ~_BV(ADEN);                        // ADC off (~100 uA)
  set_sleep_mode(SLEEP_MODE_PWR_DOWN);
  cli();
  sleep_enable();
#if defined(BODS) && defined(BODSE)
  sleep_bod_disable();                         // brown-out detector off while asleep
#endif
  sei();
  sleep_cpu();                                 // wakes on the watchdog interrupt
  sleep_disable();
  ADCSRA |= _BV(ADEN);
}
#endif

// MCU sleep (or delay while debugging). millis() does not advance in deep sleep.
void sleepMs(unsigned long ms) {
  Serial.flush();
#if USE_DEEP_SLEEP
  wdtOff();
  if (lora.isListening()) lora.stopListening();   // radio's "ok" must not wake us early
  if (esp.isListening()) esp.stopListening();
  uint16_t half = wdtMeasure();                // real ms per nominal 500 ms
  unsigned long p8 = (unsigned long)half * 16;  // real ms per "8 s"
  unsigned long p1 = (unsigned long)half * 2;   // real ms per "1 s"
  if (ms > half) ms -= half;                   // the measurement itself took that long
  else ms = 0;
  while (ms >= p8) { powerDownFor(WDT_INT_8S); if (wdtFired) ms -= p8; }
  while (ms >= p1) { powerDownFor(WDT_INT_1S); if (wdtFired) ms -= p1; }
  wdt_disable();
  wdtOn();
  if (ms) safeDelay(ms);                       // last part below 1 s
#else
  safeDelay(ms);
#endif
}

// ================================================================== settings (EEPROM)

void saveSettings() {
  Saved s = { CFG_MAGIC, state.intervalMin, state.scanSec };
  EEPROM.put(0, s);   // put() only rewrites bytes that changed
}

void loadSettings() {
  stateInit(state);
  state.intervalMin = NODE_DEFAULT_INTERVAL_MIN;
  state.scanSec = NODE_DEFAULT_SCAN_S;
  Saved s;
  EEPROM.get(0, s);
  if (s.magic == CFG_MAGIC && s.intervalMin >= 1 && s.intervalMin <= 240 &&
      s.scanSec >= 5 && s.scanSec <= 60) {
    state.intervalMin = s.intervalMin;
    state.scanSec = s.scanSec;
  } else {
    saveSettings();
  }
}

// ================================================================== battery

uint16_t battVccMv = 3300;      // supply voltage at the last battUseRef() (VCC reference only)

// Supply voltage in mV, measured by reading the internal 1.1 V bandgap against VCC
uint16_t readVccMv() {
#ifdef __AVR__
  ADMUX = _BV(REFS0) | _BV(MUX3) | _BV(MUX2) | _BV(MUX1);   // reference AVcc, input = 1.1 V bandgap
  delay(2);                                                  // let the bandgap settle
  for (uint8_t i = 0; i < 2; i++) {                          // first conversion is thrown away
    ADCSRA |= _BV(ADSC);
    while (bit_is_set(ADCSRA, ADSC)) { }
  }
  uint16_t r = ADC;
  if (r == 0) return 3300;
  return (uint16_t)(1125300UL / r);                          // 1.1 V x 1023 x 1000
#else
  return 3300;
#endif
}

// Raw ADC reading on A1 -> battery millivolts
uint16_t battRawToMv(uint16_t raw) {
#if BATT_USE_INTERNAL_REF
  float v = raw * (1.1f / 1023.0f) * BATT_DIVIDER * BATT_CAL;
#else
  float v = raw * (battVccMv / 1023000.0f) * BATT_DIVIDER * BATT_CAL;
#endif
  return (uint16_t)(v * 1000.0f);
}

// Select the battery reference. With the VCC reference the supply is measured first, so readings
// stay right below ~3.5 V battery, where the regulator drops out and VCC falls with the cells.
void battUseRef() {
#if BATT_USE_INTERNAL_REF
  analogReference(INTERNAL);
  analogRead(PIN_BATT);                 // reference switches on this read
  delay(5);                             // let it settle
  analogRead(PIN_BATT);
#else
  analogReference(DEFAULT);
  analogRead(PIN_BATT);
  battVccMv = readVccMv();
  analogRead(PIN_BATT);                 // back on A1; the 100 nF holds the divider voltage
  delay(2);
  analogRead(PIN_BATT);
#endif
}

// Battery voltage with nothing big switched on
uint16_t battRestMv() {
  battUseRef();
  uint32_t s = 0;
  for (uint8_t i = 0; i < 16; i++) s += analogRead(PIN_BATT);
  return battRawToMv(s / 16);
}

// Start / stop tracking the lowest voltage while the ESP-01 is on
void battTrackStart() {
  battUseRef();
  battMinRaw = 1023;
  battLastMs = 0;
  battTrack = true;
}

uint16_t battTrackStop() {
  battTrack = false;
  return battRawToMv(battMinRaw);
}

void battSample() {
  if (!battTrack || millis() - battLastMs < 20) return;
  battLastMs = millis();
  uint16_t r = analogRead(PIN_BATT);
  if (r < battMinRaw) battMinRaw = r;
}

// ================================================================== ESP-01 (sniffer firmware, v0.6)
// The ESP-01 runs esp_sniffer.ino. After power-up it prints RDY, takes "S<seconds>" (0 = scan only),
// sniffs on its own, then prints PH / RN / NW / AP / NF lines and END (see esp_sniffer.ino).

uint16_t phonesSeen = 0;
bool hashFull = false;

// Power the ESP and tell it how long to sniff. Returns false if it never said RDY.
bool espOn(uint8_t sniffSec) {
  digitalWrite(PIN_ESP_PWR, HIGH);   // power first, then drive the data line
  pinMode(PIN_ESP_TX, OUTPUT);       // SoftwareSerial only sets this in its constructor,
  digitalWrite(PIN_ESP_TX, HIGH);    // so restore it after espOff() made it an input
  esp.begin(9600);
  esp.listen();
  char line[24];
  unsigned long t0 = millis();       // boot text at 74880 baud comes first and is skipped
  while (millis() - t0 < 4000) {
    if (readLine(esp, line, sizeof line, 4000 - (millis() - t0)) < 0) break;
    if (strstr(line, "RDY")) {
      esp.print('S');
      esp.print(sniffSec);
      esp.print(F("\r\n"));
      return true;
    }
  }
  Serial.println(F("ESP: no RDY (sniffer firmware flashed?)"));
  return false;
}

void espOff() {
  esp.end();
  pinMode(PIN_ESP_TX, INPUT);        // no data line may feed the unpowered ESP
  digitalWrite(PIN_ESP_TX, LOW);
  pinMode(PIN_ESP_RX, INPUT);        // also removes the SoftwareSerial pull-up
  digitalWrite(PIN_ESP_RX, LOW);
  digitalWrite(PIN_ESP_PWR, LOW);
}

// Keep the 5 strongest APs, sorted by RSSI
void insertAp(const Ap &ap) {
  uint8_t pos = apCount;
  while (pos > 0 && aps[pos - 1].rssi < ap.rssi) pos--;
  if (pos >= MAX_APS) return;
  uint8_t last = (apCount < MAX_APS) ? apCount : MAX_APS - 1;
  for (uint8_t i = last; i > pos; i--) aps[i] = aps[i - 1];
  aps[pos] = ap;
  if (apCount < MAX_APS) apCount++;
}

// Wait for the ESP's result (sniff time + scan). Returns true if a phone count (PH) arrived.
bool espCollect(uint8_t sniffSec) {
  apCount = 0;
  netsSeen = 0;
  phonesSeen = 0;
  hashFull = false;
  bool gotPh = false;
  esp.listen();
  char line[40];
  const unsigned long timeout = (unsigned long)sniffSec * 1000UL + 20000UL;   // + scan + margin
  unsigned long t0 = millis();
  while (true) {
    unsigned long el = millis() - t0;
    if (el >= timeout) { Serial.println(F("ESP: timeout")); break; }
    if (readLine(esp, line, sizeof line, timeout - el) < 0) continue;
    if (!strcmp(line, "END")) break;
    if (!strncmp(line, "PH ", 3)) { phonesSeen = atoi(line + 3); gotPh = true; }
    else if (!strncmp(line, "NW ", 3)) netsSeen = atoi(line + 3);
    else if (!strcmp(line, "NF")) hashFull = true;
    else if (!strncmp(line, "RN ", 3)) { Serial.print(F("  random MACs: ")); Serial.println(line + 3); }
    else if (!strncmp(line, "AP ", 3) && strlen(line) >= 16) {
      const char *h = line + 3;
      Ap ap;
      bool ok = true;
      for (uint8_t b = 0; b < 6; b++) {
        if (!isHexChar(h[2 * b]) || !isHexChar(h[2 * b + 1])) { ok = false; break; }
        ap.bssid[b] = (hexVal(h[2 * b]) << 4) | hexVal(h[2 * b + 1]);
      }
      if (ok) { ap.rssi = (int8_t)atoi(h + 13); insertAp(ap); }
    }
  }
  return gotPh;
}

void printAps() {
  Serial.print(F("Networks seen: "));
  Serial.println(netsSeen);
  for (uint8_t i = 0; i < apCount; i++) {
    Serial.print(F("  "));
    for (uint8_t b = 0; b < 6; b++) {
      if (aps[i].bssid[b] < 16) Serial.print('0');
      Serial.print(aps[i].bssid[b], HEX);
      if (b < 5) Serial.print(':');
    }
    Serial.print(F("  "));
    Serial.print(aps[i].rssi);
    Serial.println(F(" dBm"));
  }
}

// ================================================================== RN2483

// OTAA join by hand at LORA_DR (the keys are already set by rn.initOTAA). SF12 join: ~1.5 s TX + 5-6 s wait.
bool loraJoinAtDr() {
  char line[40];
  while (lora.available()) lora.read();
  lora.print(F("mac set dr "));
  lora.print(LORA_DR);
  lora.print(F("\r\n"));
  readLine(lora, line, sizeof line, 2000);
  lora.print(F("mac join otaa\r\n"));
  if (readLine(lora, line, sizeof line, 3000) < 0 || strcmp(line, "ok")) {
    Serial.print(F("RN2483: "));
    Serial.println(line);                      // e.g. no_free_ch (duty cycle) or keys_not_init
    return false;
  }
  if (readLine(lora, line, sizeof line, 20000) < 0) return false;
  return !strcmp(line, "accepted");            // "denied" = no join accept heard
}

// Try to join up to `tries` times. Returns false instead of looping forever (saves battery).
bool loraJoin(uint8_t tries) {
  for (uint8_t i = 0; i < tries; i++) {
    Serial.println(F("Joining TTN (SF7)..."));
    wdtOff();                                  // the library can block longer than 8 s
    bool ok = rn.initOTAA(TTN_APP_EUI, TTN_APP_KEY, TTN_DEV_EUI);
    wdtOn();
#if LORA_DR < 5
    if (!ok) {
      Serial.print(F("Joining TTN (SF"));
      Serial.print(12 - LORA_DR);
      Serial.println(F(")..."));
      ok = loraJoinAtDr();
    }
#endif
    if (ok) {
      wdtOff();
      rn.sendRawCommand(F("mac set retx 1"));                   // confirmed link checks: max 1 retry
      rn.sendRawCommand("mac set dr " + String(LORA_DR));      // uplinks at LORA_DR (ADR off)
      wdtOn();
      Serial.print(F("Joined TTN, uplinks at SF"));
      Serial.println(12 - LORA_DR);
      linkMisses = 0;
      return true;
    }
    Serial.println(F("Join failed. Check keys, antenna and gateway coverage."));
    if (i + 1 < tries) safeDelay(30000);
  }
  return false;
}

void loraInit() {
  lora.begin(9600);
  lora.listen();
  pinMode(PIN_LORA_RST, OUTPUT);
  digitalWrite(PIN_LORA_RST, LOW);
  delay(500);
  digitalWrite(PIN_LORA_RST, HIGH);
  delay(100);
  lora.flush();
  wdtOff();
  rn.autobaud();                                   // switch RN2483 to 9600 baud
  String hw = rn.hweui();
  while (hw.length() != 16) {
    Serial.println(F("No answer from RN2483. Check D10/D11 wiring and power."));
    delay(5000);
    rn.autobaud();
    hw = rn.hweui();
  }
  Serial.print(F("RN2483 hweui: "));
  Serial.println(hw);
  Serial.print(F("RN2483 firmware: "));
  Serial.println(rn.sysver());
  wdtOn();
}

void loraWake() {
  if (!loraAsleep) return;
  lora.listen();
  digitalWrite(PIN_LORA_TX, LOW);   // break condition wakes the module
  delay(20);
  digitalWrite(PIN_LORA_TX, HIGH);
  delay(5);
  wdtOff();
  rn.autobaud();
  wdtOn();
  loraAsleep = false;
}

void loraSleep(unsigned long ms) {
  rn.sleep(ms);
  loraAsleep = true;
}

// Send bytes on a port. Returns 0 = sent, 1 = sent and a downlink arrived, -1 = error.
// confirmed = true asks the network for an ack (link check); no ack -> -1 and lastTxNoAck.
int8_t loraSend(uint8_t port, const uint8_t *data, uint8_t len, bool confirmed) {
  lastTxNoAck = false;
  loraWake();
  lora.listen();
  Serial.print(F("TX port "));
  Serial.print(port);
  Serial.print(F(": "));
  printHex(data, len);
  char line[80];
  for (uint8_t attempt = 0; attempt < 2; attempt++) {
    while (lora.available()) lora.read();
    lora.print(confirmed ? F("mac tx cnf ") : F("mac tx uncnf "));
    lora.print(port);
    lora.print(' ');
    for (uint8_t i = 0; i < len; i++) {
      if (data[i] < 16) lora.print('0');
      lora.print(data[i], HEX);
    }
    lora.print(F("\r\n"));

    if (readLine(lora, line, sizeof line, 3000) < 0) {
      Serial.println(F("RN2483: no reply to mac tx"));
      return -1;
    }
    if (!strcmp(line, "not_joined") || !strcmp(line, "frame_counter_err_rejoin_needed")) {
      Serial.println(F("RN2483: not joined, rejoining"));
      if (!loraJoin(1)) return -1;
      continue;
    }
    if (!strcmp(line, "no_free_ch") || !strcmp(line, "busy")) {
      Serial.println(F("RN2483: duty cycle / busy, retrying in 10 s"));
      safeDelay(10000);
      continue;
    }
    if (strcmp(line, "ok")) {
      Serial.print(F("RN2483: "));
      Serial.println(line);           // e.g. invalid_data_len
      return -1;
    }
    // Second reply comes after TX and both receive windows
    if (readLine(lora, line, sizeof line, 30000) < 0) {
      Serial.println(F("RN2483: no TX result"));
      return -1;
    }
    if (!strcmp(line, "mac_tx_ok")) return 0;
    if (!strncmp(line, "mac_rx ", 7)) {
      dlPort = atoi(line + 7);
      const char *h = strchr(line + 7, ' ');
      dlLen = 0;
      if (h) {
        h++;
        while (isHexChar(h[0]) && isHexChar(h[1]) && dlLen < sizeof dl) {
          dl[dlLen++] = (hexVal(h[0]) << 4) | hexVal(h[1]);
          h += 2;
        }
      }
      return 1;
    }
    if (confirmed && !strcmp(line, "mac_err")) lastTxNoAck = true;   // no ack from the network
    Serial.print(F("RN2483: "));
    Serial.println(line);             // e.g. mac_err
    return -1;
  }
  return -1;
}

// Every uplink goes through here: every LINK_CHECK_EVERY_MIN one is sent confirmed.
// Two link checks in a row without an ack -> rejoin (gateway gone, session lost).
int8_t sendUplink(uint8_t port, const uint8_t *data, uint8_t len) {
  bool check = minutesSinceLinkCheck >= LINK_CHECK_EVERY_MIN;
  int8_t r = loraSend(port, data, len, check);
  if (check) {
    minutesSinceLinkCheck = 0;
    if (r >= 0) {
      linkMisses = 0;
      Serial.println(F("Link check: ack received"));
    } else if (lastTxNoAck) {
      linkMisses++;
      Serial.print(F("Link check: no ack ("));
      Serial.print(linkMisses);
      Serial.println(F(")"));
      if (linkMisses >= LINK_MISSES_REJOIN) {
        Serial.println(F("Link lost, rejoining"));
        loraJoin(3);                           // if this fails, the next mac tx says not_joined
      }
    }
  }
  return r;
}

// Downlink rules live in protocol.h (applyDownlink); this only acts on the result.
void handleDownlink() {
  Serial.print(F("Downlink on port "));
  Serial.print(dlPort);
  Serial.print(F(": "));
  printHex(dl, dlLen);
  if (dlPort != 1) return;
  uint8_t fx = applyDownlink(state, dl, dlLen);
  if (fx == 0) {
    Serial.println(F("Ignored (unknown, wrong length or out of range)"));
    return;
  }
  if (fx & DL_SAVE_SETTINGS) {
    saveSettings();
    Serial.print(F("Interval "));
    Serial.print(state.intervalMin);
    Serial.print(F(" min, scan "));
    Serial.print(state.scanSec);
    Serial.println(F(" s (saved)"));
  }
  if (fx & DL_BLINK) {
    Serial.println(F("Blink command"));
    blinkLed();
  }
  if (fx & DL_SLEEP_STARTED) {
    Serial.print(F("Sleep: "));
    if (state.sleepTotalMin == 0) Serial.print(F("until woken"));
    else { Serial.print(state.sleepTotalMin); Serial.print(F(" min")); }
    Serial.print(F(", check-in every "));
    Serial.print(state.checkinMin);
    Serial.println(F(" min"));
  }
  if (fx & DL_WOKE) Serial.println(F("Wake: resuming measurements"));
  if (fx & DL_REBOOT) {                        // last, so other effects of this downlink are done
    Serial.println(F("Reboot command: restarting through the watchdog"));
    Serial.flush();
    wdt_enable(WDTO_15MS);                     // system reset mode (also clears interrupt mode)
    for (;;) {}
  }
}

// ================================================================== sensors

// 10 s window: Leq + peak (loudest 125 ms block), DHT22 at 1.5, 3.5, 5.5, 7.5, 9.5 s
void measure(Measurement &m) {
  analogReference(DEFAULT);                    // mic uses the 3.3 V reference
  analogRead(PIN_MIC);
  digitalWrite(PIN_MIC_PWR, HIGH);
  digitalWrite(PIN_DHT_PWR, HIGH);
  dht.begin();
  delay(MIC_SETTLE_MS);                        // mic starts near 3.3 V and needs ~2 s to reach VCC/2

  uint32_t s = 0;                              // estimate the DC offset (about 512 counts)
  for (uint16_t i = 0; i < 256; i++) s += analogRead(PIN_MIC);
  int16_t dc0 = s >> 8;
  m.micFault = (dc0 < MIC_DC_MIN || dc0 > MIC_DC_MAX);   // broken mic, wire or power pin

  uint32_t n = 0;                              // whole window
  int32_t sumD = 0;
  uint64_t sumD2 = 0;
  uint16_t bn = 0;                             // current 125 ms block
  int32_t bSum = 0;
  uint32_t bSum2 = 0;
  float peakMs = 0;                            // largest block mean-square
  uint16_t blocks = 0;
  bool clipped = false;
  int32_t tSum = 0;
  uint16_t hSum = 0;
  uint8_t dhtOk = 0;

  unsigned long t0 = millis();
  unsigned long blockEnd = PEAK_BLOCK_MS;
  unsigned long nextDht = 1500;
  while (true) {
    unsigned long el = millis() - t0;
    if (el >= SOUND_WINDOW_MS) break;
    wdtKick();
    battSample();                              // no-op unless the ESP is on (parallel sniffing)

    int16_t x = analogRead(PIN_MIC);
    if (x <= 2 || x >= 1021) clipped = true;
    int16_t d = x - dc0;
    uint32_t d2 = (uint32_t)((int32_t)d * d);
    sumD += d;  sumD2 += d2;  n++;
    bSum += d;  bSum2 += d2;  bn++;

    if (el >= blockEnd) {                      // close the block: its own mean-square (DC removed)
      if (bn > 0) {
        float bm = (float)bSum / bn;
        float bms = (float)bSum2 / bn - bm * bm;
        if (bms > peakMs) peakMs = bms;
        blocks++;
      }
      bn = 0; bSum = 0; bSum2 = 0;
      blockEnd += PEAK_BLOCK_MS;
    }

    if (el >= nextDht) {
      nextDht += 2000;
      float t = dht.readTemperature();
      float h = dht.readHumidity();
      if (!isnan(t) && !isnan(h)) {
        tSum += (int32_t)lround(t * 10.0f);
        hSum += (uint16_t)lround(h);
        dhtOk++;
      }
    }
  }

  // sensors off; no pin may feed the DHT22 through DATA
  digitalWrite(PIN_MIC_PWR, LOW);
  digitalWrite(PIN_DHT_PWR, LOW);
  pinMode(PIN_DHT_DATA, INPUT);
  digitalWrite(PIN_DHT_DATA, LOW);

  // variance = mean of squares - square of mean (DC removed exactly)
  float meanD = (float)sumD / n;
  float ms = (float)sumD2 / n - meanD * meanD;
  if (ms < 0.25f) ms = 0.25f;                  // floor (0.5 counts rms), avoids log(0)
  if (peakMs < ms) peakMs = ms;                // the loudest block can't be quieter than the average

  m.avgDb = 10.0f * log10(ms) + CAL_OFFSET_DB;       // 10*log10(mean square) = 20*log10(rms)
  m.peakDb = 10.0f * log10(peakMs) + CAL_OFFSET_DB;
  m.micClipped = clipped;
  m.dhtOk = dhtOk > 0;
  m.tempC = m.dhtOk ? (tSum / 10.0f) / dhtOk : 0;
  m.humidity = m.dhtOk ? (float)hSum / dhtOk : 0;

  Serial.print(F("Samples: "));
  Serial.print(n);
  Serial.print(F("  Blocks: "));
  Serial.print(blocks);
  Serial.print(F("  DC: "));
  Serial.print(dc0);
  if (m.micFault) Serial.print(F(" MIC FAULT"));
  Serial.print(F("  RMS counts: "));
  Serial.println(sqrt(ms), 2);
  Serial.print(F("Leq "));
  Serial.print(m.avgDb, 1);
  Serial.print(F(" dB  Peak (125 ms) "));
  Serial.print(m.peakDb, 1);
  Serial.print(clipped ? F(" dB CLIPPED  T ") : F(" dB  T "));
  Serial.print(m.tempC, 1);
  Serial.print(F(" C  RH "));
  Serial.print(m.humidity, 0);
  Serial.print(F(" %  (DHT reads ok: "));
  Serial.print(dhtOk);
  Serial.println(')');
}

// ================================================================== messages

// ---- once-per-boot messages (port 2, port 4) ----
bool bootConfirmed = true;          // false if the previous boot never ran for BOOT_HEALTHY_MIN
uint16_t minutesSinceBoot = 0;
bool bootProven = false;

void loraSetRetx(uint8_t n) {
  wdtOff();
  rn.sendRawCommand("mac set retx " + String(n));
  wdtOn();
}

// Confirmed (if bootConfirmed) with up to BOOT_SEND_TRIES attempts. The RN2483's own retries are
// switched off meanwhile, so each attempt is exactly one transmission.
int8_t sendImportant(uint8_t port, const uint8_t *data, uint8_t len) {
  bool cnf = bootConfirmed;
  if (cnf) loraSetRetx(0);
  int8_t r = -1;
  for (uint8_t attempt = 0; attempt < BOOT_SEND_TRIES; attempt++) {
    r = loraSend(port, data, len, cnf);
    if (r >= 0) {
      if (cnf) Serial.println(F("  acknowledged by the network"));
      break;
    }
    if (attempt + 1 < BOOT_SEND_TRIES) {
      Serial.println(cnf ? F("  no ack, retrying in 60 s") : F("  failed, retrying in 60 s"));
      safeDelay(60000);                          // also lets the duty-cycle limit clear (SF12)
    }
  }
  if (cnf) loraSetRetx(1);                       // back to 1 retry for the link checks
  return r;
}

// EEPROM address 10: BOOT_UNPROVEN while this boot has not yet run for BOOT_HEALTHY_MIN minutes
const int EE_BOOT_FLAG = 10;
const uint8_t BOOT_UNPROVEN = 0x5A;

void bootGuardStart() {
  bootConfirmed = EEPROM.read(EE_BOOT_FLAG) != BOOT_UNPROVEN;
  EEPROM.update(EE_BOOT_FLAG, BOOT_UNPROVEN);
  Serial.println(bootConfirmed ? F("Port 2/4: confirmed")
                               : F("Port 2/4: unconfirmed (last boot ran < 1 h: possible boot loop)"));
}

void bootGuardTick(uint16_t minutes) {
  if (bootProven) return;
  minutesSinceBoot += minutes;
  if (minutesSinceBoot >= BOOT_HEALTHY_MIN) {
    EEPROM.update(EE_BOOT_FLAG, 0x00);
    bootProven = true;
    Serial.println(F("Boot proven healthy: next boot sends port 2/4 confirmed"));
  }
}

void sendLocation() {           // every power-up; the server uses it to start the battery estimate
  Serial.println(F("--- Geolocation scan ---"));
  bool ok = espOn(0) && espCollect(0);          // S0: network scan only, no sniffing
  espOff();
  if (!ok) {
    Serial.println(F("Wi-Fi scan failed, sending 00"));
    apCount = 0;
  }
  printAps();

  uint8_t p[GEO_MAX_LEN];
  uint8_t k = packGeolocation(p, aps, apCount);
  int8_t r = sendImportant(PORT_GEOLOCATION, p, k);
  Serial.println(r >= 0 ? F("Port 2 sent") : F("Port 2 failed"));
  if (r == 1) handleDownlink();
}

// Port 4: firmware version, reset cause, boot count (once per boot, after port 2)
void sendBootInfo(uint8_t cause, uint16_t bootCount) {
  uint8_t p[BOOT_LEN];
  packBootInfo(p, FW_MAJOR, FW_MINOR, cause, bootCount);
  int8_t r = sendImportant(PORT_BOOT, p, BOOT_LEN);
  Serial.println(r >= 0 ? F("Port 4 sent") : F("Port 4 failed"));
  if (r == 1) handleDownlink();
}

// Boot count in EEPROM (address 8, after the settings)
uint16_t bumpBootCount() {
  uint16_t n;
  EEPROM.get(8, n);
  if (n == 0xFFFF) n = 0;                      // blank EEPROM
  n++;
  EEPROM.put(8, n);
  return n;
}

// With the MiniCore bootloader a reset-pin press (or an upload) shows as WATCHDOG,
// because the bootloader leaves through a watchdog reset. Power loss shows as power-on or BROWN-OUT.
void printResetCause(uint8_t c) {
  Serial.print(F("Reset cause:"));
  if (c & 0x01) Serial.print(F(" power-on"));
  if (c & 0x02) Serial.print(F(" reset-pin"));
  if (c & 0x04) Serial.print(F(" BROWN-OUT"));
  if (c & 0x08) Serial.print(F(" WATCHDOG"));
  if (!(c & 0x0F)) Serial.print(F(" unknown"));
  Serial.println();
#ifdef __AVR__
  uint8_t efuse = boot_lock_fuse_bits_get(GET_EXTENDED_FUSE_BITS) & 0x07;   // BODLEVEL bits
  Serial.print(F("BOD fuse: "));
  if (efuse == 0x05) Serial.println(F("2.7 V (ok)"));
  else if (efuse == 0x07) Serial.println(F("OFF - set extended fuse to 0xFD for brown-out reset at 2.7 V"));
  else { Serial.print(F("level code ")); Serial.println(efuse); }
#endif
}

#if SELF_TEST
void selfTest() {
  Serial.println(F("--- Self-test, compare with the protocol file ---"));
  Measurement t[4] = {
    // first 8 bytes = the shared test vectors; the last 3 (5E 86 7B) = 94 %, 4.68 V rest, 4.46 V ESP load
    { 62.0f,  87.0f, false, true, 26, true, true,  21.6f, 41, 4680, 4460, false },  // 7C AE 00 1A 00 D8 29 01 5E 86 7B
    { 48.0f,  66.5f, false, true, 12, true, true,  -4.0f, 88, 4680, 4460, false },  // 60 85 00 0C FF D8 58 01 ...
    { 120.0f, 127.5f, true, true, 40, true, true,  15.3f, 60, 4680, 4460, false },  // F0 FF 00 28 00 99 3C 05 ...
    { 55.5f,  70.0f, false, false, 0, true, false,  0.0f,  0, 4680, 4460, false },  // 6F 8C FF FF 7F FF FF 0B ...
  };
  uint8_t p[MEASUREMENT_LEN];
  for (uint8_t i = 0; i < 4; i++) { packMeasurement(p, t[i]); printHex(p, MEASUREMENT_LEN); }
}
#endif

// ================================================================== cycles

// Normal cycle: measure, scan, send port 1, then sleep for the rest of the interval
void measurementCycle() {
  unsigned long cycleStart = millis();
  Serial.println(F("--- Measurement cycle ---"));
  const uint8_t sniffSec = state.scanSec;       // downlink 02 sets this (5..60 s)

  Measurement m;
  m.battRestMv = battRestMv();                 // before the ESP-01 switches on
  battTrackStart();
#if SNIFF_PARALLEL
  bool espUp = espOn(sniffSec);                // ESP sniffs on its own ...
  measure(m);                                  // ... while the Pro Mini measures sound + DHT22
#else
  measure(m);                                  // sound first, then the ESP (no ESP noise on the mic)
  battTrackStart();
  bool espUp = espOn(sniffSec);
#endif
  bool ok = espUp && espCollect(sniffSec);
  m.battLoadMv = battTrackStop();              // lowest voltage while the ESP-01 was on
  espOff();

  Serial.print(F("Phones nearby: "));
  Serial.print(phonesSeen);
  Serial.println(hashFull ? F(" (list full: lower bound)") : F(""));
  printAps();
  Serial.print(F("Battery rest "));
  Serial.print(m.battRestMv);
  Serial.print(F(" mV (VCC "));
  Serial.print(battVccMv);
  Serial.print(F(" mV, "));
  Serial.print(battPercent(m.battRestMv));
  Serial.print(F(" %), lowest during ESP "));
  Serial.print(m.battLoadMv);
  Serial.println(m.battLoadMv < WIFI_WARN_MV ? F(" mV  -> Wi-Fi at risk (flag bit 5)") : F(" mV"));
  m.crowdValid = ok;
  m.crowd = phonesSeen;                        // unique Wi-Fi devices (phones) nearby
  m.crowdIsNetworks = false;
  m.hashListFull = hashFull;

  uint8_t p[MEASUREMENT_LEN];
  packMeasurement(p, m);
  int8_t r = sendUplink(PORT_MEASUREMENT, p, MEASUREMENT_LEN);
  Serial.println(r >= 0 ? F("Port 1 sent") : F("Port 1 failed"));
  if (r == 1) handleDownlink();

  if (state.sleeping) return;                  // a Sleep downlink just arrived: start sleeping now

  minutesSinceLinkCheck += state.intervalMin;
  bootGuardTick(state.intervalMin);

  long intervalMs = (long)state.intervalMin * 60000L + jitterMs();   // +- JITTER_S
  long used = (long)(millis() - cycleStart);
  unsigned long rest = (used < intervalMs) ? (unsigned long)(intervalMs - used) : 0;
  loraSleep(rest + 60000UL);                   // longer than us; we wake it with a break
  Serial.print(F("Sleeping "));
  Serial.print(rest / 1000);
  Serial.println(F(" s"));
  sleepMs(rest);
}

// Sleep mode (downlink 04): no measurements, only a port 3 check-in every checkinMin minutes
void sleepCycle() {
  uint16_t periodMin = (uint16_t)sleepPeriodMinutes(state);
  unsigned long periodMs = (unsigned long)periodMin * 60000UL;
  Serial.print(F("--- Paused, next check-in in "));
  Serial.print(periodMin);
  Serial.println(F(" min ---"));
  loraSleep(periodMs + 60000UL);
  sleepMs(periodMs);
  minutesSinceLinkCheck += periodMin;
  bootGuardTick(periodMin);

  int32_t left = sleepAfterPeriod(state);
  if (left < 0) {                              // timed sleep is over: measure right away, no check-in
    Serial.println(F("Timed sleep over, resuming measurements"));
    return;
  }
  uint16_t restMv = battRestMv();
  Serial.print(F("Battery rest "));
  Serial.print(restMv);
  Serial.println(F(" mV"));

  uint8_t p[CHECKIN_LEN];
  packSleepCheckin(p, (uint16_t)left, restMv); // minutes left (0 = until woken) + battery %
  int8_t r = sendUplink(PORT_SLEEP, p, CHECKIN_LEN);
  Serial.println(r >= 0 ? F("Port 3 sent") : F("Port 3 failed"));
  if (r == 1) handleDownlink();                // Wake (05) here clears state.sleeping
}

// ================================================================== main

void setup() {
  uint8_t cause = resetCause & 0x0F;
  if (!cause) cause = optibootR2 & 0x0F;       // Optiboot cleared MCUSR and passed it in r2
  wdtOff();

  // Safe pin states first: ESP off, no data line high, sensors off
  pinMode(PIN_ESP_PWR, OUTPUT);
  digitalWrite(PIN_ESP_PWR, LOW);
  pinMode(PIN_ESP_TX, INPUT);
  pinMode(PIN_ESP_RX, INPUT);
  pinMode(PIN_MIC_PWR, OUTPUT);
  digitalWrite(PIN_MIC_PWR, LOW);
  pinMode(PIN_DHT_PWR, OUTPUT);
  digitalWrite(PIN_DHT_PWR, LOW);
  pinMode(PIN_DHT_DATA, INPUT);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);

  Serial.begin(9600);
  Serial.println();
  Serial.print(F("Roskilde node v"));
  Serial.print(FW_MAJOR);
  Serial.print('.');
  Serial.println(FW_MINOR);
  printResetCause(cause);
  uint16_t bootCount = bumpBootCount();
  Serial.print(F("Boot count: "));
  Serial.println(bootCount);

#if SELF_TEST
  selfTest();
#endif

  loadSettings();
  Serial.print(F("Interval "));
  Serial.print(state.intervalMin);
  Serial.print(F(" min, scan "));
  Serial.print(state.scanSec);
  Serial.println(F(" s"));

  // Different seed per node (DevEUI) and per boot (floating A2 + timing)
  uint32_t seed = analogRead(A2) ^ ((uint32_t)analogRead(A2) << 10) ^ micros();
  for (const char *c = TTN_DEV_EUI; *c; c++) seed = seed * 31 + *c;
  randomSeed(seed);

  wdtOn();
  unsigned long wait = random(0, BOOT_JITTER_S + 1) * 1000UL;
  Serial.print(F("Waiting "));
  Serial.print(wait / 1000);
  Serial.println(F(" s before joining (jitter)"));
  safeDelay(wait);

  loraInit();
  while (!loraJoin(3)) {                       // no coverage: rest the radio and retry every 10 min
    Serial.println(F("No join, retrying in 10 min"));
    loraSleep(660000UL);
    sleepMs(600000UL);
    loraWake();
  }
  bootGuardStart();                            // confirmed or not, see v0.7 notes
  sendLocation();                              // port 2 on every boot
  sendBootInfo(cause, bootCount);              // port 4: why we booted
}

void loop() {
  if (state.sleeping) sleepCycle();
  else measurementCycle();
#if WDT_TEST
  Serial.println(F("WDT_TEST: hanging now, expect a reboot within 8 s"));
  while (true) { }
#endif
}
