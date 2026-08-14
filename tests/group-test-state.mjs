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
const broadcasts = [];
const alarms = new Map();

globalThis.chrome = {
  action: {
    setBadgeBackgroundColor() {},
    setBadgeText() {}
  },
  alarms: {
    create(name, options) {
      alarms.set(name, options);
    },
    async clear(name) {
      return alarms.delete(name);
    },
    onAlarm: { addListener() {} }
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
    onStartup: { addListener() {} },
    async sendMessage(message) {
      broadcasts.push(message);
    }
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
let coreTasks = [{
  id: 41,
  group: 'Mock Group',
  member: null,
  status: 'queued',
  results: [],
  revision: 1
}];

SpikeApiClient.startGroupTest = async () => ({
  mode: 'async',
  task: coreTasks[0]
});
SpikeApiClient.getGroupTestTasks = async () => ({ tasks: coreTasks });

const {
  refreshGroupTestState,
  startGroupTestTask
} = await import('../background.js');

const started = await startGroupTestTask('test-instance', 'Mock Group');
assert.equal(started.mode, 'async');
assert.equal(storage.groupTestTasks['test-instance'][0].id, 41);
assert.equal(alarms.has('group-test-reconcile:test-instance'), true);
assert.equal(broadcasts.at(-1).type, 'GROUP_TEST_STATE_CHANGED');

coreTasks = [{
  ...coreTasks[0],
  status: 'completed',
  completed: 1,
  total: 1,
  completed_at_unix_ms: Date.now(),
  results: [{ member: 'Mock Node', ok: true, latency_ms: 24 }],
  revision: 2
}];
const completed = await refreshGroupTestState('test-instance');
assert.equal(completed[0].status, 'completed');
assert.equal(completed[0].results[0].latency_ms, 24);
assert.equal(storage.groupTestTasks?.['test-instance'], undefined);
assert.equal(alarms.has('group-test-reconcile:test-instance'), false);
assert.equal(broadcasts.at(-1).tasks[0].status, 'completed');
