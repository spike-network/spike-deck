import assert from 'node:assert/strict';

const { describePopupShortcut } = await import('../lib/shortcut-state.js');

assert.deepEqual(describePopupShortcut(true, [
  { name: 'open-popup', shortcut: 'Command+Shift+K' }
]), {
  kind: 'success',
  key: 'options.shortcut.current',
  params: { shortcut: 'Command+Shift+K' }
});

assert.equal(
  describePopupShortcut(true, [{ name: 'open-popup', shortcut: '' }]).kind,
  'warning'
);
assert.deepEqual(
  describePopupShortcut(false, [
    { name: 'open-popup', shortcut: 'Ctrl+Shift+K' }
  ]),
  { kind: '', key: 'options.shortcut.disabledBound', params: { shortcut: 'Ctrl+Shift+K' } }
);
assert.deepEqual(describePopupShortcut(false, []), { kind: '', key: 'options.shortcut.disabledUnbound' });

console.log('shortcut state tests passed');
