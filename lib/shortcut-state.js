// Describes the popup shortcut state as a message key from lib/locales.
export function describePopupShortcut(enabled, commands) {
  const command = Array.isArray(commands)
    ? commands.find((item) => item?.name === 'open-popup')
    : null;
  const shortcut = String(command?.shortcut || '').trim();

  if (!enabled) {
    return shortcut
      ? { kind: '', key: 'options.shortcut.disabledBound', params: { shortcut } }
      : { kind: '', key: 'options.shortcut.disabledUnbound' };
  }
  if (!shortcut) return { kind: 'warning', key: 'options.shortcut.unbound' };
  return { kind: 'success', key: 'options.shortcut.current', params: { shortcut } };
}
