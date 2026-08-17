import assert from 'node:assert/strict';

const { SpikeApiClient } = await import('../lib/spike-client.js');

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
      return { mode: 'global', global_policy: 'Proxy' };
    }
  };
};

const outbound = await SpikeApiClient.getOutbound(instance);
assert.equal(outbound.mode, 'global');
assert.equal(requests[0].url, 'http://127.0.0.1:9090/spike/outbound');
assert.equal(requests[0].options.method, 'GET');
assert.equal(requests[0].options.headers.get('Authorization'), 'Bearer mock-secret');

await SpikeApiClient.setOutbound(instance, 'global', 'Proxy');
assert.equal(requests[1].url, 'http://127.0.0.1:9090/spike/outbound');
assert.equal(requests[1].options.method, 'PUT');
assert.equal(requests[1].options.headers.get('Content-Type'), 'application/json');
assert.deepEqual(JSON.parse(requests[1].options.body), {
  mode: 'global',
  policy: 'Proxy'
});

await SpikeApiClient.setOutbound(instance, 'direct');
assert.deepEqual(JSON.parse(requests[2].options.body), { mode: 'direct' });

console.log('outbound mode client tests passed');
