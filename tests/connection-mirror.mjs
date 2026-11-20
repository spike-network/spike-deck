import assert from 'node:assert/strict';

import { ConnectionMirror } from '../lib/connection-mirror.js';
import { supportsRefreshModel, validateControlApiInfo } from '../lib/control-api-contract.js';
import { SpikeApiClient } from '../lib/spike-client.js';

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

console.log('connection mirror tests passed');
