import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8')
);

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.minimum_chrome_version, '127');
assert.equal(manifest.action.default_popup, 'popup.html');
assert.deepEqual(manifest.commands?.['open-popup']?.suggested_key, {
  default: 'Ctrl+Shift+K',
  mac: 'Command+Shift+K'
});
assert.equal(manifest.commands?.['open-popup']?.description, '打开 SpikeDeck 控制面板');

console.log('manifest command tests passed');
