import assert from 'node:assert/strict';

import { canSendSecret } from '../lib/permissions.js';
import { INSECURE_SECRET_ERROR, SpikeApiClient } from '../lib/spike-client.js';

assert.equal(canSendSecret('http://127.0.0.1:9090'), true);
assert.equal(canSendSecret('http://localhost:9090'), true);
assert.equal(canSendSecret('http://[::1]:9090'), true);
assert.equal(canSendSecret('https://spike.example.test:6170'), true);
assert.equal(canSendSecret('http://192.0.2.10:6170'), false);
assert.equal(canSendSecret('http://spike.example.test'), false);
assert.equal(canSendSecret('invalid-url'), false);

const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: new ReadableStream({ start(controller) { controller.close(); } }),
    async json() {
      return { profile: 'Mock.conf' };
    }
  };
};

const remote = { baseUrl: 'http://192.0.2.10:6170', secret: 'mock-secret' };
await assert.rejects(SpikeApiClient.getStatus(remote), { message: INSECURE_SECRET_ERROR });
await assert.rejects(SpikeApiClient.streamLogs(remote), { message: INSECURE_SECRET_ERROR });
assert.equal(requests.length, 0);

await SpikeApiClient.getStatus({ baseUrl: 'http://192.0.2.10:6170', secret: '' });
assert.equal(requests[0].options.headers.has('Authorization'), false);

await SpikeApiClient.getStatus({ baseUrl: 'https://spike.example.test:6170', secret: 'mock-secret' });
assert.equal(requests[1].options.headers.get('Authorization'), 'Bearer mock-secret');

console.log('secret transport tests passed');
