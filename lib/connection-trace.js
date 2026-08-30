export function formatConnectionTrace(trace) {
  if (!trace || typeof trace !== 'object') return '—';
  const route = Array.isArray(trace.route?.policy_chain)
    ? trace.route.policy_chain.join(' → ')
    : trace.rule_policy || '—';
  const dnsAddresses = Array.isArray(trace.dns?.addresses) && trace.dns.addresses.length
    ? ` (${trace.dns.addresses.join(', ')})`
    : '';
  const underlying = Array.isArray(trace.route?.underlying_chain) && trace.route.underlying_chain.length
    ? ` · underlying ${trace.route.underlying_chain.join(' → ')}`
    : '';
  return `${trace.rule || 'unknown rule'} · DNS ${trace.dns?.mode || 'unknown'}${dnsAddresses} · ${route}${underlying}`;
}
