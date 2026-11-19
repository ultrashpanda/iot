// wdt_test.ino - does this Pro Mini survive a watchdog reset? (bootloader check)
// Serial 9600. Expected: "hanging..." then ~8 s later "Reset cause: 0x8 ... bootloader OK".
// If it never comes back (or the LED flickers forever), the old bootloader loops: burn Optiboot.
#include <avr/wdt.h>

uint8_t mcusrCopy __attribute__((section(".noinit")));
uint8_t r2Copy    __attribute__((section(".noinit")));

void early(void) __attribute__((naked, used, section(".init3")));
void early(void) {
  __asm__ __volatile__("sts %0, r2" : "=m"(r2Copy));   // Optiboot passes MCUSR in r2
  mcusrCopy = MCUSR;
  MCUSR = 0;
  wdt_disable();
}

void setup() {
  Serial.begin(9600);
  uint8_t c = mcusrCopy & 0x0F;
  if (!c) c = r2Copy & 0x0F;
  Serial.print(F("Reset cause: 0x"));
  Serial.print(c, HEX);
  Serial.println(F("  (1 power-on, 2 reset pin, 4 brown-out, 8 watchdog)"));

  if (c & 0x08) {
    Serial.println(F("WATCHDOG reset -> bootloader OK. Test passed."));
    while (true) { }                // watchdog is off now, so this just stops here
  }
  Serial.println(F("Enabling 8 s watchdog and hanging..."));
  Serial.flush();
  wdt_enable(WDTO_8S);
  while (true) { }
}

void loop() { }
