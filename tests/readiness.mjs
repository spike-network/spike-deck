import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { chronological } from '../lib/journal-export.js';
import { PanelObservation } from '../lib/panels.js';
import { ThroughputSession } from '../lib/throughput.js';
import { SpikeApiClient } from "../lib/spike-client.js";

const instance = { id: "mock-instance", baseUrl: "https://example.test", secret: "mock-secret" };
const report = { schema_version: 1, ok: false, status: "not_ready", revision: 3,
  checks: [{ name: "providers", status: "not_ready", reason: "providers_missing", active: 1, expected: 3 }] };
const originalFetch = globalThis.fetch;
let status = 503, body = report;
try {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://example.test/spike/ready");
    assert.equal(options.headers.get("Authorization"), "Bearer mock-secret");
    return new Response(JSON.stringify(body), { status });
  };
  assert.deepEqual(await SpikeApiClient.getReadiness(instance), report);
  status = 200; body = { ...report, ok: true, status: "degraded" };
  assert.equal((await SpikeApiClient.getReadiness(instance)).status, "degraded");
  for (const invalid of [{}, { ...report, ok: true }, { ...report, status: ["ready"] },
    { ...report, checks: [{ ...report.checks[0], active: -1 }] },
    { ...report, checks: [{ ...report.checks[0], reason: "https://example.test/mock-secret" }] }]) {
    body = invalid;
    await assert.rejects(SpikeApiClient.getReadiness(instance), /Invalid readiness response/);
  }
  for (const code of [401, 403, 404, 500]) {
    status = code; body = report;
    await assert.rejects(SpikeApiClient.getReadiness(instance));
  }
  status = 503;
  await assert.rejects(SpikeApiClient.request(instance, '/spike/ready', { method: 'POST', allowNotReady: true }), error => error.status === 503);
  globalThis.fetch = async () => new Response(JSON.stringify(report), { status: 503 });
  await assert.rejects(SpikeApiClient.request(instance, '/spike/status', { allowNotReady: true }), error => error.status === 503);
} finally { globalThis.fetch = originalFetch; }

const nodes = new Map();
const node = () => ({ value: '', dataset: {}, children: [], classList: { add() {}, remove() {} },
  listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; },
  append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, focus() {} });
const document = { hidden: true, getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
  createElement: node, addEventListener() {}, removeEventListener() {} };
let current = report, failure, pending;
const api = new Proxy({}, { get: (_, key) => key === 'getReadiness' ? async () => {
  if (pending) { const result = pending; pending = null; return result; }
  if (failure) throw failure;
  return current;
} : async () => ({}) });
const context = vm.createContext({ document, console, window: { setInterval() {}, clearInterval() {}, setTimeout() {}, addEventListener() {} },
  chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => { throw new Error('mock stream unavailable'); } } },
  SpikeApiClient: api, StorageManager: { init: async () => {}, getActiveInstance: async () => instance },
  initializeI18n: async () => {}, t: value => value,
  filterRuntimeLogs: entries => entries, sortRuntimeLogs: entries => entries, formatRuntimeLogs: () => '',
});
const source = fs.readFileSync(new URL('../tools.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\n/gm, '');
context.chronological = chronological;
context.PanelObservation = PanelObservation;
context.ThroughputSession = ThroughputSession;
await vm.runInContext(`(async () => { ${source} })()`, context);
const content = () => JSON.stringify(nodes.get('readiness'));
assert.match(content(), /未就绪/);
assert.match(content(), /providers_missing/);
assert.match(content(), /1 \/ 3/);
failure = new Error('mock-secret must not appear');
await nodes.get('readiness-refresh').listeners.click();
assert.match(content(), /无法读取就绪检查/);
assert.doesNotMatch(content(), /mock-secret|providers_missing/);
assert.equal(nodes.get('readiness-refresh').disabled, false);
failure = Object.assign(new Error('mock missing endpoint'), { status: 404 });
await nodes.get('readiness-refresh').listeners.click();
assert.match(content(), /不支持就绪检查/);
failure = null;
let release;
pending = new Promise(resolve => { release = resolve; });
const old = nodes.get('readiness-refresh').listeners.click();
current = { ...report, ok: true, status: 'ready', checks: [] };
await nodes.get('readiness-refresh').listeners.click();
release(report); await old;
assert.match(content(), /就绪/);
assert.doesNotMatch(content(), /未就绪|providers_missing/);
console.log('Readiness API validation, HTTP status boundaries, tool rendering and stale-read recovery passed');
