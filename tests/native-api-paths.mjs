import assert from 'node:assert/strict';

const { SpikeApiClient } = await import('../lib/spike-client.js');

assert.equal(SpikeApiClient.nativePath('/status'), '/spike/status');
assert.equal(SpikeApiClient.nativePath('/spike/status'), '/spike/status');
assert.equal(
  SpikeApiClient.nativePath('/group-tests?limit=20'),
  '/spike/group-tests?limit=20'
);
assert.equal(
  SpikeApiClient.nativePath('/spike/logs/stream?after=1'),
  '/spike/logs/stream?after=1'
);
assert.throws(
  () => SpikeApiClient.nativePath('/v1/outbound'),
  /native \/spike APIs only/
);

const instance = {
  baseUrl: 'http://127.0.0.1:9090/',
  secret: 'mock-secret'
};
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  return {
    status: 200,
    ok: true,
    async json() {
      return { ok: true };
    }
  };
};

await SpikeApiClient.getStatus(instance);
await SpikeApiClient.getGroups(instance);
await SpikeApiClient.selectGroupMember(instance, 'Proxy / Auto', 'Direct');
await SpikeApiClient.clearGroupSelection(instance, 'Proxy / Auto');

assert.deepEqual(
  requests.map((request) => request.url),
  [
    'http://127.0.0.1:9090/spike/status',
    'http://127.0.0.1:9090/spike/groups',
    'http://127.0.0.1:9090/spike/groups/Proxy%20%2F%20Auto/select',
    'http://127.0.0.1:9090/spike/groups/Proxy%20%2F%20Auto/select'
  ]
);
assert.equal(requests[2].options.method, 'PUT');
assert.equal(requests[3].options.method, 'DELETE');
assert.ok(requests.every((request) => request.url.includes('/spike/')));
assert.ok(requests.every((request) => !request.url.includes('/v1/')));

console.log('native api path tests passed');
