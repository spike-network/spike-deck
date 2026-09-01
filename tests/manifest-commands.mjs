import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8')
);

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.minimum_chrome_version, '127');
assert.equal(manifest.default_locale, 'en');
assert.equal(manifest.name, '__MSG_extensionName__');
assert.equal(manifest.description, '__MSG_extensionDescription__');
assert.equal(manifest.action.default_popup, 'popup.html');
assert.ok(manifest.permissions.includes('activeTab'));
assert.deepEqual(manifest.commands?.['open-popup']?.suggested_key, {
  default: 'Ctrl+Shift+K',
  mac: 'Command+Shift+K'
});
assert.equal(manifest.commands?.['open-popup']?.description, '__MSG_openPopupCommand__');

const CWS_SHORT_DESCRIPTION_LIMIT = 132;

for (const locale of ['en', 'zh_CN']) {
  const messages = JSON.parse(
    await readFile(new URL(`../_locales/${locale}/messages.json`, import.meta.url), 'utf8')
  );
  assert.ok(messages.extensionName?.message);
  assert.ok(messages.extensionDescription?.message);
  assert.ok(messages.openPopupCommand?.message);
  assert.ok(
    messages.extensionDescription.message.length <= CWS_SHORT_DESCRIPTION_LIMIT,
    `${locale} extensionDescription exceeds Chrome Web Store 132-character limit`
  );
}

console.log('manifest command tests passed');
