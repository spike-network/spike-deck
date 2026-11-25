import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { ConnectionMirror } from '../lib/connection-mirror.js';
import { supportsRefreshModel, validateControlApiInfo } from '../lib/control-api-contract.js';
import { SpikeApiClient } from '../lib/spike-client.js';
import { coreError, requestErrorText, statusError } from '../lib/core-error.js';
import { msg } from '../lib/i18n.js';
import { isRejectPolicy } from '../lib/group-selection.js';
import { chronological, downloadJournal } from '../lib/journal-export.js';
import { PanelObservation } from '../lib/panels.js';
import { ThroughputSession } from '../lib/throughput.js';
import { formatConnectionTrace, connectionDetailFields, connectionMethod } from '../lib/connection-trace.js';
import { routeContext } from '../lib/route-context.js';
import { policyProbeRequest } from '../lib/policy-probe.js';
import { reloadView, reloadStatusView } from '../lib/reload-view.js';

const rec = (id, extra = {}) => ({ id, host: `h${id}.example.test`, upload_bytes: 0, download_bytes: 0, ...extra });
const mirror = new ConnectionMirror();

// Reset: complete lists.
assert.equal(mirror.apply({
  reset: true, cursor: 'a-5-1-0', revision: 5,
  live: [rec(2), rec(1)], removed_live_ids: [], live_stats: [], recent: [rec(9)], recent_ids: [9]
}), true);
assert.deepEqual(mirror.snapshot().live.map((r) => r.id), [1, 2]);
assert.equal(mirror.cursor, 'a-5-1-0');
assert.equal(mirror.snapshot().sequence, 5);

// Counters alone are not a list change.
assert.equal(mirror.apply({
  reset: false, cursor: 'a-5-1-0', revision: 5, live: [], removed_live_ids: [],
  live_stats: [{ id: 1, upload_bytes: 10, download_bytes: 20, duration_ms: 30, modified: true }],
  recent: [], recent_ids: [9]
}), false);
assert.deepEqual(
  [mirror.live.get(1).upload_bytes, mirror.live.get(1).download_bytes, mirror.live.get(1).duration_ms, mirror.live.get(1).modified],
  [10, 20, 30, true]
);

// A live connection finishes: removed from live and added to recent, newest first.
assert.equal(mirror.apply({
  reset: false, cursor: 'a-6-2-0', revision: 6, live: [rec(3)], removed_live_ids: [1],
  live_stats: [{ id: 3, upload_bytes: 1, download_bytes: 1, duration_ms: 1 }, { id: 2, upload_bytes: 0, download_bytes: 0, duration_ms: 5 }],
  recent: [rec(1)], recent_ids: [1, 9]
}), true);
assert.deepEqual(mirror.snapshot().live.map((r) => r.id), [2, 3]);
assert.deepEqual(mirror.snapshot().recent.map((r) => r.id), [1, 9]);

// Records that left the recent list are dropped.
assert.equal(mirror.apply({
  reset: false, cursor: 'a-6-2-0', revision: 6, live: [], removed_live_ids: [], live_stats: [], recent: [], recent_ids: [1]
}), true);
assert.deepEqual(mirror.snapshot().recent.map((r) => r.id), [1]);

// A stale cursor comes back as reset and discards everything held.
mirror.apply({ reset: true, cursor: 'b-1-0-0', revision: 1, live: [rec(7)], removed_live_ids: [], live_stats: [], recent: [], recent_ids: [] });
assert.deepEqual(mirror.snapshot(), { sequence: 1, live: [rec(7)], recent: [] });
assert.equal(mirror.resetRequired, false);

// Unknown live_stats ID flags resync without advancing cursor/revision or mutating state.
assert.equal(mirror.apply({
  reset: false, cursor: 'b-2-0-0', revision: 2, live: [], removed_live_ids: [],
  live_stats: [{ id: 99, upload_bytes: 5, download_bytes: 6, duration_ms: 7 }],
  recent: [], recent_ids: []
}), null);
assert.equal(mirror.resetRequired, true);
assert.equal(mirror.cursor, 'b-1-0-0');
assert.equal(mirror.revision, 1);
assert.deepEqual(mirror.snapshot(), { sequence: 1, live: [rec(7)], recent: [] });

// Missing recent_ids record flags resync without advancing cursor/revision or mutating state.
mirror.reset();
assert.equal(mirror.resetRequired, false);
assert.equal(mirror.apply({
  reset: true, cursor: 'c-1-1-0', revision: 1, live: [rec(4)], removed_live_ids: [],
  live_stats: [], recent: [rec(8)], recent_ids: [8]
}), true);
assert.equal(mirror.apply({
  reset: false, cursor: 'c-2-2-0', revision: 2, live: [], removed_live_ids: [],
  live_stats: [], recent: [], recent_ids: [88, 8]
}), null);
assert.equal(mirror.resetRequired, true);
assert.equal(mirror.cursor, 'c-1-1-0');
assert.equal(mirror.revision, 1);
assert.deepEqual(mirror.snapshot(), { sequence: 1, live: [rec(4)], recent: [rec(8)] });

// Capability flag is additive.
assert.equal(supportsRefreshModel({ features: { refresh_model: 1 } }), true);
assert.equal(supportsRefreshModel({ features: {} }), false);
assert.equal(supportsRefreshModel({}), false);
const info = { schema_version: 1, ok: true, api_version: 1, minimum_supported_api_version: 1, features: Object.fromEntries([
  'connection_decision_trace', 'group_test_tasks', 'operational_event_metadata', 'provider_refresh_tasks',
  'reload_preview', 'runtime_event_stream', 'runtime_log_stream', 'session_pool_metrics'].map((key) => [key, 1])) };
assert.equal(validateControlApiInfo(info), info);
info.features.refresh_model = 'yes';
assert.throws(() => validateControlApiInfo(info), /refresh model/u);

// Client paths.
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  const body = String(url).endsWith('/spike/refresh/stream')
    ? new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: refresh\ndata: {"connections":4,"http_capture":0}\n\n')); c.close(); } })
    : null;
  return {
    ok: true, status: 200,
    headers: new Headers({ 'content-type': body ? 'text/event-stream' : 'application/json' }),
    body, text: async () => '{}', json: async () => ({})
  };
};
const instance = { baseUrl: 'http://127.0.0.1:9090', secret: 'mock-secret' };
await SpikeApiClient.getConnectionsChanges(instance, 'a-5-1-0');
assert.equal(requests[0].url, 'http://127.0.0.1:9090/spike/connections/changes?since=a-5-1-0');
await SpikeApiClient.getConnectionsChanges(instance);
assert.equal(requests[1].url, 'http://127.0.0.1:9090/spike/connections/changes');
const events = [];
await SpikeApiClient.streamRefresh(instance, { onMessage: (message) => events.push(message) });
assert.equal(requests[2].url, 'http://127.0.0.1:9090/spike/refresh/stream');
assert.equal(requests[2].options.headers.get('Authorization'), 'Bearer mock-secret');
assert.deepEqual([events[0].event, events[0].data.connections], ['refresh', 4]);

// tools.js incremental connections: transient getApiInfo errors do not permanently
// disable incremental mode, desync resyncs once with an empty cursor, and superseded
// failures do not wipe a newer mirror state.
const toolsSource = fs.readFileSync(new URL('../tools.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\n/gm, '');
const makeToolsHarness = async (handlers) => {
  const nodes = new Map();
  const pagehide = [];
  const makeNode = () => ({
    value: '', dataset: {}, children: [], classList: { add() {}, remove() {} }, listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute() {}, focus() {}
  });
  const document = {
    hidden: true,
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, makeNode()); return nodes.get(id); },
    createElement: makeNode,
    addEventListener() {},
    removeEventListener() {}
  };
  const api = new Proxy({}, {
    get: (_, key) => handlers[key] || (key === 'streamRefresh'
      ? async (_inst, { signal } = {}) => new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))
      : async () => ({}))
  });
  const context = vm.createContext({
    coreError, requestErrorText, statusError, isRejectPolicy, ConnectionMirror,
    routeContext, policyProbeRequest, reloadView, reloadStatusView,
    chronological, downloadJournal, PanelObservation, ThroughputSession,
    formatConnectionTrace, connectionDetailFields, connectionMethod,
    filterRuntimeLogs: entries => entries, sortRuntimeLogs: entries => entries, formatRuntimeLogs: () => '',
    initializeI18n: async () => {}, msg, onLanguageChange() {}, confirmAction: async () => true,
    SpikeApiClient: api,
    StorageManager: { init: async () => {}, getActiveInstance: async () => ({ id: 'mock-instance', baseUrl: 'https://example.test', secret: 'mock-secret' }) },
    document, console, AbortController,
    window: {
      confirm: () => true, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
      addEventListener(type, fn) { if (type === 'pagehide') pagehide.push(fn); }
    },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => { throw new Error('mock stream unavailable'); } } }
  });
  await vm.runInContext(`(async () => { ${toolsSource}; globalThis.__test = { loadConnections, getMirror: () => connectionMirror }; })()`, context);
  return { nodes, test: context.__test, close: () => pagehide.forEach((fn) => fn()) };
};

{
  let apiCalls = 0;
  let fullCalls = 0;
  const changesCursors = [];
  let changesMode = 'initial';
  let slowReject = null;
  let markStaleEntered = null;
  const staleEntered = new Promise((resolve) => { markStaleEntered = resolve; });
  const harness = await makeToolsHarness({
    getApiInfo: async () => {
      apiCalls += 1;
      if (apiCalls === 1) throw new Error('temporary network outage');
      return { features: { refresh_model: 1 } };
    },
    getConnections: async () => {
      fullCalls += 1;
      return { live: [rec(1)], recent: [] };
    },
    getConnectionsChanges: async (_inst, since = '') => {
      changesCursors.push(since);
      if (changesMode === 'initial') {
        return { reset: true, cursor: 's-1-0-0', revision: 1, live: [rec(2)], removed_live_ids: [], live_stats: [], recent: [], recent_ids: [] };
      }
      if (changesMode === 'desync') {
        if (since !== '') {
          return {
            reset: false, cursor: 's-2-0-0', revision: 2, live: [], removed_live_ids: [],
            live_stats: [{ id: 99, upload_bytes: 1, download_bytes: 2, duration_ms: 3 }],
            recent: [], recent_ids: []
          };
        }
        return { reset: true, cursor: 's-3-0-0', revision: 3, live: [rec(3)], removed_live_ids: [], live_stats: [], recent: [], recent_ids: [] };
      }
      if (changesMode === 'stale-fail') {
        changesMode = 'fresh-ok';
        markStaleEntered();
        return new Promise((_resolve, reject) => { slowReject = reject; });
      }
      return { reset: false, cursor: 's-4-0-0', revision: 4, live: [rec(4)], removed_live_ids: [], live_stats: [], recent: [], recent_ids: [] };
    }
  });
  try {
    // Transient failure during loadAll fell back to full snapshot without permanently disabling incremental mode.
    assert.equal(fullCalls, 1);
    assert.ok(apiCalls >= 2, 'subsequent followConnections/load retries getApiInfo after transient error');

    // Incremental load now works.
    await harness.test.loadConnections();
    assert.equal(harness.test.getMirror().cursor, 's-1-0-0');

    // Desync triggers one reset + empty-cursor refetch and renders the resynced snapshot.
    changesCursors.length = 0;
    changesMode = 'desync';
    await harness.test.loadConnections();
    assert.deepEqual(changesCursors, ['s-1-0-0', '']);
    assert.equal(harness.test.getMirror().cursor, 's-3-0-0');
    assert.match(JSON.stringify(harness.nodes.get('connections')), /h3\.example\.test/);

    // A superseded loadConnections failure must not reset the newer mirror cursor.
    changesMode = 'stale-fail';
    const staleLoad = harness.test.loadConnections();
    await staleEntered;
    const newerLoad = harness.test.loadConnections();
    await newerLoad;
    assert.equal(harness.test.getMirror().cursor, 's-4-0-0');
    slowReject(new Error('stale failure'));
    await assert.rejects(staleLoad, /stale failure/);
    assert.equal(harness.test.getMirror().cursor, 's-4-0-0');
    assert.equal(harness.test.getMirror().revision, 4);
  } finally {
    harness.close();
  }
}

{
  // A 404 from getApiInfo permanently disables incremental mode.
  let apiCalls = 0;
  let fullCalls = 0;
  const harness = await makeToolsHarness({
    getApiInfo: async () => {
      apiCalls += 1;
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
    getConnections: async () => {
      fullCalls += 1;
      return { live: [], recent: [] };
    }
  });
  try {
    await harness.test.loadConnections();
    assert.equal(apiCalls, 1);
    assert.equal(fullCalls, 2);
  } finally {
    harness.close();
  }
}

console.log('connection mirror tests passed');
