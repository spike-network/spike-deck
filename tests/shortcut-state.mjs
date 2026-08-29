import assert from 'node:assert/strict';

const { describePopupShortcut } = await import('../lib/shortcut-state.js');

assert.deepEqual(describePopupShortcut(true, [
  { name: 'open-popup', shortcut: 'Command+Shift+K' }
]), {
  kind: 'success',
  text: '当前快捷键：Command+Shift+K'
});

assert.equal(
  describePopupShortcut(true, [{ name: 'open-popup', shortcut: '' }]).kind,
  'warning'
);
assert.equal(
  describePopupShortcut(false, [
    { name: 'open-popup', shortcut: 'Ctrl+Shift+K' }
  ]).text,
  '已禁用；Chrome 仍保留绑定 Ctrl+Shift+K'
);

console.log('shortcut state tests passed');
