import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PanelObservation } from '../lib/panels.js';
import { SpikeApiClient } from '../lib/spike-client.js';

const source = readFileSync(new URL('../tools.js', import.meta.url), 'utf8');
const elements = new Map();
const node = tag => ({ tag, children: [], dataset: {}, style: {}, attrs: {}, listeners: {},
  append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
  setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(key, value) { this.listeners[key] = value; } });
const text = (tag, value, className, userContent) => Object.assign(node(tag), { textContent: value, className, userContent });
const byId = id => { if (!elements.has(id)) elements.set(id, node('div')); return elements.get(id); };
const descendants = root => [root, ...root.children.flatMap(descendants)];
const record = (name, script = null) => ({ name, script_name: script, title: `Mock ${name}`, content: '<script>mock-code</script>',
  style: 'good', icon: '__proto__', icon_color: '#abc', last_updated_at_unix: 1 });
let data = [record('static'), record('mock / name', 'mock-script'), record('second', 'mock-script')];
let revision = 1, namespace = 'mock-a', failList = false, failRefresh = false, hold, release;
const reads = [], writes = [];
let render, updates = 0;
const panels = new PanelObservation({
  async read(onRuntime) { reads.push(true); onRuntime(namespace); if (failList) throw new Error('mock-secret'); return { ok: true, revision, panels: data }; },
  async refresh(name, onRuntime) {
    writes.push(name); onRuntime(namespace);
    const response = { ok: !failRefresh, revision, panel: { ...record(name, 'mock-script'), content: 'Mock updated', error: failRefresh ? 'mock-secret' : null } };
    if (hold) await hold; return response;
  }
}, () => { updates++; render(); });
render = new Function('panels', 'byId', 'text', 'document', 't',
  source.slice(source.indexOf('function renderPanels('), source.indexOf('function connectionRow(')) + '\nreturn renderPanels;')(
  panels, byId, text, { createElement: node }, value => value);
const buttons = () => descendants(byId('panels')).filter(item => item.tag === 'button');
const button = name => buttons().find(item => item.attrs['aria-label'] === `刷新面板 ${name}`);
await panels.load();
assert.equal(writes.length, 0); assert.equal(buttons().length, 2);
assert.equal(descendants(byId('panels')).find(item => item.tag === 'pre').textContent, '<script>mock-code</script>');
assert.ok(descendants(byId('panels')).filter(item => item.tag === 'pre' || item.tag === 'h3').every(item => item.userContent));
assert.equal(descendants(byId('panels')).find(item => item.tag === 'span').textContent, 'ⓘ');
assert.equal(descendants(byId('panels')).find(item => item.tag === 'span').style.color, '#abc');
hold = new Promise(resolve => { release = resolve; });
const first = button('mock / name').listeners.click();
assert.equal(button('mock / name').disabled, true); assert.ok(!button('second').disabled);
await button('mock / name').listeners.click();
await panels.load(); assert.equal(reads.length, 1); assert.deepEqual(writes, ['mock / name']);
release(); hold = null; await first;
assert.equal(panels.panels[1].content, 'Mock updated');
failRefresh = true; await button('mock / name').listeners.click();
assert.equal(panels.panels[1].content, 'Mock updated');
assert.equal(panels.errors.has('mock / name'), true);
assert.doesNotMatch(descendants(byId('panels')).map(item => item.textContent).join(' '), /mock-secret/);
failRefresh = false; failList = true; await panels.load(); assert.equal(panels.panels.length, 3); assert.equal(panels.error, true);
failList = false; revision = 2; data = [record('new profile')];
await button('mock / name').listeners.click(); assert.equal(panels.panels[0].name, 'new profile');
data = [record('mock / name', 'mock-script')]; await panels.load();
namespace = 'mock-b'; data = [record('new runtime')];
await button('mock / name').listeners.click(); assert.equal(panels.panels[0].name, 'new runtime');
data = [record('mock / name', 'mock-script')]; await panels.load();
hold = new Promise(resolve => { release = resolve; }); const old = panels.refresh('mock / name');
data = [record('current runtime')]; panels.runtime('mock-c');
await new Promise(resolve => setTimeout(resolve, 0));
release(); hold = null; await old;
assert.equal(panels.panels[0].name, 'current runtime'); assert.equal(panels.pending.size, 0);
data = [record('mock / name', 'mock-script')]; await panels.load();
hold = new Promise(resolve => { release = resolve; }); const retired = panels.refresh('mock / name');
panels.retire(); const before = updates; release(); await retired; assert.equal(updates, before);

const oldFetch = globalThis.fetch;
const calls = [];
try {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify({ ok: true }), {
      headers: { 'spike-control-runtime-namespace': 'mock-api' }
    });
  };
  const instance = { baseUrl: 'https://example.test', secret: 'mock-secret' };
  let received;
  await SpikeApiClient.getPanels(instance, { onRuntime: value => { received = value; } });
  await SpikeApiClient.refreshPanel(instance, 'mock / name');
  assert.equal(received, 'mock-api'); assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].url, 'https://example.test/spike/panels/mock%20%2F%20name/refresh');
  assert.equal(calls[1].options.method, 'POST'); assert.deepEqual(JSON.parse(calls[1].options.body), { trigger: 'button' });
  assert.equal(calls[1].options.headers.get('Authorization'), 'Bearer mock-secret');
} finally { globalThis.fetch = oldFetch; }
assert.match(source, /panels\.load\(\)/); assert.match(source, /panels\.retire\(\)/);
console.log('Actual Tools panel rendering and API cover safe content, static/script actions, retained errors, duplicate guards, revision/runtime retirement and close');
