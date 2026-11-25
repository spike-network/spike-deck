import assert from 'node:assert/strict';

// Drives background.js through idle, focus, popup and reachability changes and
// checks the timer plan it sends to the offscreen document.
const storage = {
  instances: [{ id: 'mock-instance', name: 'Mock', baseUrl: 'http://127.0.0.1:19090', secret: 'mock-secret' }],
  activeInstanceId: 'mock-instance',
  enableProxyMode: true,
  proxyReleasedForUnhealthy: false
};
const listeners = {};
const plans = [];
const titles = [];
let idleState = 'active';

globalThis.chrome = {
  action: {
    setBadgeBackgroundColor() {},
    setBadgeText() {},
    setTitle({ title }) { titles.push(title); }
  },
  alarms: {
    create() {},
    async clear() { return true; },
    onAlarm: { addListener: (listener) => { listeners.alarm = listener; } }
  },
  idle: {
    setDetectionInterval(seconds) { listeners.idleSeconds = seconds; },
    async queryState() { return idleState; },
    onStateChanged: { addListener: (listener) => { listeners.idle = listener; } }
  },
  windows: {
    WINDOW_ID_NONE: -1,
    async getLastFocused() { return { focused: true, state: 'normal' }; },
    onFocusChanged: { addListener: (listener) => { listeners.focus = listener; } }
  },
  proxy: {
    settings: {
      async clear() {},
      async get() { return { levelOfControl: 'controlled_by_this_extension', value: { mode: 'fixed_servers' } }; },
      async set() {}
    }
  },
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener: (listener) => { listeners.message = listener; } },
    onConnect: { addListener: (listener) => { listeners.connect = listener; } },
    async sendMessage(message) {
      if (message.type === 'SPIKE_TIMER_PLAN') plans.push(message.plan);
    },
    async getContexts() { return [{}]; }
  },
  offscreen: {
    async hasDocument() { return true; },
    async createDocument() {},
    async closeDocument() {}
  },
  storage: {
    local: {
      async get(keys) {
        return Object.fromEntries([].concat(keys).map((key) => [key, storage[key]]));
      },
      async set(values) { Object.assign(storage, values); }
    },
    onChanged: { addListener: (listener) => { (listeners.storage ??= []).push(listener); } }
  }
};

const { SpikeApiClient } = await import('../lib/spike-client.js');
let reachable = true;
let metricsCalls = 0;
let statusCalls = 0;
SpikeApiClient.getMetrics = async () => {
  metricsCalls += 1;
  if (!reachable) throw new Error('Spike server not responding');
  return { traffic: { upload_rate: 1, download_rate: 2 } };
};
SpikeApiClient.getStatus = async () => {
  statusCalls += 1;
  if (!reachable) throw new Error('Spike server not responding');
  return { profile: 'mock', listeners: [{ kind: 'mixed', address: '127.0.0.1:19890' }] };
};

await import('../background.js');
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const lastPlan = () => {
  const plan = plans.at(-1);
  return plan && [plan.health, plan.traffic];
};
const changeStorage = (changes) => listeners.storage.forEach((listener) => listener(changes, 'local'));
const tick = async (type) => {
  listeners.message({ type }, {}, () => {});
  await settle();
};

await settle();
assert.equal(listeners.idleSeconds, 120);
assert.deepEqual(lastPlan(), [5000, 1000], 'publishes the configured intervals at start');

const requested = await new Promise((resolve) => {
  assert.equal(listeners.message({ type: 'SPIKE_TIMER_PLAN_REQUEST' }, {}, resolve), true);
});
assert.equal(requested.ok, true);
assert.deepEqual([requested.plan.health, requested.plan.traffic], [5000, 1000]);

// Idle: the badge stops, the health check keeps protecting the proxy.
listeners.idle('idle');
assert.deepEqual(lastPlan(), [5000, null]);
metricsCalls = 0;
await tick('SPIKE_TRAFFIC_TICK');
assert.equal(metricsCalls, 0, 'a stale badge tick is ignored while paused');

// Locked: both stop.
listeners.idle('locked');
assert.deepEqual(lastPlan(), [null, null]);
statusCalls = 0;
await tick('SPIKE_HEALTH_TICK');
assert.equal(statusCalls, 0, 'a stale health tick is ignored while locked');

// Back to active: plan restored and both checks run at once.
metricsCalls = 0;
statusCalls = 0;
listeners.idle('active');
await settle();
assert.deepEqual(lastPlan(), [5000, 1000]);
assert.ok(metricsCalls >= 1, 'badge refreshed immediately on resume');
assert.ok(statusCalls >= 1, 'health checked immediately on resume');

// Unfocused browser: no badge sampling; focus resumes it.
listeners.focus(-1);
assert.deepEqual(lastPlan(), [5000, null]);
metricsCalls = 0;
listeners.focus(7);
await settle();
assert.deepEqual(lastPlan(), [5000, 1000]);
assert.ok(metricsCalls >= 1);

// Popup open: it samples by itself, so the background badge timer stands down.
const disconnect = [];
listeners.connect({
  name: 'traffic-watch',
  onMessage: { addListener() {} },
  onDisconnect: { addListener: (listener) => disconnect.push(listener) }
});
assert.deepEqual(lastPlan(), [5000, null]);
disconnect.forEach((listener) => listener());
assert.deepEqual(lastPlan(), [5000, 1000]);

// Unreachable: three failures at the normal pace, then bounded backoff.
reachable = false;
for (let i = 0; i < 3; i += 1) await tick('SPIKE_TRAFFIC_TICK');
assert.deepEqual(lastPlan(), [10000, 2000]);
assert.match(titles.at(-1), /Spike server not responding · retrying every 2s/, 'the failure stays visible');
for (let i = 0; i < 20; i += 1) await tick('SPIKE_TRAFFIC_TICK');
assert.deepEqual(lastPlan(), [30000, 30000], 'backoff is capped');

// Success returns to the configured intervals.
reachable = true;
await tick('SPIKE_TRAFFIC_TICK');
assert.deepEqual(lastPlan(), [5000, 1000]);

// TRAFFIC_SAMPLE records reachability before painting the badge title.
for (let i = 0; i < 3; i += 1) {
  listeners.message({ type: 'TRAFFIC_SAMPLE', traffic: null, error: 'Spike server not responding' }, {}, () => {});
}
assert.match(titles.at(-1), /Spike server not responding · retrying every 2s/);
await settle();
listeners.message({ type: 'TRAFFIC_SAMPLE', traffic: { upload_rate: 1, download_rate: 2 } }, {}, () => {});
await settle();
assert.deepEqual(lastPlan(), [5000, 1000]);

// A user action (settings change) also resets the backoff.
reachable = false;
for (let i = 0; i < 4; i += 1) await tick('SPIKE_TRAFFIC_TICK');
assert.deepEqual(lastPlan(), [20000, 4000]);
storage.trafficRefreshInterval = 3;
changeStorage({ trafficRefreshInterval: { newValue: 3 } });
await settle();
assert.deepEqual(lastPlan(), [5000, 3000]);

// Proxy mode off: the health timer pauses, the badge keeps going.
reachable = true;
storage.enableProxyMode = false;
changeStorage({ enableProxyMode: { newValue: false } });
await settle();
assert.deepEqual(lastPlan(), [null, 3000]);

// Cold wake: live idle/focus/port events wait for timer facts and win over stale async queries.
{
  storage.enableProxyMode = true;
  storage.trafficRefreshInterval = 1;
  plans.length = 0;
  let resolveIdle;
  let resolveFocus;
  const idlePending = new Promise((resolve) => { resolveIdle = resolve; });
  const focusPending = new Promise((resolve) => { resolveFocus = resolve; });
  chrome.idle.queryState = () => idlePending;
  chrome.windows.getLastFocused = () => focusPending;

  await import('../background.js?cold-race=1');
  const coldDisconnect = [];
  listeners.idle('locked');
  listeners.focus(-1);
  listeners.connect({
    name: 'traffic-watch',
    onMessage: { addListener() {} },
    onDisconnect: { addListener: (listener) => coldDisconnect.push(listener) }
  });
  coldDisconnect.forEach((listener) => listener());
  assert.equal(plans.length, 0, 'cold wake must not publish a premature plan before timer facts load');

  resolveIdle('active');
  resolveFocus({ focused: true, state: 'normal' });
  await settle();
  assert.deepEqual(lastPlan(), [null, null], 'live locked event must not be overwritten by stale idle query');

  listeners.idle('active');
  await settle();
  assert.deepEqual(lastPlan(), [5000, null], 'live unfocused event must not be overwritten by stale focus query');
}

console.log('background timer plan tests passed');
