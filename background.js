import { StorageManager } from './lib/storage.js';

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
    updateProxySettings().then(() => {
      sendResponse({ ok: true });
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
      return;
    }

    if (!activeInstance) {
      return;
    }

    // Configure Chrome Proxy
    const httpProxy = parseHostPort(activeInstance.httpProxy || '127.0.0.1:6152');
    const socksProxy = parseHostPort(activeInstance.socksProxy || '127.0.0.1:6153');

    let proxyConfig;
    if (httpProxy) {
      proxyConfig = {
        mode: 'fixed_servers',
        rules: {
          singleProxy: {
            scheme: 'http',
            host: httpProxy.host,
            port: httpProxy.port
          },
          bypassList: ['127.0.0.1', 'localhost', '::1']
        }
      };
    } else if (socksProxy) {
      proxyConfig = {
        mode: 'fixed_servers',
        rules: {
          singleProxy: {
            scheme: 'socks5',
            host: socksProxy.host,
            port: socksProxy.port
          },
          bypassList: ['127.0.0.1', 'localhost', '::1']
        }
      };
    } else {
      proxyConfig = { mode: 'system' };
    }

    await chrome.proxy.settings.set({
      value: proxyConfig,
      scope: 'regular'
    });

    // Display indicator badge on action icon
    chrome.action.setBadgeBackgroundColor({ color: '#6366F1' });
    chrome.action.setBadgeText({ text: 'ON' });

  } catch (err) {
    console.error('Failed to set Chrome proxy:', err);
    chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
    chrome.action.setBadgeText({ text: 'ERR' });
  }
}

function parseHostPort(str) {
  if (!str) return null;
  const parts = str.trim().replace(/^(https?|socks5):\/\//i, '').split(':');
  if (parts.length === 2) {
    const host = parts[0];
    const port = parseInt(parts[1], 10);
    if (host && !Number.isNaN(port)) {
      return { host, port };
    }
  }
  return null;
}
