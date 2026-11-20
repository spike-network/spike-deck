import { msg } from "./i18n.js";
export function policyProbeRequest(names, url, known) {
  const selected = [...new Set(names)];
  if (!selected.length || selected.length > 16 || selected.some(name => !known.includes(name))) {
    throw new Error(msg("tools.selectBetween116"));
  }
  const value = String(url || '').trim();
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
  } catch { throw new Error(msg("tools.enterAbsoluteHttpHttps")); }
  return { policy_names: selected, url: value };
}
