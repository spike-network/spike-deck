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

export function connectionDetailFields(row, translate = value => value) {
  const fields = [];
  const add = (label, value) => { if (value != null && value !== '') fields.push({ label, value: String(value) }); };
  const process = row.process || {};
  add('Process', process.name);
  add('PID', process.pid);
  add('Path', process.path);
  add('Container', process.container);
  add('Process lookup', process.lookup);
  const steps = row.decision_trace?.route?.group_steps;
  if (Array.isArray(steps) && steps.length) {
    add('Group decisions', steps.map(step => `${step.group} → ${step.selected}${step.stage ? ` (${step.stage})` : ''}${step.manual ? ` · ${translate('Pinned')}` : ''}`).join('\n'));
  }
  const phaseNames = { rule_dns: 'Rule evaluation (including DNS)', establish: 'Establishing outbound connection', active: 'Active' };
  const timeline = Array.isArray(row.timeline) ? row.timeline : [];
  const phases = timeline.filter(event => event.phase && Number.isFinite(event.duration_us));
  add('Phase timings', phases.length ? phases.map(event => `${translate(phaseNames[event.phase] || event.phase)}: ${(event.duration_us / 1000).toFixed(1)} ms`).join('\n') : translate('Phase timings unavailable'));
  const timestamp = elapsed => {
    const value = Number(row.started_unix_ms) + Number(elapsed) / 1000;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : '—';
  };
  if (row.started_unix_ms != null) add('Started', timestamp(0));
  if (row.duration_ms != null) add('Connection lifetime', `${row.duration_ms} ms`);
  add('Event timeline', timeline.length ? timeline.map(event => `${timestamp(event.elapsed_us)} (+${event.elapsed_us} µs) [${event.category}] ${event.message}`).join('\n') : translate('Event timeline unavailable'));
  add('End reason', row.end_reason);
  return fields;
}
