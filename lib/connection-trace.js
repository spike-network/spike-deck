import { msg } from "./i18n.js";
// Requests show their method; tunnels and raw flows show the application Core
// recognized, then the detected protocol, then the transport kind.
export function connectionMethod(row) {
  const method = row?.http?.method;
  if (method && method !== 'CONNECT') return method;
  return row?.application || row?.protocol || method || row?.kind || '—';
}

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

export function connectionDetailFields(row, live = false) {
  const fields = [];
  const add = (label, value) => { if (value != null && value !== '') fields.push({ label, value: String(value) }); };
  const process = row.process || {};
  add(msg("tools.process"), process.name);
  add('PID', process.pid);
  add(msg("common.path"), process.path);
  add(msg("common.container"), process.container);
  add(msg("tools.processLookup"), process.lookup);
  const steps = row.decision_trace?.route?.group_steps;
  if (Array.isArray(steps) && steps.length) {
    add(msg("tools.groupDecisions"), steps.map(step => `${step.group} → ${step.selected}${step.stage ? ` (${step.stage})` : ''}${step.manual ? ` · ${(msg("common.pinned"))}` : ''}`).join('\n'));
  }
  const phaseNames = { rule_dns: msg("tools.ruleEvaluationIncludingDns"), establish: msg("tools.establishingOutboundConnection"), active: msg("common.active") };
  const timeline = Array.isArray(row.timeline) ? row.timeline : [];
  const phases = timeline.filter(event => event.phase && Number.isFinite(event.duration_us));
  const established = timeline.slice().reverse().find(event => event.phase === 'establish');
  if (live && established && Number.isFinite(row.duration_ms) && !phases.some(event => event.phase === 'active')) phases.push({phase:'active',duration_us:Math.max(0,row.duration_ms * 1000 - established.elapsed_us)});
  add(msg("tools.phaseTimings"), phases.length ? phases.map(event => `${(phaseNames[event.phase] || event.phase)}: ${(event.duration_us / 1000).toFixed(1)} ms`).join('\n') : (msg("tools.phaseTimingsUnavailable")));
  const timestamp = elapsed => {
    const value = Number(row.started_unix_ms) + Number(elapsed) / 1000;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : '—';
  };
  if (row.started_unix_ms != null) add(msg("tools.started"), timestamp(0));
  if (row.duration_ms != null) add(msg("tools.connectionLifetime"), `${row.duration_ms} ms`);
  add(msg("tools.eventTimeline"), timeline.length ? timeline.map(event => `${timestamp(event.elapsed_us)} (+${event.elapsed_us} µs) [${event.category}] ${event.message}`).join('\n') : (msg("tools.eventTimelineUnavailable")));
  add(msg("tools.endReason"), row.end_reason);
  return fields;
}
