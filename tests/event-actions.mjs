import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const tools = readFileSync(new URL('../tools.js', import.meta.url), 'utf8');
const popup = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const node = (tag, textContent = '') => ({ tag, textContent, children: [], append(...children) { this.children.push(...children); } });
const { eventDestination, eventRow } = new Function('document', 'text', 't',
  tools.slice(tools.indexOf('function eventDestination('), tools.indexOf('async function loadEvents(')) +
  '\nreturn {eventDestination,eventRow};')({ createElement: node }, node, value => `translated:${value}`);
const targets = { overview: 'popup.html#event-overview', groups: 'popup.html#event-groups',
  providers: 'popup.html#event-providers', config: 'popup.html#event-config',
  connections: '#connections', diagnostics: '#route-form', events: '#events', logs: '#logs-output' };
for (const [target, href] of Object.entries(targets)) {
  assert.equal(eventDestination(target).href, href);
  const row = eventRow({ action: { target, label: 'mock-action' } });
  const link = row.children.at(-1).children[0];
  assert.equal(link.tag, 'a'); assert.equal(link.href, href);
  assert.match(link.textContent, /^translated:/);
  if (href.startsWith('popup')) { assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener'); }
}
for (const target of ['unknown', 'https://example.test/', 'javascript:mock', '__proto__', undefined]) {
  assert.equal(eventDestination(target), null);
  const row = eventRow({ action: { target, label: 'mock-readable-action' } });
  const action = row.children.at(-1).children[0];
  assert.equal(action.tag, 'span'); assert.equal(action.textContent, 'mock-readable-action');
}
const calls = [];
let providerFailure = false;
const notices = [];
const route = new Function('openProvidersPanel', 'setQuickPanel', 'quickPanelProfile', 'groupsContainer', 'window', 'showToast',
  popup.slice(popup.indexOf('  function applyEventAction('), popup.indexOf('  // Initial load')) + '\nreturn applyEventAction;')(
  async () => { calls.push('providers'); if (providerFailure) throw new Error('mock-secret'); }, value => calls.push(value),
  { scrollIntoView: () => calls.push('profile-scroll') }, { scrollIntoView: () => calls.push('groups-scroll') },
  { scrollTo: (...args) => calls.push(args) }, message => notices.push(message));
for (const hash of ['#event-providers', '#event-config', '#event-groups', '#event-overview']) assert.equal(route(hash), true);
assert.deepEqual(calls, ['providers', 'profile', 'profile-scroll', 'groups-scroll', [0, 0]]);
for (const hash of ['#unknown', '#event-https://example.test/', undefined]) assert.equal(route(hash), false);
providerFailure = true;
route('#event-providers');
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(notices, ['无法打开外部资源，请重试。']);
assert.match(popup, /loadDashboard\(\)\s*\.catch\([^\n]*\)\s*\.then\(\(\) => applyEventAction\(window.location\?\.hash\)\)/,
  'a failed dashboard load still applies the event destination');
console.log('Actual event row links and popup dispatcher cover all fixed destinations and non-executable fallbacks');
