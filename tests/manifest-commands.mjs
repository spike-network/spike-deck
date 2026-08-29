import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8')
);

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.action.default_popup, 'popup.html');
assert.deepEqual(manifest.commands?._execute_action?.suggested_key, {
  default: 'Ctrl+Shift+K',
  mac: 'Command+Shift+K'
});

console.log('manifest command tests passed');
