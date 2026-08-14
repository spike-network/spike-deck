import assert from 'node:assert/strict';

const storage = {
  instances: [{
    id: 'test-instance',
    name: 'Test instance',
    baseUrl: 'http://127.0.0.1:9090',
    secret: 'mock-secret'
  }],
  activeInstanceId: 'test-instance',
  enableProxyMode: false
};

globalThis.chrome = {
  action: {
    setBadgeBackgroundColor() {},
    setBadgeText() {}
  },
  proxy: {
    settings: {
      async clear() {},
      async get() {
        return { levelOfControl: 'controllable_by_this_extension' };
      },
      async set() {}
    }
  },
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener() {} },
    onStartup: { addListener() {} }
  },
  storage: {
    local: {
      async get(keys) {
        return Object.fromEntries(keys.map(key => [key, storage[key]]));
      },
      async set(values) {
        Object.assign(storage, values);
      }
    }
  }
};

const { SpikeApiClient } = await import('../lib/spike-client.js');
SpikeApiClient.startProviderRefreshTask = async () => ({
  id: 17,
  status: 'running',
  started_at_unix_ms: Date.now()
});
SpikeApiClient.getProviderRefreshTask = async () => ({
  id: 17,
  status: 'succeeded',
  completed_at_unix_ms: Date.now(),
  revision: 9
});
SpikeApiClient.getProviders = async () => ({
  refreshing: false,
  providers: [{ id: 'provider-id', status: 'ready' }]
});

const {
  getProviderRefreshTask,
  safeProviderRefreshError,
  startProviderRefreshTask
} = await import('../background.js');

const started = await startProviderRefreshTask('test-instance', 'provider-id');
assert.equal(started.status, 'running');
assert.equal(started.coreTaskId, 17);
assert.equal(started.providerId, 'provider-id');

const completed = await getProviderRefreshTask('test-instance');
assert.equal(completed.status, 'succeeded');
assert.equal(completed.revision, 9);
assert.equal(completed.ready, 1);
assert.equal(completed.total, 1);
assert.equal(storage.providerRefreshTasks['test-instance'].status, 'succeeded');

const redacted = safeProviderRefreshError(
  new Error('GET https://provider.example.test/list?token=mock-token failed')
);
assert.equal(redacted.includes('mock-token'), false);
assert.equal(redacted.includes('?…'), true);
