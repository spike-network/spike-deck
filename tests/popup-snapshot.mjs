import assert from 'node:assert/strict';

const storage = {};

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        return Object.fromEntries(keys.map((key) => [key, storage[key]]));
      },
      async set(values) {
        Object.assign(storage, values);
      }
    }
  }
};

const { StorageManager } = await import('../lib/storage.js');

assert.equal(await StorageManager.getPopupGroupSnapshot('missing'), null);

for (let index = 1; index <= 6; index += 1) {
  await StorageManager.setPopupGroupSnapshot(`instance-${index}`, [
    { name: `Mock Group ${index}`, members: ['Mock Node'] }
  ]);
}

assert.equal(await StorageManager.getPopupGroupSnapshot('instance-1'), null);
assert.equal(
  (await StorageManager.getPopupGroupSnapshot('instance-6')).groups[0].name,
  'Mock Group 6'
);
assert.equal(Object.keys(storage.popupGroupSnapshots).length, 5);

await Promise.all([
  StorageManager.setPopupGroupSnapshot('parallel-a', [{ name: 'A' }]),
  StorageManager.setPopupGroupSnapshot('parallel-b', [{ name: 'B' }])
]);
assert.equal(storage.popupGroupSnapshots['parallel-a'].groups[0].name, 'A');
assert.equal(storage.popupGroupSnapshots['parallel-b'].groups[0].name, 'B');

const originalGet = chrome.storage.local.get;
const entered = Promise.withResolvers();
const release = Promise.withResolvers();
chrome.storage.local.get = async (keys) => {
  const snapshot = structuredClone(await originalGet(keys));
  entered.resolve();
  await release.promise;
  return snapshot;
};
let current = true;
const cancelled = StorageManager.setPopupGroupSnapshot('cancelled', [{ name: 'stale' }], () => current);
await entered.promise;
current = false;
release.resolve();
await cancelled;
assert.equal(storage.popupGroupSnapshots.cancelled, undefined);
chrome.storage.local.get = originalGet;

const originalSet = chrome.storage.local.set;
chrome.storage.local.set = async () => { throw new Error('mock storage failure'); };
await assert.rejects(StorageManager.setPopupGroupSnapshot('failed', []), /mock storage failure/);
chrome.storage.local.set = originalSet;
await StorageManager.setPopupGroupSnapshot('recovered', [{ name: 'Recovered' }]);
assert.equal(storage.popupGroupSnapshots.recovered.groups[0].name, 'Recovered');
assert.equal(storage.popupGroupSnapshots.failed, undefined);

console.log('popup snapshot tests passed');
