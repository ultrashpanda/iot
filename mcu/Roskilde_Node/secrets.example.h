// TTN OTAA keys for ONE node. Copy this file to secrets.h and fill in the values.
// secrets.h is in .gitignore: never commit it.
// Each node (1-soundscape-device ... 5-soundscape-device) has its own DevEUI and AppKey:
// copy the values from that device's page in the TTN console before flashing it.
#ifndef ROSKILDE_SECRETS_H
#define ROSKILDE_SECRETS_H

static const char *TTN_APP_EUI = "0000000000000000";                 // 16 hex chars
static const char *TTN_APP_KEY = "00000000000000000000000000000000"; // 32 hex chars
static const char *TTN_DEV_EUI = "0000000000000000";                 // 16 hex chars

// The Google Geolocation key does NOT belong on the node. It lives only in the server's .env.

#endif
