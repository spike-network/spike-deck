import assert from 'node:assert/strict';

const realSetTimeout = globalThis.setTimeout;
const scheduled = [];
const messages = [];
let connectListener = null;
const makePort = () => {
  const port = {
    name: 'spike-log-stream',
    postMessage(message) { messages.push(message); },
    onDisconnect: { addListener(listener) { port.disconnect = listener; } }
  };
  return port;
};
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
    onMessage: { addListener() {} },
    onConnect: { addListener(listener) { connectListener = listener; } }
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
assert.equal(
  scheduled.filter((timer) => timer.delay === 100).length, 0,
  'no log stream starts while no page is listening'
);
const port = makePort();
connectListener(port);
const initialStart = scheduled.find((timer) => timer.delay === 100);
assert.ok(initialStart, 'the first listening page starts the log stream');
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

const late = makePort();
const lateMessages = [];
late.postMessage = (message) => lateMessages.push(message);
connectListener(late);
assert.equal(scheduled.filter((timer) => timer.delay === 100).length, startsBefore + 1,
  'a second page joins the running stream');
assert.equal(lateMessages[0]?.type, 'SPIKE_LOG_STREAM_STATE', 'a joining page is told the stream state');

port.disconnect();
late.disconnect();
storageListener({ activeInstanceId: { newValue: 'mock-instance' } }, 'local');
assert.equal(scheduled.filter((timer) => timer.delay === 100).length, startsBefore + 1,
  'the stream stays stopped after the last page leaves');

console.log('offscreen log stream lifecycle tests passed');
