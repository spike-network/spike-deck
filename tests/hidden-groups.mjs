import assert from 'node:assert/strict';
import {
  DEFAULT_HIDDEN_GROUPS_MODE,
  hiddenGroupsModeLabel,
  nextHiddenGroupsMode,
  normalizeHiddenGroupsMode,
  selectedGroupMember,
  visiblePolicyGroups
} from '../lib/hidden-groups.js';

assert.equal(normalizeHiddenGroupsMode('smart'), 'smart');
assert.equal(normalizeHiddenGroupsMode('show'), 'show');
assert.equal(normalizeHiddenGroupsMode('hide'), 'hide');
assert.equal(normalizeHiddenGroupsMode(undefined), DEFAULT_HIDDEN_GROUPS_MODE);
assert.equal(normalizeHiddenGroupsMode('nope'), 'hide');
assert.equal(normalizeHiddenGroupsMode(undefined, true), 'show');
assert.equal(normalizeHiddenGroupsMode('nope', true), 'show');
assert.equal(normalizeHiddenGroupsMode('smart', true), 'smart');
assert.equal(normalizeHiddenGroupsMode('hide', true), 'hide');

assert.equal(nextHiddenGroupsMode('hide'), 'smart');
assert.equal(nextHiddenGroupsMode('smart'), 'show');
assert.equal(nextHiddenGroupsMode('show'), 'hide');
assert.equal(nextHiddenGroupsMode('nope'), 'smart');

assert.equal(hiddenGroupsModeLabel('smart').aria, '隐藏组展示：智能');

assert.equal(selectedGroupMember({ selected: 'HK' }), 'HK');
assert.equal(selectedGroupMember({ override_member: 'JP', selected: 'HK' }), 'JP');
assert.equal(selectedGroupMember({ override_member: '  ', selected: ' HK ' }), 'HK');
assert.equal(selectedGroupMember({}), '');

const groups = [
  { name: 'PROXY', hidden: false, selected: 'HK' },
  { name: 'HK', hidden: true, selected: 'n1' },
  { name: 'JP', hidden: true, selected: 'n2' },
  { name: 'DEBUG', hidden: true, selected: 'n3' },
  { name: 'FINAL', hidden: false, selected: 'DIRECT' }
];

assert.deepEqual(
  visiblePolicyGroups(groups, 'hide').map((g) => g.name),
  ['PROXY', 'FINAL']
);
assert.deepEqual(
  visiblePolicyGroups(groups, 'show').map((g) => g.name),
  ['PROXY', 'HK', 'JP', 'DEBUG', 'FINAL']
);
assert.deepEqual(
  visiblePolicyGroups(groups, 'smart').map((g) => g.name),
  ['PROXY', 'HK', 'FINAL']
);

// Membership without current selection does not reveal a hidden group.
const listedButNotSelected = [
  { name: 'PROXY', hidden: false, selected: 'DIRECT', members: ['HK', 'JP'] },
  { name: 'HK', hidden: true },
  { name: 'JP', hidden: true }
];
assert.deepEqual(
  visiblePolicyGroups(listedButNotSelected, 'smart').map((g) => g.name),
  ['PROXY']
);

// Follow the current selection chain through hidden groups.
const nested = [
  { name: 'PROXY', hidden: false, selected: 'REGION' },
  { name: 'REGION', hidden: true, selected: 'HK' },
  { name: 'HK', hidden: true, selected: 'n1' },
  { name: 'JP', hidden: true, selected: 'n2' }
];
assert.deepEqual(
  visiblePolicyGroups(nested, 'smart').map((g) => g.name),
  ['PROXY', 'REGION', 'HK']
);

// override_member wins over selected.
const pinned = [
  { name: 'PROXY', hidden: false, override_member: 'JP', selected: 'HK' },
  { name: 'HK', hidden: true },
  { name: 'JP', hidden: true }
];
assert.deepEqual(
  visiblePolicyGroups(pinned, 'smart').map((g) => g.name),
  ['PROXY', 'JP']
);

// Cycles must terminate.
const cyclic = [
  { name: 'A', hidden: false, selected: 'B' },
  { name: 'B', hidden: true, selected: 'C' },
  { name: 'C', hidden: true, selected: 'B' }
];
assert.deepEqual(
  visiblePolicyGroups(cyclic, 'smart').map((g) => g.name),
  ['A', 'B', 'C']
);

assert.deepEqual(visiblePolicyGroups(null, 'smart'), []);
assert.deepEqual(visiblePolicyGroups([{ hidden: true }], 'show'), []);

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

assert.equal(await StorageManager.getHiddenGroupsMode(), 'hide');

storage.showHiddenGroups = true;
assert.equal(await StorageManager.getHiddenGroupsMode(), 'show');

storage.hiddenGroupsMode = 'smart';
assert.equal(await StorageManager.getHiddenGroupsMode(), 'smart');

await StorageManager.setHiddenGroupsMode('show');
assert.equal(storage.hiddenGroupsMode, 'show');
assert.equal(storage.showHiddenGroups, true);
assert.equal(await StorageManager.getHiddenGroupsMode(), 'show');

await StorageManager.setHiddenGroupsMode('hide');
assert.equal(storage.hiddenGroupsMode, 'hide');
assert.equal(storage.showHiddenGroups, false);

await StorageManager.setHiddenGroupsMode('nope');
assert.equal(await StorageManager.getHiddenGroupsMode(), 'hide');

console.log('hidden groups tests passed');
