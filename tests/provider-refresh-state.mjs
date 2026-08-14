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
let nextCoreTaskId = 17;
let coreTaskStatus = 'failed';
let coreProviderResults = [
  { provider_id: 'provider-one', status: 'failed', error: 'mock refresh failure' },
  { provider_id: 'provider-two', status: 'succeeded' },
  { provider_id: 'provider-three', status: 'skipped' }
];
SpikeApiClient.startProviderRefreshTask = async () => ({
  id: nextCoreTaskId++,
  status: 'running',
  started_at_unix_ms: Date.now(),
  provider_results: coreProviderResults.map(result => ({
    provider_id: result.provider_id,
    status: 'pending'
  }))
});
SpikeApiClient.getProviderRefreshTask = async (_instance, id) => ({
  id,
  status: coreTaskStatus,
  completed_at_unix_ms: Date.now(),
  revision: 9,
  error: coreTaskStatus === 'failed' ? 'mock aggregate failure' : null,
  provider_results: coreProviderResults
});
SpikeApiClient.getProviders = async () => ({
  refreshing: false,
  providers: [
    { id: 'provider-one', status: 'ready' },
    { id: 'provider-two', status: 'ready' }
  ]
});

const {
  getProviderRefreshTask,
  safeProviderRefreshError,
  startProviderRefreshTask
} = await import('../background.js');

const started = await startProviderRefreshTask(
  'test-instance',
  null,
  ['provider-one', 'provider-two', 'provider-three']
);
assert.equal(started.status, 'running');
assert.equal(started.coreTaskId, 17);
assert.deepEqual(started.requestedProviderIds, ['provider-one', 'provider-two', 'provider-three']);

storage.providerRefreshFailures = {
  'test-instance': {
    'provider-two': { failedAtUnix: 1, error: 'old failure' },
    'provider-three': { failedAtUnix: 1, error: 'retained failure' }
  }
};

const failed = await getProviderRefreshTask('test-instance');
assert.equal(failed.status, 'failed');
assert.equal(failed.outcomeRecorded, true);
assert.equal(storage.providerRefreshFailures['test-instance']['provider-one'].error, 'mock refresh failure');
assert.equal(storage.providerRefreshFailures['test-instance']['provider-two'], undefined);
assert.equal(storage.providerRefreshFailures['test-instance']['provider-three'].error, 'retained failure');

coreTaskStatus = 'succeeded';
coreProviderResults = [
  { provider_id: 'provider-one', status: 'succeeded' },
  { provider_id: 'provider-two', status: 'skipped' },
  { provider_id: 'provider-three', status: 'skipped' }
];
const retried = await startProviderRefreshTask('test-instance', 'provider-one');
assert.equal(retried.status, 'running');
assert.equal(retried.coreTaskId, 18);
const completed = await getProviderRefreshTask('test-instance');
assert.equal(completed.status, 'succeeded');
assert.equal(completed.revision, 9);
assert.equal(completed.ready, 2);
assert.equal(completed.total, 2);
assert.equal(storage.providerRefreshTasks['test-instance'].status, 'succeeded');
assert.equal(storage.providerRefreshFailures['test-instance']['provider-one'], undefined);
assert.equal(storage.providerRefreshFailures['test-instance']['provider-three'].error, 'retained failure');

const redacted = safeProviderRefreshError(
  new Error('GET https://provider.example.test/list?token=mock-token failed')
);
assert.equal(redacted.includes('mock-token'), false);
assert.equal(redacted.includes('?…'), true);
