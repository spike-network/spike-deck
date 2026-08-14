import { StorageManager } from './lib/storage.js';
import { SpikeApiClient } from './lib/spike-client.js';
import {
  preferredProxyEndpoint,
  proxyListenersFromStatus
} from './lib/proxy-listeners.js';

// Background Service Worker for SpikeDeck

const PROVIDER_REFRESH_RECONCILE_AFTER_SECONDS = 240;
const providerRefreshOperations = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  await StorageManager.init();
  await updateProxySettings();
  await reconcilePersistedProviderRefreshTasks();
});

chrome.runtime.onStartup.addListener(async () => {
  await updateProxySettings();
  await reconcilePersistedProviderRefreshTasks();
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
  if (message.type === 'START_PROVIDER_REFRESH') {
    startProviderRefreshTask(message.instanceId, message.providerId).then((task) => {
      sendResponse({ ok: true, task });
    }).catch(err => {
      sendResponse({ ok: false, error: safeProviderRefreshError(err) });
    });
    return true;
  }
  if (message.type === 'GET_PROVIDER_REFRESH_TASK') {
    getProviderRefreshTask(message.instanceId).then((task) => {
      sendResponse({ ok: true, task });
    }).catch(err => {
      sendResponse({ ok: false, error: safeProviderRefreshError(err) });
    });
    return true;
  }
});

async function startProviderRefreshTask(instanceId, providerId) {
  const instances = await StorageManager.getInstances();
  const instance = instances.find(candidate => candidate.id === instanceId);
  if (!instance) throw new Error('Spike instance not found');

  const existing = await getProviderRefreshTask(instanceId);
  if (existing?.status === 'running') return existing;

  const task = {
    schemaVersion: 1,
    id: globalThis.crypto?.randomUUID?.() || `provider-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    instanceId,
    providerId: providerId || null,
    status: 'running',
    startedAtUnix: Math.floor(Date.now() / 1000),
    finishedAtUnix: null,
    revision: null,
    total: null,
    ready: null,
    missing: null,
    error: null
  };
  await StorageManager.setProviderRefreshTask(instanceId, task);

  try {
    const coreTask = await SpikeApiClient.startProviderRefreshTask(
      instance,
      task.providerId || undefined
    );
    const accepted = {
      ...task,
      coreTaskId: coreTask.id,
      startedAtUnix: Math.floor(Number(coreTask.started_at_unix_ms || Date.now()) / 1000)
    };
    await StorageManager.setProviderRefreshTask(instanceId, accepted);
    return accepted;
  } catch (error) {
    // Older Core versions do not expose asynchronous refresh tasks. Retain a
    // bounded compatibility path; current Core-owned tasks are the reliable path.
    if (error?.status !== 404) {
      await StorageManager.setProviderRefreshTask(instanceId, null);
      throw error;
    }
    const operation = executeProviderRefreshTask(instance, task);
    providerRefreshOperations.set(instanceId, operation);
    void operation.finally(() => {
      if (providerRefreshOperations.get(instanceId) === operation) {
        providerRefreshOperations.delete(instanceId);
      }
    }).catch(error => {
      console.error('Provider refresh compatibility task failed:', safeProviderRefreshError(error));
    });
    return task;
  }
}

async function executeProviderRefreshTask(instance, task) {
  try {
    const result = await SpikeApiClient.refreshProviders(instance, task.providerId || undefined);
    const providers = Array.isArray(result?.providers) ? result.providers : [];
    const completed = {
      ...task,
      status: 'succeeded',
      finishedAtUnix: Math.floor(Date.now() / 1000),
      revision: Number(result?.reload?.revision) || null,
      total: providers.length,
      ready: providers.filter(provider => provider.status === 'ready').length,
      missing: providers.filter(provider => provider.status === 'missing').length,
      error: null
    };
    await StorageManager.setProviderRefreshTask(instance.id, completed);
  } catch (error) {
    const reconciled = await reconcileProviderRefreshTask(instance, task, error);
    await StorageManager.setProviderRefreshTask(instance.id, reconciled);
  }
}

async function getProviderRefreshTask(instanceId) {
  if (!instanceId) return null;
  const task = await StorageManager.getProviderRefreshTask(instanceId);
  if (!task || task.status !== 'running' || providerRefreshOperations.has(instanceId)) {
    return task;
  }
  const instances = await StorageManager.getInstances();
  const instance = instances.find(candidate => candidate.id === instanceId);
  if (!instance) return task;
  const reconciled = task.coreTaskId
    ? await reconcileCoreProviderRefreshTask(instance, task)
    : await reconcileProviderRefreshTask(instance, task);
  await StorageManager.setProviderRefreshTask(instanceId, reconciled);
  return reconciled;
}

async function reconcileCoreProviderRefreshTask(instance, task) {
  try {
    const coreTask = await SpikeApiClient.getProviderRefreshTask(instance, task.coreTaskId);
    if (coreTask.status === 'running') return task;
    if (coreTask.status === 'failed') {
      return {
        ...task,
        status: 'failed',
        finishedAtUnix: Math.floor(Number(coreTask.completed_at_unix_ms || Date.now()) / 1000),
        error: safeProviderRefreshError(coreTask.error || '外部资源更新失败')
      };
    }
    const inventory = await SpikeApiClient.getProviders(instance).catch(() => null);
    const providers = Array.isArray(inventory?.providers) ? inventory.providers : [];
    return {
      ...task,
      status: 'succeeded',
      finishedAtUnix: Math.floor(Number(coreTask.completed_at_unix_ms || Date.now()) / 1000),
      revision: Number(coreTask.revision) || null,
      total: providers.length || null,
      ready: providers.length
        ? providers.filter(provider => provider.status === 'ready').length
        : null,
      missing: providers.length
        ? providers.filter(provider => provider.status === 'missing').length
        : null,
      error: null
    };
  } catch (error) {
    if (error?.status === 404) {
      return {
        ...task,
        status: 'failed',
        finishedAtUnix: Math.floor(Date.now() / 1000),
        error: 'Core 已不再保留此更新任务；请重新读取资源状态后再重试'
      };
    }
    return task;
  }
}

async function reconcileProviderRefreshTask(instance, task, requestError = null) {
  try {
    const status = await SpikeApiClient.getStatus(instance);
    const refresh = status?.provider_refresh;
    if (refresh?.refreshing === true) {
      return { ...task, status: 'running', error: null };
    }

    const lastAttempt = Number(refresh?.last_attempt_unix) || 0;
    const belongsToTask = lastAttempt >= Number(task.startedAtUnix || 0) - 1;
    if (belongsToTask && refresh?.last_result === 'success') {
      const inventory = await SpikeApiClient.getProviders(instance).catch(() => null);
      const providers = Array.isArray(inventory?.providers) ? inventory.providers : [];
      return {
        ...task,
        status: 'succeeded',
        finishedAtUnix: Number(refresh?.last_success_unix) || Math.floor(Date.now() / 1000),
        revision: Number(status?.revision) || null,
        total: providers.length || null,
        ready: providers.length
          ? providers.filter(provider => provider.status === 'ready').length
          : null,
        missing: providers.length
          ? providers.filter(provider => provider.status === 'missing').length
          : null,
        error: null
      };
    }
    if (belongsToTask && refresh?.last_result === 'error') {
      return {
        ...task,
        status: 'failed',
        finishedAtUnix: Math.floor(Date.now() / 1000),
        error: requestError
          ? safeProviderRefreshError(requestError)
          : '外部资源更新失败；当前运行配置未改变'
      };
    }
  } catch (error) {
    if (requestError) {
      return {
        ...task,
        status: 'failed',
        finishedAtUnix: Math.floor(Date.now() / 1000),
        error: safeProviderRefreshError(requestError)
      };
    }
  }

  const age = Math.floor(Date.now() / 1000) - Number(task.startedAtUnix || 0);
  if (requestError || age >= PROVIDER_REFRESH_RECONCILE_AFTER_SECONDS) {
    return {
      ...task,
      status: 'failed',
      finishedAtUnix: Math.floor(Date.now() / 1000),
      error: requestError
        ? safeProviderRefreshError(requestError)
        : '无法确认更新结果；请重新读取资源状态后再重试'
    };
  }
  return task;
}

async function reconcilePersistedProviderRefreshTasks() {
  const tasks = await StorageManager.getProviderRefreshTasks();
  const instances = await StorageManager.getInstances();
  await Promise.all(Object.values(tasks).map(async (task) => {
    if (!task || task.status !== 'running') return;
    const instance = instances.find(candidate => candidate.id === task.instanceId);
    if (!instance) return;
    const reconciled = task.coreTaskId
      ? await reconcileCoreProviderRefreshTask(instance, task)
      : await reconcileProviderRefreshTask(instance, task);
    await StorageManager.setProviderRefreshTask(instance.id, reconciled);
  }));
}

function safeProviderRefreshError(error) {
  const raw = String(error?.message || error || '未知错误');
  const redacted = raw.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}${url.search ? '?…' : ''}`;
    } catch {
      return '<redacted-url>';
    }
  });
  return redacted.slice(0, 500);
}

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

export {
  getProviderRefreshTask,
  safeProviderRefreshError,
  startProviderRefreshTask
};
