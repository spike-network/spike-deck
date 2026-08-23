import assert from 'node:assert/strict';

const storage = {
  instances: [{
    id: 'test-instance',
    name: 'Test instance',
    baseUrl: 'http://127.0.0.1:9090',
    secret: 'mock-secret'
  }],
  activeInstanceId: 'test-instance',
  enableProxyMode: true,
  proxyReleasedForUnhealthy: false
};

const proxy = {
  cleared: 0,
  set: 0,
  levelOfControl: 'controlled_by_this_extension'
};

globalThis.chrome = {
  action: {
    setBadgeBackgroundColor() {},
    setBadgeText() {},
    setTitle() {}
  },
  alarms: {
    create() {},
    async clear() { return true; },
    onAlarm: { addListener() {} }
  },
  proxy: {
    settings: {
      async clear() {
        proxy.cleared += 1;
        proxy.levelOfControl = 'controllable_by_this_extension';
      },
      async get() {
        return { levelOfControl: proxy.levelOfControl };
      },
      async set() {
        proxy.set += 1;
        proxy.levelOfControl = 'controlled_by_this_extension';
      }
    }
  },
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener() {} },
    onStartup: { addListener() {} },
    onConnect: { addListener() {} },
    async sendMessage() {},
    async getContexts() { return []; }
  },
  offscreen: {
    async hasDocument() { return false; },
    async createDocument() {},
    async closeDocument() {}
  },
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

const { SpikeApiClient } = await import('../lib/spike-client.js');
let statusShouldFail = true;
SpikeApiClient.getStatus = async () => {
  if (statusShouldFail) throw new Error('Spike server not responding');
  return {
    profile: 'surge',
    listeners: [{ kind: 'mixed', address: '127.0.0.1:7890' }]
  };
};

const { reconcileProxyWithHealth } = await import('../background.js');

const down = await reconcileProxyWithHealth();
assert.equal(down.action, 'released');
assert.equal(down.healthy, false);
assert.equal(storage.proxyReleasedForUnhealthy, true);
assert.equal(storage.enableProxyMode, true);
assert.ok(proxy.cleared >= 1);
assert.equal(proxy.set, 0);

statusShouldFail = false;
const up = await reconcileProxyWithHealth();
assert.equal(up.action, 'restored');
assert.equal(up.healthy, true);
assert.equal(storage.proxyReleasedForUnhealthy, false);
assert.equal(storage.enableProxyMode, true);
assert.ok(proxy.set >= 1);

const holding = await reconcileProxyWithHealth();
assert.equal(holding.action, 'holding');

storage.enableProxyMode = false;
const idle = await reconcileProxyWithHealth();
assert.equal(idle.action, 'idle');
assert.equal(storage.proxyReleasedForUnhealthy, false);

console.log('proxy health tests passed');
