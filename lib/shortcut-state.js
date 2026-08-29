export function describePopupShortcut(enabled, commands) {
  const command = Array.isArray(commands)
    ? commands.find((item) => item?.name === 'open-popup')
    : null;
  const shortcut = String(command?.shortcut || '').trim();

  if (!enabled) {
    return {
      kind: '',
      text: shortcut
        ? `已禁用；Chrome 仍保留绑定 ${shortcut}`
        : '已禁用；Chrome 当前未绑定快捷键'
    };
  }
  if (!shortcut) {
    return {
      kind: 'warning',
      text: '未绑定或快捷键冲突；请在 chrome://extensions/shortcuts 中设置'
    };
  }
  return { kind: 'success', text: `当前快捷键：${shortcut}` };
}
