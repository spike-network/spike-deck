/** Normalize Spike `/status.listeners` into browser-reachable proxy endpoints. */
export function proxyListenersFromStatus(status, instance) {
  const apiHost = hostnameFromBaseUrl(instance && instance.baseUrl);
  return (Array.isArray(status && status.listeners) ? status.listeners : [])
    .map((listener) => normalizeListener(listener, apiHost))
    .filter(Boolean);
}

/** Select the endpoint Chrome should use when SpikeDeck owns proxy settings. */
export function preferredProxyEndpoint(listeners) {
  const preferKinds = [
    ['mixed', 'http'],
    ['http'],
    ['wifi-http'],
    ['socks', 'socks5'],
    ['wifi-socks', 'wifi-socks5']
  ];

  for (const kinds of preferKinds) {
    const match = (listeners || []).find((item) => kinds.includes(item.kind));
    if (match) {
      return {
        ...match,
        scheme: isSocksKind(match.kind) ? 'socks5' : 'http'
      };
    }
  }
  return null;
}

export function proxyListenerSummary(listeners) {
  const rows = [];
  const seen = new Set();
  for (const listener of listeners || []) {
    const label = listenerKindLabel(listener.kind);
    if (!label) continue;
    const key = `${label}\u0000${listener.host}\u0000${listener.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      kind: listener.kind,
      label,
      address: formatHostPort(listener.host, listener.port),
      host: listener.host,
      port: listener.port
    });
  }
  return rows;
}

function normalizeListener(listener, apiHost) {
  if (!listener || typeof listener.kind !== 'string' || typeof listener.address !== 'string') {
    return null;
  }
  const parsed = parseSocketAddress(listener.address);
  if (!parsed) return null;

  let host = parsed.host;
  if (isWildcardHost(host)) {
    host = isLoopbackHost(apiHost) ? '127.0.0.1' : apiHost;
  } else if (isLoopbackHost(host) && !isLoopbackHost(apiHost)) {
    // A remote Spike listener bound to its loopback cannot be reached here.
    return null;
  }

  return {
    kind: listener.kind.toLowerCase(),
    host,
    port: parsed.port
  };
}

function listenerKindLabel(kind) {
  switch (String(kind || '').toLowerCase()) {
    case 'mixed':
      return 'Mixed';
    case 'http':
    case 'wifi-http':
      return 'HTTP';
    case 'socks':
    case 'socks5':
    case 'wifi-socks':
    case 'wifi-socks5':
      return 'SOCKS5';
    default:
      return null;
  }
}

function isSocksKind(kind) {
  return String(kind || '').toLowerCase().includes('socks');
}

function hostnameFromBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl || 'http://127.0.0.1:9090').hostname;
  } catch {
    return '127.0.0.1';
  }
}

function isLoopbackHost(host) {
  const value = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

function isWildcardHost(host) {
  const value = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return value === '0.0.0.0' || value === '::' || value === '*';
}

function formatHostPort(host, port) {
  return String(host).includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Parse `host:port` or `[ipv6]:port` bind addresses from Spike. */
function parseSocketAddress(str) {
  if (!str) return null;
  const value = String(str).trim();
  const bracket = value.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracket) {
    const port = parseInt(bracket[2], 10);
    if (validPort(port)) return { host: bracket[1], port };
    return null;
  }
  const idx = value.lastIndexOf(':');
  if (idx <= 0) return null;
  const host = value.slice(0, idx);
  const port = parseInt(value.slice(idx + 1), 10);
  if (!host || !validPort(port)) return null;
  return { host, port };
}

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}
