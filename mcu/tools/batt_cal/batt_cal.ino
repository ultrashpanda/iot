// batt_cal.ino - battery calibration only (no LoRa, no Wi-Fi).
// Same measurement as roskilde_node v0.3: VCC via the 1.1 V bandgap, then A1 averaged 16x.
// Run from the 3 x AA pack with the programmer's VCC wire DISCONNECTED. Serial monitor 9600.
// Multimeter on RAW-GND, compare with "avg8", then: BATT_CAL = multimeter / avg8.

const float   BATT_CAL     = 1.00f;
const float   BATT_DIVIDER = 2.0f;    // 1 MOhm over 1 MOhm
const uint8_t PIN_BATT     = A1;

uint16_t readVccMv() {
  ADMUX = _BV(REFS0) | _BV(MUX3) | _BV(MUX2) | _BV(MUX1);   // ref AVcc, input = 1.1 V bandgap
  delay(2);
  for (uint8_t i = 0; i < 2; i++) {                          // first conversion thrown away
    ADCSRA |= _BV(ADSC);
    while (bit_is_set(ADCSRA, ADSC)) { }
  }
  uint16_t r = ADC;
  return r ? (uint16_t)(1125300UL / r) : 3300;
}

uint16_t hist[8];
uint8_t  nHist = 0, iHist = 0;

void setup() {
  pinMode(A3, OUTPUT); digitalWrite(A3, LOW);   // ESP-01 off
  pinMode(4, INPUT);                            // no data line into the ESP
  pinMode(5, OUTPUT); digitalWrite(5, LOW);     // DHT22 off
  pinMode(7, OUTPUT); digitalWrite(7, LOW);     // mic off
  analogReference(DEFAULT);
  Serial.begin(9600);
  Serial.println(F("Battery calibration. BATT_CAL = multimeter / avg8"));
  Serial.println(F("raw\tVCC mV\tbatt mV\tavg8 mV"));
}

void loop() {
  analogRead(PIN_BATT);
  uint16_t vcc = readVccMv();
  analogRead(PIN_BATT);                         // back on A1, let it settle
  delay(2);
  analogRead(PIN_BATT);

  uint32_t s = 0;
  for (uint8_t i = 0; i < 16; i++) s += analogRead(PIN_BATT);
  uint16_t raw = s / 16;
  uint16_t mv = (uint16_t)(raw * (vcc / 1023000.0f) * BATT_DIVIDER * BATT_CAL * 1000.0f);

  hist[iHist] = mv; iHist = (iHist + 1) % 8; if (nHist < 8) nHist++;
  uint32_t a = 0;
  for (uint8_t i = 0; i < nHist; i++) a += hist[i];

  Serial.print(raw);        Serial.print('\t');
  Serial.print(vcc);        Serial.print('\t');
  Serial.print(mv);         Serial.print('\t');
  Serial.print(a / nHist);
  if (mv < 2500) Serial.print(F("\t<- too low: running from the programmer?"));
  Serial.println();
  delay(2000);
}
