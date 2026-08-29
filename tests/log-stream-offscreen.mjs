import assert from 'node:assert/strict';

const realSetTimeout = globalThis.setTimeout;
const scheduled = [];
const messages = [];
let storageListener = null;
let nextTimer = 1;
const stored = {
  instances: [{
    id: 'mock-instance',
    name: 'Mock',
    baseUrl: 'http://127.0.0.1:9090',
    secret: 'mock-secret'
  }],
  activeInstanceId: 'mock-instance',
  enableProxyMode: false
};

globalThis.setInterval = () => nextTimer++;
globalThis.clearInterval = () => {};
globalThis.setTimeout = (callback, delay) => {
  scheduled.push({ callback, delay });
  return nextTimer++;
};
globalThis.clearTimeout = () => {};
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'text/event-stream' }),
  body: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'event: log\nid: 9\ndata: {"sequence":9,"message":"outside page"}\n\n'
      ));
      controller.close();
    }
  })
});

globalThis.chrome = {
  runtime: {
    async sendMessage(message) { messages.push(message); },
    onMessage: { addListener() {} }
  },
  storage: {
    local: {
      async get(keys) {
        return Object.fromEntries(keys.map((key) => [key, stored[key]]));
      },
      async set(values) { Object.assign(stored, values); }
    },
    onChanged: {
      addListener(listener) { storageListener = listener; }
    }
  }
};

await import('../offscreen.js');
await new Promise((resolve) => realSetTimeout(resolve, 0));
const initialStart = scheduled.find((timer) => timer.delay === 100);
assert.ok(initialStart, 'offscreen schedules the initial log stream independently');
initialStart.callback();
await new Promise((resolve) => realSetTimeout(resolve, 20));

assert.ok(messages.some((message) =>
  message.type === 'SPIKE_LOG_STREAM_STATE' && message.status === 'live'
));
assert.ok(messages.some((message) =>
  message.type === 'SPIKE_LOG_STREAM_ENTRY'
    && message.instanceId === 'mock-instance'
    && message.entry.sequence === 9
));

const startsBefore = scheduled.filter((timer) => timer.delay === 100).length;
storageListener({ unrelatedPreference: { newValue: true } }, 'local');
assert.equal(scheduled.filter((timer) => timer.delay === 100).length, startsBefore);
storageListener({ activeInstanceId: { newValue: 'mock-instance' } }, 'local');
assert.equal(scheduled.filter((timer) => timer.delay === 100).length, startsBefore + 1);

console.log('offscreen log stream lifecycle tests passed');
