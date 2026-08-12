import { StorageManager } from './lib/storage.js';
import { SpikeApiClient } from './lib/spike-client.js';

// Background Service Worker for SpikeDeck

chrome.runtime.onInstalled.addListener(async () => {
  await StorageManager.init();
  await updateProxySettings();
});

chrome.runtime.onStartup.addListener(async () => {
  await updateProxySettings();
});

// Listen for message from popup or options page
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'UPDATE_PROXY_SETTING') {
    updateProxySettings().then((result) => {
      sendResponse({ ok: true, ...result });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true; // Keep channel open for async response
  }
});

async function updateProxySettings() {
  try {
    const isProxyEnabled = await StorageManager.isProxyModeEnabled();
    const activeInstance = await StorageManager.getActiveInstance();

    if (!isProxyEnabled) {
      // Revert to system proxy
      await chrome.proxy.settings.set({
        value: { mode: 'system' },
        scope: 'regular'
      });
      chrome.action.setBadgeText({ text: '' });
      return { mode: 'system' };
    }

    if (!activeInstance) {
      throw new Error('No active Spike instance');
    }

    const endpoint = await resolveProxyEndpoint(activeInstance);
    if (!endpoint) {
      throw new Error('Spike /status did not expose a usable HTTP or SOCKS listener');
    }

    const proxyConfig = {
      mode: 'fixed_servers',
      rules: {
        singleProxy: {
          scheme: endpoint.scheme,
          host: endpoint.host,
          port: endpoint.port
        },
        bypassList: ['127.0.0.1', 'localhost', '::1']
      }
    };

    await chrome.proxy.settings.set({
      value: proxyConfig,
      scope: 'regular'
    });

    // Display indicator badge on action icon
    chrome.action.setBadgeBackgroundColor({ color: '#6366F1' });
    chrome.action.setBadgeText({ text: 'ON' });
    return {
      mode: 'fixed_servers',
      scheme: endpoint.scheme,
      host: endpoint.host,
      port: endpoint.port,
      kind: endpoint.kind
    };
  } catch (err) {
    console.error('Failed to set Chrome proxy:', err);
    chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
    chrome.action.setBadgeText({ text: 'ERR' });
    // Fail closed: do not leave Chrome on a stale fixed proxy.
    try {
      await chrome.proxy.settings.set({
        value: { mode: 'system' },
        scope: 'regular'
      });
    } catch (resetErr) {
      console.error('Failed to reset Chrome proxy after error:', resetErr);
    }
    throw err;
  }
}

/**
 * Pick a browser-reachable proxy endpoint from Spike `/status.listeners`.
 * Preference: mixed/http (HTTP CONNECT) over socks; loopback over LAN-only.
 */
async function resolveProxyEndpoint(instance) {
  const status = await SpikeApiClient.getStatus(instance);
  const listeners = Array.isArray(status.listeners) ? status.listeners : [];
  if (listeners.length === 0) return null;

  const apiHost = hostnameFromBaseUrl(instance.baseUrl);
  const candidates = listeners
    .map((listener) => normalizeListener(listener, apiHost))
    .filter(Boolean);

  const preferKinds = [
    ['mixed', 'http'],
    ['http'],
    ['wifi-http'],
    ['socks'],
    ['wifi-socks']
  ];

  for (const kinds of preferKinds) {
    const match = candidates.find((item) => kinds.includes(item.kind));
    if (match) {
      return {
        kind: match.kind,
        scheme: match.kind.includes('socks') ? 'socks5' : 'http',
        host: match.host,
        port: match.port
      };
    }
  }
  return null;
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
    // Remote Spike bound only to loopback is unreachable from this browser.
    return null;
  }

  return {
    kind: listener.kind.toLowerCase(),
    host,
    port: parsed.port
  };
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

/** Parse `host:port` or `[ipv6]:port` bind addresses from Spike. */
function parseSocketAddress(str) {
  if (!str) return null;
  const value = String(str).trim();
  const bracket = value.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracket) {
    const port = parseInt(bracket[2], 10);
    if (!Number.isNaN(port)) return { host: bracket[1], port };
    return null;
  }
  const idx = value.lastIndexOf(':');
  if (idx <= 0) return null;
  const host = value.slice(0, idx);
  const port = parseInt(value.slice(idx + 1), 10);
  if (!host || Number.isNaN(port)) return null;
  return { host, port };
}
