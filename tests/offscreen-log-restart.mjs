import assert from 'node:assert/strict';
import { StorageManager } from '../lib/storage.js';
import { SpikeApiClient } from '../lib/spike-client.js';

const messages = [];
const timers = new Map();
const streams = [];
const listeners = {};
const original = {
  setTimeout, clearTimeout, setInterval, clearInterval,
  init: StorageManager.init, active: StorageManager.getActiveInstance,
  stream: SpikeApiClient.streamLogs,
};
let instance = { id: 'mock-instance', baseUrl: 'http://control.example.test' };
globalThis.chrome = {
  storage: {
    local: { get: async () => ({}) },
    onChanged: { addListener: (listener) => { listeners.changed = listener; } },
  },
  runtime: {
    sendMessage: async (message) => { messages.push(message); },
    onMessage: { addListener: (listener) => { listeners.message = listener; } },
  },
};
globalThis.setTimeout = (callback, delay) => { const id = {}; timers.set(id, { callback, delay }); return id; };
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.setInterval = () => ({});
globalThis.clearInterval = () => {};
StorageManager.init = async () => {};
StorageManager.getActiveInstance = async () => instance;
SpikeApiClient.streamLogs = async (_instance, options) => {
  options.onOpen();
  await new Promise((resolve) => streams.push({ options, resolve }));
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const runTimer = async () => {
  const [id, timer] = timers.entries().next().value ?? [];
  assert.ok(timer, 'expected scheduled reconnect');
  timers.delete(id);
  timer.callback();
  await settle();
};
const hello = (stream, namespace, reset = false) => stream.options.onMessage({
  event: 'stream', data: { event_namespace: namespace, reset },
});
const log = (stream, namespace, sequence) => stream.options.onMessage({
  event: 'log', data: { event_namespace: namespace, sequence, message: 'fixture' },
});
const entries = () => messages.filter((message) => message.type === 'SPIKE_LOG_STREAM_ENTRY');
try {
  await import('../offscreen.js');
  await settle();
  await runTimer();
  hello(streams[0], 'boot-a');
  log(streams[0], 'boot-a', 100000);
  streams[0].resolve();
  await settle();
  await runTimer();
  assert.equal(streams[1].options.namespace, 'boot-a');
  assert.equal(streams[1].options.after, 100000);
  hello(streams[1], 'boot-b', true);
  log(streams[1], 'boot-b', 1);
  assert.equal(entries().at(-1).entry.sequence, 1);
  assert.equal(entries().at(-1).entry.event_namespace, 'boot-b');
  streams[1].options.onMessage({ event: 'gap', data: { reason: 'history_evicted' } });
  assert.equal(streams[1].options.signal.aborted, false, 'retained replay follows gap on same stream');
  log(streams[1], 'boot-b', 2);
  assert.equal(entries().at(-1).entry.sequence, 2);
  streams[1].resolve();
  await settle();
  await runTimer();
  hello(streams[2], 'boot-c', true);
  log(streams[2], 'boot-c', 2);
  assert.equal(entries().at(-1).entry.event_namespace, 'boot-c', 'equal sequence in new process is not a duplicate');
  instance = { id: 'second-mock-instance', baseUrl: 'http://second.example.test' };
  listeners.changed({ activeInstanceId: { newValue: instance.id } }, 'local');
  await runTimer();
  const count = entries().length;
  log(streams[2], 'boot-c', 200000);
  assert.equal(entries().length, count, 'old stream cannot publish into the new instance');
  assert.equal(streams[3].options.after, 0);
  assert.equal(streams[3].options.namespace, '');
  console.log('offscreen namespace resume, restart, gap replay, and generation isolation passed');
} finally {
  Object.assign(globalThis, {
    setTimeout: original.setTimeout, clearTimeout: original.clearTimeout,
    setInterval: original.setInterval, clearInterval: original.clearInterval,
  });
  StorageManager.init = original.init;
  StorageManager.getActiveInstance = original.active;
  SpikeApiClient.streamLogs = original.stream;
}
