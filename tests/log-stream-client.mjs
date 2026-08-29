import assert from 'node:assert/strict';

import { SpikeApiClient } from '../lib/spike-client.js';

const encoder = new TextEncoder();
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream; charset=utf-8' }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: log\nid: 42\ndata: {"sequence":42,"message":"ready"}\n\n'));
        controller.close();
      }
    })
  };
};

const messages = [];
let opened = false;
await SpikeApiClient.streamLogs({
  baseUrl: 'http://127.0.0.1:9090/',
  secret: 'mock-secret'
}, {
  after: 41,
  onOpen: () => { opened = true; },
  onMessage: (message) => messages.push(message)
});

assert.equal(opened, true);
assert.equal(requests[0].url, 'http://127.0.0.1:9090/spike/logs/stream?after=41');
assert.equal(requests[0].options.headers.get('Authorization'), 'Bearer mock-secret');
assert.equal(requests[0].options.headers.get('Accept'), 'text/event-stream');
assert.deepEqual(messages[0].data, { sequence: 42, message: 'ready' });

console.log('log stream client tests passed');
