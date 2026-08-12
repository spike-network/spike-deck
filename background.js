import { StorageManager } from './lib/storage.js';
import { SpikeApiClient } from './lib/spike-client.js';
import {
  preferredProxyEndpoint,
  proxyListenersFromStatus
} from './lib/proxy-listeners.js';

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
  if (message.type === 'GET_PROXY_SETTING_STATE') {
    getProxyControlState().then((result) => {
      sendResponse({ ok: true, ...result });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }
});

async function updateProxySettings() {
  try {
    const isProxyEnabled = await StorageManager.isProxyModeEnabled();
    const activeInstance = await StorageManager.getActiveInstance();

    if (!isProxyEnabled) {
      // Remove this extension's value instead of replacing it with `system`.
      // That releases Chrome's proxy API for SwitchyOmega and other managers.
      await releaseProxyControl();
      chrome.action.setBadgeText({ text: '' });
      return { mode: 'released', ...(await getProxyControlState()) };
    }

    if (!activeInstance) {
      throw new Error('No active Spike instance');
    }

    const status = await SpikeApiClient.getStatus(activeInstance);
    const endpoint = preferredProxyEndpoint(proxyListenersFromStatus(status, activeInstance));
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
    const control = await getProxyControlState();
    if (control.levelOfControl !== 'controlled_by_this_extension') {
      throw new Error('Chrome proxy settings are controlled by another extension or policy');
    }

    // Display indicator badge on action icon
    chrome.action.setBadgeBackgroundColor({ color: '#6366F1' });
    chrome.action.setBadgeText({ text: 'ON' });
    return {
      mode: 'fixed_servers',
      scheme: endpoint.scheme,
      host: endpoint.host,
      port: endpoint.port,
      kind: endpoint.kind,
      ...control
    };
  } catch (err) {
    console.error('Failed to set Chrome proxy:', err);
    chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
    chrome.action.setBadgeText({ text: 'ERR' });
    // Do not leave Chrome on a stale fixed proxy, and release ownership so a
    // different proxy extension can take over.
    try {
      await releaseProxyControl();
    } catch (resetErr) {
      console.error('Failed to reset Chrome proxy after error:', resetErr);
    }
    throw err;
  }
}

async function releaseProxyControl() {
  await chrome.proxy.settings.clear({ scope: 'regular' });
}

async function getProxyControlState() {
  const setting = await chrome.proxy.settings.get({ incognito: false });
  return {
    levelOfControl: setting.levelOfControl,
    controlledBySpikeDeck: setting.levelOfControl === 'controlled_by_this_extension'
  };
}
