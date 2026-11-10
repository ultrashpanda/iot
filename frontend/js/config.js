/**
 * Frontend-only settings. Switch DATA_MODE to 'api' when backend is ready.
 * In demo mode there are 0 physical devices; all displayed points are simulated.
 */
export const CONFIG = Object.freeze({
  DATA_MODE: 'demo', // 'demo' | 'api'
  API_URL: '/api/devices',
  REFRESH_MS: 5000,
  STALE_AFTER_MS: 15 * 60 * 1000,
  DEFAULT_THRESHOLD_DB: 80,
  MAP_CENTER: [55.607, 12.071], // illustrative centre near festival area
  MAP_ZOOM: 13,
  DEMO_DEVICE_COUNT: 20,
});
