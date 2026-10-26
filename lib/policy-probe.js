export function policyProbeRequest(names, url, known) {
  const selected = [...new Set(names)];
  if (!selected.length || selected.length > 16 || selected.some(name => !known.includes(name))) {
    throw new Error('Select between 1 and 16 known policies.');
  }
  const value = String(url || '').trim();
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
  } catch { throw new Error('Enter an absolute HTTP or HTTPS probe URL.'); }
  return { policy_names: selected, url: value };
}
