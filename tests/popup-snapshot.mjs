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

console.log('popup snapshot tests passed');
