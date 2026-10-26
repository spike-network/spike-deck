import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chronological } from '../lib/journal-export.js';
import { PanelObservation } from '../lib/panels.js';
import { connectionDetailFields } from '../lib/connection-trace.js';

const instance = { id: 'mock-instance', baseUrl: 'https://example.test', secret: 'mock-secret' };
const live = [{ id: 11, host: 'alpha.example.test', peer: '192.0.2.1:4000', port: 443, policy: 'Mock Alpha', kind: 'tcp', ok: true,
  process: {pid:42,name:'mock-service',path:'/mock-bin/mock-service'},
  decision_trace:{route:{group_steps:[{group:'Mock Outer',selected:'Mock Leaf',stage:'selected'}]}},
  timeline:[{elapsed_us:1234,phase:'establish',duration_us:1234,category:'connect',message:'mock connected'}]},
  { id: 22, host: 'beta.example.test', peer: '192.0.2.2:5000', port: 53, policy: 'Mock Beta', kind: 'udp', ok: true }];
const recent = [{ id: 33, host: 'old.example.test', peer: '192.0.2.1:6000', port: 443, policy: 'Mock Old', kind: 'tcp', ok: false }];
const nodes = new Map();
const node = () => ({ value: '', dataset: {}, children: [], classList: { add() {}, remove() {} }, listeners: {},
  addEventListener(name, fn) { this.listeners[name] = fn; }, append(...items) { this.children.push(...items); },
  replaceChildren(...items) { this.children = items; }, focus() {} });
const document = { hidden: true, getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
  createElement: node, addEventListener() {}, removeEventListener() {} };
let reads = 0;
const kills = [];
const api = new Proxy({}, { get: (_, key) => key === 'getConnections' ? async () => { reads++; return { live, recent }; }
  : key === 'killConnection' ? async (_instance, id) => { kills.push(id); } : async () => ({}) });
const context = vm.createContext({ document, console,
  window: { confirm: () => true, setInterval() {}, clearInterval() {}, setTimeout() {}, addEventListener() {} },
  chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => { throw new Error('mock stream unavailable'); } } },
  SpikeApiClient: api, StorageManager: { init: async () => {}, getActiveInstance: async () => instance },
  initializeI18n: async () => {}, t: value => value, formatConnectionTrace: () => '', connectionDetailFields,
  filterRuntimeLogs: entries => entries, sortRuntimeLogs: entries => entries, formatRuntimeLogs: () => '',
});
const source = fs.readFileSync(new URL('../tools.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\n/gm, '');
context.chronological = chronological;
context.PanelObservation = PanelObservation;
await vm.runInContext(`(async () => { ${source} })()`, context);
const content = () => JSON.stringify(nodes.get('connections'));
const query = nodes.get('connections-filter');
const state = nodes.get('connections-state');
const initialReads = reads;
assert.equal(nodes.get('connections-count').textContent, '3 / 3');
assert.match(content(), /mock-service/);
assert.match(content(), /Mock Outer → Mock Leaf/);
assert.match(content(), /1.2 ms/);
query.value = 'MOCK BETA'; query.listeners.input();
assert.match(content(), /beta.example.test/); assert.doesNotMatch(content(), /alpha.example.test|old.example.test/);
assert.equal(nodes.get('connections-count').textContent, '1 / 3');
query.value = '192.0.2.1'; query.listeners.input();
assert.match(content(), /alpha.example.test/); assert.match(content(), /old.example.test/);
state.value = 'failed'; state.listeners.change();
assert.match(content(), /old.example.test/); assert.doesNotMatch(content(), /alpha.example.test/);
query.value = 'mock-no-match'; query.listeners.input();
assert.match(content(), /暂无匹配连接/);
query.value = ''; state.value = 'all'; query.listeners.input();
assert.equal(nodes.get('connections-count').textContent, '3 / 3');
assert.equal(reads, initialReads, 'filtering must use the cached snapshot');
assert.deepEqual(kills, [], 'filtering must not mutate any connection');
query.value = 'beta'; query.listeners.input();
const visit = item => [item, ...(item?.children || []).flatMap(visit)];
const kill = visit(nodes.get('connections')).find(item => item?.textContent === 'Kill');
await kill.listeners.click();
assert.deepEqual(kills, [22], 'filtered actions use the original connection ID');
console.log('Actual Tools search/state handlers preserve cached snapshots, counts and live action IDs');
