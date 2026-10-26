const fields = [
  ['source_ip', 'Source IP'], ['source_port', 'Source port'], ['in_port', 'Inbound port'],
  ['destination_ip', 'Destination IP'], ['url', 'Request URL'], ['user_agent', 'User-Agent'],
  ['process_name', 'Process name'], ['process_path', 'Process path'], ['process_cgroup', 'Process cgroup']
];

export function routeContext(input) {
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
  if (!host || host.length > 253 || /[\s/@?#\\]/.test(host)) invalid('Host');
  const protocol = String(input.protocol || 'TCP').trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,16}$/.test(protocol)) invalid('Protocol');
  const context = { host, port: port(String(input.port), 'Port'), protocol };
  for (const [key, title] of fields) {
    const value = String(input[key] || '').trim();
    if (!value) continue;
    if (value.length > (key === 'user_agent' ? 1024 : 4096) || /[\r\n\0]/.test(value)) invalid(title);
    if ((key === 'source_ip' || key === 'destination_ip') && !ip(value)) invalid(title);
    context[key] = key === 'source_port' || key === 'in_port' ? port(value, title) : value;
  }
  return context;
}
