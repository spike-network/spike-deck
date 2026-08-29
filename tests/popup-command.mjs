import assert from 'node:assert/strict';

const storage = {};
let commandListener = null;
let popupOpenCount = 0;

globalThis.chrome = {
  action: {
    async openPopup() {
      popupOpenCount += 1;
    }
  },
  commands: {
    onCommand: {
      addListener(listener) {
        commandListener = listener;
      }
    }
  },
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener() {} },
    onStartup: { addListener() {} }
  },
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

const { openPopupFromCommand } = await import('../background.js');

assert.equal(typeof commandListener, 'function');
assert.equal(await openPopupFromCommand(), true);
assert.equal(popupOpenCount, 1);

storage.enablePopupShortcut = false;
assert.equal(await openPopupFromCommand(), false);
assert.equal(popupOpenCount, 1);

console.log('popup command tests passed');
