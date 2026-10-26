import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ThroughputSession } from '../lib/throughput.js';
import { PanelObservation } from '../lib/panels.js';
import { SpikeApiClient } from '../lib/spike-client.js';
import { chronological } from '../lib/journal-export.js';
import { filterRuntimeLogs, formatRuntimeLogs, sortRuntimeLogs } from '../lib/runtime-logs.js';
import { ZH_MESSAGES } from '../lib/i18n-messages.js';

const task = values => ({ id: 1, revision: 1, direction: 'download', policy: 'Mock Policy', status: 'running',
  cancel_requested: false, created_at_unix_ms: 1000, byte_limit: 10000, bytes: 100, bytes_per_second: 50, ...values });
const receipt = value => ({ value, namespace: 'mock-runtime' });
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const originalFetch = globalThis.fetch;
const apiCalls = [];
try {
  globalThis.fetch = async (url, options) => {
    apiCalls.push({ url, options });
    return new Response(JSON.stringify(task()), { headers: { 'spike-control-runtime-namespace': 'mock-runtime' } });
  };
  const instance = { baseUrl: 'https://example.test', secret: 'mock-secret' };
  let namespace;
  await SpikeApiClient.getThroughputTests(instance, { onRuntime: value => { namespace = value; } });
  const options = { runtimeNamespace: namespace };
  await SpikeApiClient.startThroughputTest(instance, { direction: 'upload', policy: 'Mock Policy' }, options);
  await SpikeApiClient.getThroughputTest(instance, 1, options);
  await SpikeApiClient.cancelThroughputTest(instance, 1, options);
  assert.deepEqual(apiCalls.map(call => [call.options.method, call.url]), [
    ['GET', 'https://example.test/spike/throughput-tests?limit=20'], ['POST', 'https://example.test/spike/throughput-tests'],
    ['GET', 'https://example.test/spike/throughput-tests/1'], ['DELETE', 'https://example.test/spike/throughput-tests/1']
  ]);
  assert.deepEqual(JSON.parse(apiCalls[1].options.body), { direction: 'upload', policy: 'Mock Policy' });
  for (const call of apiCalls.slice(1)) assert.equal(call.options.headers.get('spike-control-runtime-namespace'), 'mock-runtime');
  globalThis.fetch = async () => new Response('{}', { status: 401 });
  await assert.rejects(() => SpikeApiClient.startThroughputTest(instance, {}, options), error => error.status === 401);
} finally { globalThis.fetch = originalFetch; }

const timers = new Map(), sessions = [];
const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
let next = 0;
globalThis.setTimeout = callback => { timers.set(++next, callback); return next; };
globalThis.clearTimeout = id => timers.delete(id);
const flush = () => new Promise(resolve => setImmediate(resolve));
const tick = async () => { const [id, callback] = timers.entries().next().value; timers.delete(id); callback(); await flush(); };
function fixture() {
  const calls = [], state = { task: task(), fail: false, updates: 0 };
  const api = {
    async list() { calls.push('list'); return receipt({ tasks: [state.task] }); },
    async start(body, ns) { calls.push(['start', body, ns]); return receipt(state.task); },
    async get(id, ns) { calls.push(['get', id, ns]); if (state.fail) throw new Error('mock-secret'); return receipt(state.task); },
    async cancel(id, ns) { calls.push(['cancel', id, ns]); return receipt({ ...state.task, status: 'cancelled' }); }
  };
  const session = new ThroughputSession(api, () => { state.updates++; }); sessions.push(session); return { calls, state, api, session };
}
try {
  const pending = fixture(); await pending.session.load(); const ack = defer();
  pending.api.start = async body => { pending.calls.push(['start', body]); return ack.promise; };
  const start = pending.session.start('upload', 'Mock Policy'); await pending.session.start('upload', 'Mock Policy'); await pending.session.cancel();
  pending.state.task = task({ direction: 'upload' }); ack.resolve(receipt(pending.state.task)); await start;
  assert.equal(pending.session.task.status, 'cancelled'); assert.equal(pending.session.tasks[0].status, 'cancelled');
  assert.equal(pending.calls.filter(call => Array.isArray(call) && call[0] === 'start').length, 1);

  const lost = fixture(); await lost.session.load();
  lost.api.start = async () => { lost.calls.push('lost-start'); throw new Error('mock-secret'); };
  await lost.session.start('download', 'Mock Policy'); await lost.session.start('download', 'Mock Policy');
  await lost.session.load(); assert.equal(lost.session.uncertain, true); assert.equal(lost.calls.filter(call => call === 'lost-start').length, 1);
  lost.session.observe(lost.session.tasks[0]); await flush(); assert.equal(lost.session.uncertain, false); lost.session.dispose();

  const retry = fixture(); await retry.session.load(); await retry.session.start('download', 'Mock Policy'); retry.state.fail = true;
  await tick(); await tick(); await tick(); assert.equal(timers.size, 0);
  assert.equal(retry.calls.filter(call => Array.isArray(call) && call[0] === 'get').length, 3);
  assert.equal(retry.session.task.status, 'running'); assert.match(retry.session.error, /Check status to resume/);
  retry.state.fail = false; retry.state.task = task({ status: 'completed', bytes: 10000 }); await retry.session.check();
  assert.equal(retry.session.tasks[0].bytes, 10000); assert.equal(retry.session.error, '');

  const stale = fixture(); await stale.session.load(); await stale.session.start('download', 'Mock Policy');
  const progress = defer(), listing = defer(); stale.api.get = () => progress.promise; stale.api.list = () => listing.promise;
  const oldGet = stale.session.check(), oldList = stale.session.load(); await stale.session.cancel();
  progress.resolve(receipt(task())); listing.resolve(receipt({ tasks: [task()] })); await oldGet; await oldList;
  assert.equal(stale.session.task.status, 'cancelled'); assert.equal(stale.session.tasks[0].status, 'cancelled'); assert.equal(timers.size, 0);

  const changed = fixture(); await changed.session.load(); await changed.session.start('download', 'Mock Policy');
  changed.api.list = async () => ({ namespace: 'mock-next', value: { tasks: [task({ created_at_unix_ms: 9000 })] } });
  await changed.session.load(); await changed.session.cancel(); assert.equal(changed.session.task, null);
  assert.ok(!changed.calls.some(call => Array.isArray(call) && call[0] === 'cancel'));

  const retired = fixture(); await retired.session.load(); const late = defer(); retired.api.start = () => late.promise;
  const lateStart = retired.session.start('download', 'Mock Policy'); retired.session.dispose(); const updates = retired.state.updates;
  late.resolve(receipt(task())); await lateStart; assert.equal(retired.state.updates, updates);

  const reused = fixture(); await reused.session.load(); await reused.session.start('download', 'Mock Policy');
  reused.state.task = task({ created_at_unix_ms: 9000 }); await reused.session.check(2);
  assert.equal(reused.session.task.created_at_unix_ms, 1000); reused.session.stopObserving(); assert.equal(reused.session.busy, false);
} finally {
  sessions.forEach(session => session.dispose()); globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
}

const nodes = new Map(), pagehide = [], calls = [], data = { tasks: [], namespace: 'mock-runtime', hold: null, acceptConfirm: true };
const node = tag => ({ tag, value: '', textContent: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {},
  classList: { add() {}, remove() {} }, addEventListener(name, callback) { this.listeners[name] = callback; },
  setAttribute(key, value) { this.attrs[key] = value; }, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; } });
const document = { hidden: true, addEventListener() {}, removeEventListener() {}, createElement: node,
  getElementById(id) { if (!nodes.has(id)) nodes.set(id, node('div')); return nodes.get(id); } };
const api = new Proxy({}, { get: (_, method) => async (_instance, ...args) => {
  calls.push(method); const options = args.at(-1);
  if (method.startsWith('getThroughput') || method.endsWith('ThroughputTest')) {
    options?.onRuntime?.(data.namespace);
    if (options.runtimeNamespace && options.runtimeNamespace !== data.namespace) throw Object.assign(new Error('mock-secret'), { status: 412 });
    if (method === 'getThroughputTests') return { tasks: data.tasks };
    if (method === 'startThroughputTest') { const value = task(args[0]); data.tasks = [value]; if (data.hold) await data.hold; return value; }
    if (method === 'cancelThroughputTest') { data.tasks[0] = { ...data.tasks[0], status: 'cancelled' }; return data.tasks[0]; }
    return data.tasks[0];
  }
  if (method === 'getReadiness') return { status: 'ready', checks: [] };
  if (method === 'getPolicies') return { policies: [{ name: 'Mock Policy', type: 'proxy' }, { name: 'REJECT', type: 'reject' }] };
  assert.ok(method.startsWith('get')); return {};
} });
const source = readFileSync(new URL('../tools.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\n/gm, '');
const context = vm.createContext({ document, console, ThroughputSession, PanelObservation, chronological, filterRuntimeLogs, formatRuntimeLogs, sortRuntimeLogs,
  SpikeApiClient: api, StorageManager: { init: async () => {}, getActiveInstance: async () => ({ id: 'mock-instance', baseUrl: 'https://example.test' }) },
  initializeI18n: async () => {}, t: value => value, window: { setInterval() {}, clearInterval() {}, setTimeout() {}, confirm: () => data.acceptConfirm,
    addEventListener(type, callback) { if (type === 'pagehide') pagehide.push(callback); } },
  chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => { throw new Error('mock stream unavailable'); } } } });
const descendants = root => [root, ...root.children.flatMap(descendants)];
try {
  await vm.runInContext(`(async()=>{${source}})()`, context);
  assert.equal(calls.filter(method => method === 'startThroughputTest').length, 0);
  assert.deepEqual(Array.from(nodes.get('throughput-policy').children, node => node.value), ['DIRECT', 'Mock Policy']);
  nodes.get('throughput-direction').value = 'upload'; nodes.get('throughput-policy').value = 'Mock Policy';
  const ack = defer(); data.hold = ack.promise;
  const submit = nodes.get('throughput-form').listeners.submit({ preventDefault() {} });
  assert.equal(nodes.get('throughput-start').disabled, true); await nodes.get('throughput-cancel').listeners.click();
  ack.resolve(); data.hold = null; await submit;
  const output = nodes.get('throughput-result');
  assert.ok(descendants(output).some(node => /Cancelled · Upload/.test(node.textContent)));
  assert.equal(calls.filter(method => method === 'cancelThroughputTest').length, 1);
  assert.ok(descendants(output).some(node => node.tag === 'progress' && node.attrs['aria-label'] === 'Transferred bytes'));
  assert.ok(descendants(output).some(node => node.dataset.i18nIgnore === '' && node.textContent === 'Mock Policy'));
  const stop = descendants(output).find(node => node.textContent === 'Stop observing');
  data.acceptConfirm = false; stop.listeners.click(); assert.ok(descendants(output).some(node => node.tag === 'progress'));
  data.acceptConfirm = true; stop.listeners.click(); assert.ok(!descendants(output).some(node => node.tag === 'progress'));
  for (const key of ['Policy throughput test', 'Start throughput test', 'Cancel throughput test', 'Download', 'Upload', 'Queued', 'Running', 'Completed', 'Cancelled',
    'Transferred bytes', 'Recent throughput tests', 'Check task status', 'Stop observing', 'Cancellation is unconfirmed. Check task status before retrying.',
    'Start result is unconfirmed. Check recent tasks before starting again.']) assert.ok(ZH_MESSAGES[key], key);
} finally { pagehide.forEach(callback => callback()); }
console.log('Throughput API/state/actual Tools controls cover both directions, progress, pending cancel, three-attempt reads, unknown starts, namespace/ID reuse, stale history, confirmation and closure');
