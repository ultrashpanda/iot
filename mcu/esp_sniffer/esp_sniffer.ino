/*
  esp_sniffer.ino - ESP-01 phone counter for the Roskilde node (replaces the AT firmware)
  Board: "Generic ESP8266 Module" (ESP8266 Arduino core). Flash: GPIO0 to GND at power-up.

  Runs once per power-up (the Pro Mini switches the ESP on and off):
    1. prints RDY, waits up to 1.5 s for "S<seconds>" from the Pro Mini (S0 = scan only, no sniffing)
    2. sniffs Wi-Fi for that long (default 45 s), hopping channels 1-13
       - counts devices sending probe requests, or data frames to an access point
       - only signals >= RSSI_MIN (nearby phones), no group/broadcast addresses
       - MACs are hashed with a random salt made at every power-up; only hashes are kept, in RAM,
         and they are gone when the power is cut. Nothing identifiable leaves the ESP.
    3. normal network scan (for port 2 geolocation)
    4. prints the result to the Pro Mini at 9600 baud, then sleeps until the power is cut:
         PH <unique devices>      phones (and other Wi-Fi clients) nearby
         RN <of which random MAC> for analysis only (modern phones randomise their MAC)
         NW <networks seen>
         AP <bssid 12 hex> <rssi>   up to 5 strongest, "_nomap" networks left out
         NF                        only if the hash table filled up (count is a lower bound)
         END
*/
#include <ESP8266WiFi.h>
extern "C" {
#include "user_interface.h"
}

#define BAUD             9600
#define DEFAULT_SNIFF_S  45
#define MAX_SNIFF_S      120
#define RSSI_MIN         -75     // weaker = too far away to count (roughly 10-30 m)
#define HOP_MS           250     // time per channel
#define TABLE_SIZE       1024    // hash table (power of 2)
#define TABLE_FULL_AT    900
#define MAX_APS          5

static uint32_t table[TABLE_SIZE];   // 0 = empty slot
static volatile uint16_t nDevices = 0;
static volatile uint16_t nRandom = 0;
static volatile bool tableFull = false;
static uint32_t salt;

// FNV-1a over the salt and the 6 MAC bytes
static uint32_t macHash(const uint8_t *mac) {
  uint32_t h = 2166136261UL;
  for (uint8_t i = 0; i < 4; i++) { h ^= (salt >> (8 * i)) & 0xFF; h *= 16777619UL; }
  for (uint8_t i = 0; i < 6; i++) { h ^= mac[i]; h *= 16777619UL; }
  return h ? h : 1;
}

static void addDevice(const uint8_t *mac) {
  if (tableFull) return;
  uint32_t h = macHash(mac);
  uint16_t i = h & (TABLE_SIZE - 1);
  while (table[i]) {
    if (table[i] == h) return;         // already counted
    i = (i + 1) & (TABLE_SIZE - 1);
  }
  table[i] = h;
  nDevices++;
  if (mac[0] & 0x02) nRandom++;        // locally administered = randomised MAC
  if (nDevices >= TABLE_FULL_AT) tableFull = true;
}

// Promiscuous callback: buf = 12 bytes radio info (RSSI first), then the 802.11 frame
static void onFrame(uint8_t *buf, uint16_t len) {
  if (len < 12 + 24) return;
  int8_t rssi = (int8_t)buf[0];
  if (rssi < RSSI_MIN) return;
  const uint8_t *f = buf + 12;
  uint8_t type = (f[0] >> 2) & 0x03;
  uint8_t sub  = f[0] >> 4;
  bool toDs   = f[1] & 0x01;
  bool fromDs = f[1] & 0x02;
  bool probe  = (type == 0 && sub == 4);              // probe request
  bool fromSta = (type == 2 && toDs && !fromDs);      // data frame from a client to its AP
  if (!probe && !fromSta) return;
  const uint8_t *src = f + 10;                        // address 2 = transmitter
  if (src[0] & 0x01) return;                          // group address
  addDevice(src);
}

static uint16_t readSniffSeconds() {
  String s;
  unsigned long t0 = millis();
  while (millis() - t0 < 1500) {
    if (!Serial.available()) { delay(1); continue; }
    char c = Serial.read();
    if (c == '\n') break;
    if (c != '\r') s += c;
  }
  s.trim();
  if (s.length() < 2 || s[0] != 'S') return DEFAULT_SNIFF_S;
  long v = s.substring(1).toInt();
  if (v < 0) v = 0;
  if (v > MAX_SNIFF_S) v = MAX_SNIFF_S;
  return (uint16_t)v;
}

static void sniff(uint16_t seconds) {
  if (seconds == 0) return;
  wifi_set_opmode(STATION_MODE);
  wifi_promiscuous_enable(0);
  wifi_set_promiscuous_rx_cb(onFrame);
  wifi_promiscuous_enable(1);
  unsigned long t0 = millis();
  uint8_t ch = 1;
  while (millis() - t0 < (unsigned long)seconds * 1000UL) {
    wifi_set_channel(ch);
    delay(HOP_MS);                                    // also feeds the ESP watchdog
    ch = (ch % 13) + 1;
  }
  wifi_promiscuous_enable(0);
}

static void printHex2(uint8_t b) {
  if (b < 16) Serial.print('0');
  Serial.print(b, HEX);
}

static void scanAndReport() {
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  int n = WiFi.scanNetworks(false, true);             // blocking, include hidden networks
  if (n < 0) n = 0;

  // pick the 5 strongest that are not "_nomap"
  int best[MAX_APS];
  uint8_t nb = 0;
  for (int i = 0; i < n; i++) {
    if (WiFi.SSID(i).endsWith("_nomap")) continue;
    int8_t r = WiFi.RSSI(i);
    uint8_t pos = nb;
    while (pos > 0 && WiFi.RSSI(best[pos - 1]) < r) pos--;
    if (pos >= MAX_APS) continue;
    uint8_t last = (nb < MAX_APS) ? nb : MAX_APS - 1;
    for (uint8_t k = last; k > pos; k--) best[k] = best[k - 1];
    best[pos] = i;
    if (nb < MAX_APS) nb++;
  }

  Serial.print(F("PH ")); Serial.println(nDevices);
  Serial.print(F("RN ")); Serial.println(nRandom);
  Serial.print(F("NW ")); Serial.println(n);
  for (uint8_t k = 0; k < nb; k++) {
    uint8_t *b = WiFi.BSSID(best[k]);
    Serial.print(F("AP "));
    for (uint8_t j = 0; j < 6; j++) printHex2(b[j]);
    Serial.print(' ');
    Serial.println(WiFi.RSSI(best[k]));
  }
  if (tableFull) Serial.println(F("NF"));
  Serial.println(F("END"));
  Serial.flush();
}

void setup() {
  Serial.begin(BAUD);
  delay(50);
  salt = RANDOM_REG32 ^ (RANDOM_REG32 << 7);          // new salt every power-up
  WiFi.persistent(false);                             // never write Wi-Fi settings to flash
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  Serial.println();
  Serial.println(F("RDY"));
  uint16_t secs = readSniffSeconds();
  sniff(secs);
  scanAndReport();
  ESP.deepSleep(0);                                   // until the Pro Mini cuts the power
}

void loop() { }
