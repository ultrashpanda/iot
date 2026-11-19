// The app always reads the real nodes from the backend (GET API_URL, see the Team 3 contract).
// Simulated nodes can be added on top with the "Simulated nodes" button.
export const CONFIG = {
  // Same origin as the page when the backend container serves the app (no CORS needed).
  API_URL: 'http://172.20.10.2:8080/api/devices',
  // Show the "Simulated nodes" button (set false to hide it, e.g. for the real festival).
  SIMULATED_BUTTON: true,
  // Simulated nodes switched on when the app opens (the user's last choice wins afterwards).
  SIMULATED_ON_START: false,
  // TESTS ONLY: show a real node at a festival position instead of where it really is
  // (e.g. a node tested in Copenhagen). Key = the node's "id" from the API
  // (tap the orange "outside the map" chip to see it). All measurements stay real;
  // the place sheet says it is a test position and shows the real coordinates.
  // While this list is not empty the demo position (draggable blue dot) is available.
  // Leave it EMPTY for the real festival: TEST_POSITIONS: {}
  TEST_POSITIONS: {
    // '1-soundscape-device': [55.6218, 12.0771],   // shown at Orange Stage
  },
  POLLING_INTERVAL: 5000,
  DEFAULT_NOISE_LIMIT: 75,
  FESTIVAL_CENTER: [55.6170, 12.0810],
  // Area where users are considered "at the festival" and where routes are computed.
  FESTIVAL_BOUNDS: [[55.60748,12.06623],[55.62414,12.09987]],
  // Area covered by the drawn basemap. The map can never be panned or zoomed out beyond it.
  MAP_BOUNDS: [[55.6010,12.0635],[55.6300,12.1040]],
  // View shown on opening and by the "show festival" button (inner site + main campings).
  HOME_BOUNDS: [[55.6120,12.0700],[55.6235,12.0900]],
  // Sensor names are shown under the circles from this zoom level on.
  LABEL_ZOOM: 15.4,
  // Demonstration starting position ONLY; never passed off as measured GPS. Used when simulated
  // nodes or TEST_POSITIONS are on and the real GPS is unavailable or outside the festival.
  DEMO_START: [55.6160,12.0772],
  // Walking 1 m across open ground counts like this many metres on a mapped path (higher = stick to paths).
  OFFROAD_FACTOR: 2.2,
  // Within this distance (m) of the destination the user is told they have arrived.
  ARRIVAL_METERS: 25
};
