import { msg } from "./i18n.js";
const routeFields = () => [
  ['source_ip', msg("tools.sourceIp")], ['source_port', msg("tools.sourcePort")], ['in_port', msg("tools.inboundPort")],
  ['destination_ip', msg("tools.destinationIp")], ['url', msg("tools.requestUrl")], ["user_agent", msg("tools.userAgent")],
  ['process_name', msg("tools.processName")], ['process_path', msg("tools.processPath")], ['process_cgroup', msg("tools.processCgroup")]
];

export function routeContext(input) {
  const fields = routeFields();
  const invalid = field => { throw Object.assign(new Error('Invalid route context'), { field }); };
  const port = (value, field) => {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) invalid(field);
    return Number(value);
  };
  const ip = value => {
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
      return value.split('.').every(part => Number(part) <= 255 && String(Number(part)) === part);
    }
    if (!value.includes(':') || !/^[a-f0-9:.]+$/i.test(value)) return false;
    try { new URL(`http://[${value}]/`); return true; } catch { return false; }
  };
  const host = String(input.host || '').trim();
  if (!host || host.length > 253 || /[\s/@?#\\]/.test(host)) invalid(msg("common.host"));
  const protocol = String(input.protocol || 'TCP').trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,16}$/.test(protocol)) invalid(msg("tools.protocol"));
  const context = { host, port: port(String(input.port), msg("common.port")), protocol };
  for (const [key, title] of fields) {
    const value = String(input[key] || '').trim();
    if (!value) continue;
    if (value.length > (key === 'user_agent' ? 1024 : 4096) || /[\r\n\0]/.test(value)) invalid(title);
    if ((key === 'source_ip' || key === 'destination_ip') && !ip(value)) invalid(title);
    context[key] = key === 'source_port' || key === 'in_port' ? port(value, title) : value;
  }
  return context;
}
