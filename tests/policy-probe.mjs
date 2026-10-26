import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { policyProbeRequest } from '../lib/policy-probe.js';
import { SpikeApiClient } from '../lib/spike-client.js';
import { ThroughputSession } from '../lib/throughput.js';
import { PanelObservation } from '../lib/panels.js';
import { chronological } from '../lib/journal-export.js';
import { filterRuntimeLogs, formatRuntimeLogs, sortRuntimeLogs } from '../lib/runtime-logs.js';
import { ZH_MESSAGES } from '../lib/i18n-messages.js';
const names = Array.from({ length: 17 }, (_, index) => 'Mock ' + index);
const url = 'https://example.test/mock?all=1&raw=1';
assert.deepEqual(policyProbeRequest(names.slice(0, 16), url, names), { policy_names: names.slice(0, 16), url });
assert.deepEqual(policyProbeRequest(['Mock 0', 'Mock 0'], url, names).policy_names, ['Mock 0']);
for (const selected of [[], names, ['unknown']]) assert.throws(() => policyProbeRequest(selected, url, names), /1 and 16/);
for (const invalid of ['', '/mock', 'ftp://example.test/mock', 'mock']) assert.throws(() => policyProbeRequest(['Mock 0'], invalid, names), /HTTP or HTTPS/);
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (endpoint, options) => {
    assert.equal(endpoint, 'https://example.test/spike/policies/test'); assert.equal(options.method, 'POST');
    assert.equal(options.headers.get('spike-control-runtime-namespace'), 'mock-runtime');
    assert.deepEqual(JSON.parse(options.body), { policy_names: ['Mock 0'], url });
    return new Response('{"results":[]}', { headers: { 'spike-control-runtime-namespace': 'mock-runtime' } });
  };
  await SpikeApiClient.probePolicies({ baseUrl: 'https://example.test', secret: 'mock-secret' }, { policy_names: ['Mock 0'], url }, { runtimeNamespace: 'mock-runtime' });
} finally { globalThis.fetch = originalFetch; }

const nodes = new Map(), pagehide = [], calls = [];
let namespace = 'mock-runtime', hold, release, fail = false, listHold;
const node = tag => ({ tag, value: '', selectedOptions: [], dataset: {}, style: {}, attrs: {}, children: [], listeners: {},
  classList: { add() {}, remove() {} }, addEventListener(type, callback) { this.listeners[type] = callback; },
  setAttribute(key, value) { this.attrs[key] = value; }, append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; } });
const document = { hidden: true, addEventListener() {}, removeEventListener() {}, createElement: node,
  getElementById(id) { if (!nodes.has(id)) nodes.set(id, node('div')); return nodes.get(id); } };
const api = new Proxy({}, { get: (_, method) => async (_instance, ...args) => {
  if (method === 'getReadiness') return { status: 'ready', checks: [] };
  if (method === 'getEvents' || method === 'getLogs') return { event_namespace: namespace };
  if (method === 'getPolicies') { args[0]?.onRuntime?.(namespace); if (listHold) await listHold; return { policies: names.map(name => ({ name, type: 'proxy' })) }; }
  if (method === 'probePolicies') {
    calls.push({ body: structuredClone(args[0]), namespace: args[1].runtimeNamespace });
    const observed = namespace; if (hold) await hold;
    if (fail) throw new Error('mock-secret https://example.test/mock?token=mock-secret');
    args[1].onRuntime(observed);
    return { ok: false, results: [{ policy: 'Mock 0', ok: true, latency_ms: 0 }, { policy: 'Mock 1', ok: false, error: 'mock-secret' }] };
  }
  assert.ok(method.startsWith('get')); return {};
} });
const context = vm.createContext({ document, console, policyProbeRequest, ThroughputSession, PanelObservation, chronological, filterRuntimeLogs, formatRuntimeLogs, sortRuntimeLogs,
  SpikeApiClient: api, initializeI18n: async () => {}, t: value => value,
  StorageManager: { init: async () => {}, getActiveInstance: async () => ({ id: 'mock-instance', baseUrl: 'https://example.test' }) },
  window: { setInterval() {}, clearInterval() {}, setTimeout() {}, addEventListener(type, callback) { if (type === 'pagehide') pagehide.push(callback); } },
  chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => { throw new Error('mock stream unavailable'); } } } });
const source = readFileSync(new URL('../tools.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\n/gm, '');
const descendants = root => [root, ...root.children.flatMap(descendants)];
const output = () => descendants(nodes.get('policy-probe-results')).map(node => node.textContent || '').join(' ');
const submit = () => nodes.get('policy-probe-form').listeners.submit({ preventDefault() {} });
try {
  await vm.runInContext(`(async()=>{${source}})()`, context);
  assert.equal(calls.length, 0, 'opening never probes');
  document.getElementById('policy-probe-url').value = url;
  nodes.get('policy-probe-policies').selectedOptions = [];
  await submit(); assert.equal(calls.length, 0); assert.match(nodes.get('policy-probe-error').textContent, /1 and 16/);
  nodes.get('policy-probe-policies').selectedOptions = names.slice(0, 3).map(value => ({ value }));
  await submit(); assert.deepEqual(calls[0], { body: { policy_names: names.slice(0, 3), url }, namespace: 'mock-runtime' });
  assert.match(output(), /0 ms/); assert.match(output(), /Failed/); assert.match(output(), /No result/); assert.doesNotMatch(output(), /mock-secret/);
  fail = true; await submit(); assert.match(nodes.get('policy-probe-error').textContent, /Check the URL/);
  assert.doesNotMatch(nodes.get('policy-probe-error').textContent, /mock-secret/); assert.equal(output(), ''); fail = false;
  hold = new Promise(resolve => { release = resolve; }); const running = submit();
  assert.equal(nodes.get('policy-probe-start').disabled, true); const count = calls.length; await submit(); assert.equal(calls.length, count);
  namespace = 'mock-next'; await nodes.get('events-refresh').listeners.click();
  release(); hold = null; await running;
  assert.equal(output(), ''); assert.equal(nodes.get('policy-probe-start').disabled, true, 'a runtime change requires a new catalog read');
  await nodes.get('refresh-all').listeners.click(); assert.equal(nodes.get('policy-probe-start').disabled, false);
  let releaseCatalog;
  listHold = new Promise(resolve => { releaseCatalog = resolve; });
  const readingCatalog = nodes.get('refresh-all').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  hold = new Promise(resolve => { release = resolve; }); const withOldCatalog = submit();
  releaseCatalog(); listHold = null; await readingCatalog;
  assert.equal(nodes.get('policy-probe-start').disabled, true, 'a late catalog read cannot unlock or retire an active probe');
  release(); hold = null; await withOldCatalog;
  assert.equal(nodes.get('policy-probe-start').disabled, false);
  hold = new Promise(resolve => { release = resolve; }); const closing = submit(); pagehide.forEach(callback => callback()); release(); hold = null; await closing;
  assert.doesNotMatch(output(), /0 ms/);
  for (const key of ['Custom URL policy probe', 'Probe URL', 'Probe selected policies', 'Select between 1 and 16 known policies.',
    'Enter an absolute HTTP or HTTPS probe URL.', 'Policy probe failed. Check the URL, policy selection and runtime, then retry.']) assert.ok(ZH_MESSAGES[key], key);
} finally { release?.(); pagehide.forEach(callback => callback()); }
console.log('Custom policy probe request/API/actual Tools handlers enforce 1–16 known policies, preserve URL queries, show partial/zero-ms results safely and reject duplicate/stale/closed observations');
