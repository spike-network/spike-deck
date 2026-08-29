import assert from 'node:assert/strict';

const { SpikeApiClient } = await import('../lib/spike-client.js');

assert.equal(
  SpikeApiClient.dashboardUrl({ baseUrl: 'http://127.0.0.1:9090/' }),
  'http://127.0.0.1:9090/'
);
assert.equal(
  SpikeApiClient.dashboardUrl({ baseUrl: 'http://127.0.0.1:9090' }),
  'http://127.0.0.1:9090/'
);
assert.equal(
  SpikeApiClient.dashboardUrl({ baseUrl: 'https://spike.example.test/ctrl' }),
  'https://spike.example.test/ctrl/'
);
assert.equal(
  SpikeApiClient.dashboardUrl({
    baseUrl: 'http://user:pass@127.0.0.1:9090/?x=1#frag'
  }),
  'http://127.0.0.1:9090/'
);
assert.equal(SpikeApiClient.dashboardUrl({ baseUrl: 'ftp://127.0.0.1:9090' }), '');
assert.equal(SpikeApiClient.dashboardUrl({ baseUrl: '' }), '');
assert.equal(SpikeApiClient.dashboardUrl({}), '');
assert.equal(SpikeApiClient.dashboardUrl(null), '');

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
await SpikeApiClient.cancelGroupTestTask(instance, 41);
await SpikeApiClient.getProfiles(instance);
await SpikeApiClient.getCurrentProfile(instance);
await SpikeApiClient.checkProfile(instance, 'alt');
await SpikeApiClient.switchProfile(instance, 'alt');
await SpikeApiClient.getModules(instance);
await SpikeApiClient.updateModules(instance, { Ads: true });
await SpikeApiClient.getScripts(instance);
await SpikeApiClient.evaluateScript(instance, { name: 'health' });
await SpikeApiClient.evaluateCronScript(instance, 'hourly');
await SpikeApiClient.getConnections(instance);
await SpikeApiClient.killConnection(instance, 42);
await SpikeApiClient.explainRoute(instance, { host: 'example.com', port: 443, protocol: 'TCP' });
await SpikeApiClient.queryDns(instance, { name: 'example.com', qtype: 'A' });
await SpikeApiClient.flushDns(instance);
await SpikeApiClient.getDnsCache(instance);
await SpikeApiClient.measureDnsDelay(instance);

const cancelRequest = requests.find(({ url }) => url.endsWith('/spike/group-tests/41'));
assert.equal(cancelRequest.options.method, 'DELETE');

assert.deepEqual(
  requests.map((request) => request.url),
  [
    'http://127.0.0.1:9090/spike/status',
    'http://127.0.0.1:9090/spike/groups',
    'http://127.0.0.1:9090/spike/groups/Proxy%20%2F%20Auto/select',
    'http://127.0.0.1:9090/spike/groups/Proxy%20%2F%20Auto/select',
    'http://127.0.0.1:9090/spike/group-tests/41',
    'http://127.0.0.1:9090/spike/profiles',
    'http://127.0.0.1:9090/spike/profiles/current',
    'http://127.0.0.1:9090/spike/profiles/check',
    'http://127.0.0.1:9090/spike/profiles/switch',
    'http://127.0.0.1:9090/spike/modules',
    'http://127.0.0.1:9090/spike/modules',
    'http://127.0.0.1:9090/spike/scripts',
    'http://127.0.0.1:9090/spike/scripts/evaluate',
    'http://127.0.0.1:9090/spike/scripts/cron/evaluate',
    'http://127.0.0.1:9090/spike/connections',
    'http://127.0.0.1:9090/spike/connections/42',
    'http://127.0.0.1:9090/spike/rules/explain',
    'http://127.0.0.1:9090/spike/dns/query',
    'http://127.0.0.1:9090/spike/dns/flush',
    'http://127.0.0.1:9090/spike/dns/cache',
    'http://127.0.0.1:9090/spike/dns/delay'
  ]
);
assert.equal(requests[7].options.method, 'POST');
assert.equal(requests[8].options.method, 'POST');
assert.equal(requests[10].options.method, 'POST');
assert.equal(requests[12].options.method, 'POST');
assert.equal(requests[13].options.method, 'POST');
assert.equal(requests[15].options.method, 'DELETE');
assert.equal(requests[16].options.method, 'POST');
assert.equal(requests[17].options.method, 'POST');
assert.equal(requests[18].options.method, 'POST');
assert.equal(requests[20].options.method, 'POST');
assert.equal(
  SpikeApiClient.profileStem('/tmp/alt.conf'),
  'alt'
);
assert.deepEqual(
  SpikeApiClient.parseManagedProfile(
    '#!MANAGED-CONFIG https://example.test/a.conf interval=3600 strict=true\n[General]\n'
  ),
  { managed: true, intervalSeconds: 3600, strict: true }
);
assert.equal(requests[2].options.method, 'PUT');
assert.equal(requests[3].options.method, 'DELETE');
assert.ok(requests.every((request) => request.url.includes('/spike/')));
assert.ok(requests.every((request) => !request.url.includes('/v1/')));

console.log('native api path tests passed');
