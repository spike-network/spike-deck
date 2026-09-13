import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const nodes = new Map();
const node = () => ({ value: '', dataset: {}, classList: { add() {}, remove() {} },
  listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; },
  append() {}, replaceChildren() {}, focus() {} });
const timers = [];
const document = { hidden: false, listeners: {},
  getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
  createElement: node,
  addEventListener(name, fn) { this.listeners[name] = fn; }, removeEventListener() {} };
let sequence = 100;
let namespace = 'boot-a';
let reads = 0;
let hold;
let fail = false;
const api = new Proxy({}, { get: (_, key) => key === 'getLogs' ? async () => {
  reads++;
  if (hold) await hold;
  if (fail) throw new Error('offline');
  return { event_namespace: namespace, entries: [{ sequence, message: `log-${sequence}` }] };
} : async () => ({}) });
const context = vm.createContext({ document, console,
  window: { setInterval(fn) { timers.push(fn); return 1; }, clearInterval() {},
    setTimeout() {}, addEventListener() {} },
  chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => { throw new Error('stream unavailable'); } } },
  SpikeApiClient: api, StorageManager: { init: async () => {}, getActiveInstance: async () => ({ id: 'fixture' }) },
  initializeI18n: async () => {}, t: (value) => value,
  filterRuntimeLogs: (entries) => entries, sortRuntimeLogs: (entries) => entries,
  formatRuntimeLogs: (entries) => entries.map((entry) => entry.message).join('\n'),
});
const source = fs.readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '');
await vm.runInContext(`(async () => { ${source} })()`, context);
const settle = () => new Promise((resolve) => setImmediate(resolve));
assert.match(nodes.get('logs-output').textContent, /log-100/);
sequence++;
timers[0](); await settle();
assert.match(nodes.get('logs-output').textContent, /log-101/);
nodes.get('logs-view-clear').listeners.click();
timers[0](); await settle();
assert.doesNotMatch(nodes.get('logs-output').textContent, /log-10/);
namespace = 'boot-b'; sequence = 1;
timers[0](); await settle();
assert.match(nodes.get('logs-output').textContent, /log-1/);
let release;
hold = new Promise((resolve) => { release = resolve; });
const before = reads;
timers[0](); timers[0](); await settle();
assert.equal(reads, before + 1);
release(); await settle(); hold = null;
document.hidden = true;
const hiddenReads = reads; timers[0](); await settle(); assert.equal(reads, hiddenReads);
document.hidden = false; sequence = 2;
document.listeners.visibilitychange(); await settle();
assert.match(nodes.get('logs-output').textContent, /log-2/);
fail = true; timers[0](); await settle();
fail = false; sequence = 3; timers[0](); await settle();
assert.match(nodes.get('logs-output').textContent, /log-3/);
console.log('tools log polling, stream startup failure, clear, restart, admission and recovery passed');
