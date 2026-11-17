import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chronological } from '../lib/journal-export.js';
import { PanelObservation } from '../lib/panels.js';
import { ThroughputSession } from '../lib/throughput.js';

// The tools page holds a port open while it wants live logs. This drives the
// real page script against a mock runtime and checks the port lifecycle.

const nodes = new Map();
const node = () => ({ value: '', dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
  listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; },
  append() {}, replaceChildren() {}, focus() {} });
const document = { hidden: false,
  getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
  createElement: node, addEventListener() {}, removeEventListener() {} };
const timeouts = [];
const windowListeners = {};
const ports = [];
const requests = [];
const makePort = (options) => {
  const port = { name: options.name, disconnected: false, listeners: {},
    onMessage: { addListener(fn) { port.listeners.message = fn; } },
    onDisconnect: { addListener(fn) { port.listeners.disconnect = fn; } },
    disconnect() { port.disconnected = true; } };
  ports.push(port);
  return port;
};
const api = new Proxy({}, { get: (_, key) => key === 'getLogs'
  ? async () => ({ event_namespace: 'boot-a', entries: [] })
  : async () => ({}) });
const context = vm.createContext({ document, console,
  window: { setInterval() { return 1; }, clearInterval() {}, clearTimeout() {},
    setTimeout(fn, delay) { timeouts.push({ fn, delay }); return timeouts.length; },
    addEventListener(name, fn) { windowListeners[name] = fn; } },
  chrome: { runtime: { onMessage: { addListener() {} }, connect: makePort,
    sendMessage: async (message) => { requests.push(message.type); return { ok: true }; } } },
  SpikeApiClient: api, StorageManager: { init: async () => {}, getActiveInstance: async () => ({ id: 'fixture' }) },
  initializeI18n: async () => {}, t: (value) => value,
  filterRuntimeLogs: (entries) => entries, sortRuntimeLogs: (entries) => entries,
  formatRuntimeLogs: (entries) => entries.map((entry) => entry.message).join('\n'),
  chronological, PanelObservation, ThroughputSession,
});
const source = fs.readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '');
await vm.runInContext(`(async () => { ${source} })()`, context);
const settle = () => new Promise((resolve) => setImmediate(resolve));
await settle();

assert.deepEqual(requests, ['ENSURE_LOG_STREAM']);
assert.equal(ports.length, 1);
assert.equal(ports[0].name, 'spike-log-stream');

const state = (status) => ({ type: 'SPIKE_LOG_STREAM_STATE', instanceId: 'fixture', status, eventNamespace: 'boot-a' });
ports[0].listeners.message(state('live'));
assert.equal(nodes.get('logs-stream-state').dataset.state, 'live');
ports[0].listeners.message({ type: 'SPIKE_LOG_STREAM_ENTRY', instanceId: 'fixture',
  entry: { event_namespace: 'boot-a', sequence: 7, message: 'from-port' } });
assert.match(nodes.get('logs-output').textContent, /from-port/);
ports[0].listeners.message({ type: 'SPIKE_LOG_STREAM_ENTRY', instanceId: 'other',
  entry: { event_namespace: 'boot-a', sequence: 8, message: 'other-instance' } });
assert.doesNotMatch(nodes.get('logs-output').textContent, /other-instance/);

// A port that heard something is left alone by the watchdog.
const watchdog = timeouts.find((timer) => timer.delay === 3000);
assert.ok(watchdog, 'a new port is watched for silence');
watchdog.fn();
assert.equal(ports[0].disconnected, false);

// Losing the port asks for the stream again after a delay.
const scheduled = timeouts.length;
ports[0].listeners.disconnect();
assert.equal(nodes.get('logs-stream-state').dataset.state, 'retrying');
assert.equal(timeouts.length, scheduled + 1);
timeouts.at(-1).fn();
await settle();
assert.deepEqual(requests, ['ENSURE_LOG_STREAM', 'ENSURE_LOG_STREAM']);
assert.equal(ports.length, 2);

// A silent port is abandoned and replaced.
timeouts.at(-1).fn();
assert.equal(ports[1].disconnected, true);
assert.equal(nodes.get('logs-stream-state').dataset.state, 'retrying');
timeouts.at(-1).fn();
await settle();
assert.equal(ports.length, 3);

// Leaving the page closes the port and stops retrying.
windowListeners.pagehide();
assert.equal(ports[2].disconnected, true);
const afterLeave = timeouts.length;
ports[2].listeners.disconnect();
assert.equal(timeouts.length, afterLeave);
assert.equal(ports.length, 3);

console.log('tools log stream port open, delivery, silence watchdog, reconnect and retirement passed');
