import assert from 'node:assert/strict';

const storage = {};

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        return Object.fromEntries(keys.map((key) => [key, storage[key]]));
      },
      async set(values) {
        Object.assign(storage, values);
      }
    }
  }
};

const { StorageManager, DEFAULT_HEALTH_CHECK_INTERVAL, DEFAULT_TRAFFIC_REFRESH_INTERVAL } = await import('../lib/storage.js');

// Test defaults
assert.equal(await StorageManager.getHealthCheckInterval(), DEFAULT_HEALTH_CHECK_INTERVAL);
assert.equal(await StorageManager.getHealthCheckInterval(), 5);

assert.equal(await StorageManager.getTrafficRefreshInterval(), DEFAULT_TRAFFIC_REFRESH_INTERVAL);
assert.equal(await StorageManager.getTrafficRefreshInterval(), 1);
assert.equal(await StorageManager.isPopupShortcutEnabled(), true);

// Test custom settings
await StorageManager.setHealthCheckInterval(10);
assert.equal(await StorageManager.getHealthCheckInterval(), 10);
assert.equal(storage.healthCheckInterval, 10);

await StorageManager.setTrafficRefreshInterval(2);
assert.equal(await StorageManager.getTrafficRefreshInterval(), 2);
assert.equal(storage.trafficRefreshInterval, 2);

await StorageManager.setPopupShortcutEnabled(false);
assert.equal(await StorageManager.isPopupShortcutEnabled(), false);
assert.equal(storage.enablePopupShortcut, false);
await StorageManager.setPopupShortcutEnabled(true);
assert.equal(await StorageManager.isPopupShortcutEnabled(), true);

// Test boundary constraints
await StorageManager.setHealthCheckInterval(0);
assert.equal(await StorageManager.getHealthCheckInterval(), 1); // clamped to min 1

await StorageManager.setHealthCheckInterval(999);
assert.equal(await StorageManager.getHealthCheckInterval(), 300); // clamped to max 300

await StorageManager.setTrafficRefreshInterval(-5);
assert.equal(await StorageManager.getTrafficRefreshInterval(), 1); // clamped to min 1

await StorageManager.setTrafficRefreshInterval(120);
assert.equal(await StorageManager.getTrafficRefreshInterval(), 60); // clamped to max 60

console.log('interval preferences tests passed');
