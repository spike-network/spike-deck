import { StorageManager } from './lib/storage.js';
import { SpikeApiClient } from './lib/spike-client.js';
import {
  preferredProxyEndpoint,
  proxyListenersFromStatus
} from './lib/proxy-listeners.js';
import { formatBadgeRate, trafficTitle } from './lib/format-rate.js';

// Background Service Worker for SpikeDeck

const PROVIDER_REFRESH_RECONCILE_AFTER_SECONDS = 240;
const providerRefreshOperations = new Map();
const moduleOperations = new Map();
const GROUP_TEST_POLL_INTERVAL_MS = 700;
const GROUP_TEST_ALARM_PREFIX = 'group-test-reconcile:';
const TRAFFIC_RATE_ALARM = 'traffic-rate';
const STATUS_PROBE_TIMEOUT_MS = 2500;
const HEALTH_OFFSCREEN_PATH = 'offscreen.html';
const terminalGroupTestStatuses = new Set(['completed', 'cancelled', 'failed']);
const groupTestPollTimers = new Map();
let trafficWatchPorts = 0;
let healthReconcileInFlight = false;

chrome.runtime.onInstalled.addListener(async () => {
  await StorageManager.init();
  try {
    await updateProxySettings();
  } catch {
    // Spike may be down; reconcileProxyWithHealth records a yield.
  }
  await reconcileProxyWithHealth();
  await reconcilePersistedProviderRefreshTasks();
  await reconcilePersistedGroupTestTasks();
  await ensureTrafficRateAlarm();
  await refreshTrafficBadgeFromActiveInstance();
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await updateProxySettings();
  } catch {
    // Spike may be down; reconcileProxyWithHealth records a yield.
  }
  await reconcileProxyWithHealth();
  await reconcilePersistedProviderRefreshTasks();
  await reconcilePersistedGroupTestTasks();
  await ensureTrafficRateAlarm();
  await refreshTrafficBadgeFromActiveInstance();
});

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === TRAFFIC_RATE_ALARM) {
      void reconcileProxyWithHealth();
      if (trafficWatchPorts > 0) return;
      void refreshTrafficBadgeFromActiveInstance();
      return;
    }
    if (!alarm.name.startsWith(GROUP_TEST_ALARM_PREFIX)) return;
    const instanceId = alarm.name.slice(GROUP_TEST_ALARM_PREFIX.length);
    void refreshGroupTestState(instanceId, { broadcast: true });
  });
}

if (chrome.runtime?.onConnect?.addListener) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'traffic-watch') return;
    trafficWatchPorts += 1;
    port.onMessage.addListener((message) => {
      if (message?.type === 'TRAFFIC_SAMPLE') {
        applyTrafficBadge(message.traffic, message.error);
        void onTrafficSampleHealth(message);
      }
    });
    port.onDisconnect.addListener(() => {
      trafficWatchPorts = Math.max(0, trafficWatchPorts - 1);
    });
  });
}

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
    startProviderRefreshTask(message.instanceId, message.providerId, message.providerIds).then((task) => {
      sendResponse({ ok: true, task });
    }).catch(err => {
      sendResponse({ ok: false, error: safeProviderRefreshError(err) });
    });
    return true;
  }
  if (message.type === 'GET_PROVIDER_REFRESH_TASK') {
    getProviderRefreshState(message.instanceId).then(({ task, failures }) => {
      sendResponse({ ok: true, task, failures });
    }).catch(err => {
      sendResponse({ ok: false, error: safeProviderRefreshError(err) });
    });
    return true;
  }
  if (message.type === 'START_GROUP_TEST') {
    startGroupTestTask(message.instanceId, message.groupName, message.memberName).then((result) => {
      sendResponse({ ok: true, ...result });
    }).catch(err => {
      sendResponse({ ok: false, error: safeGroupTestError(err) });
    });
    return true;
  }
  if (message.type === 'GET_GROUP_TEST_STATE') {
    refreshGroupTestState(message.instanceId).then((tasks) => {
      sendResponse({ ok: true, tasks });
    }).catch(err => {
      sendResponse({ ok: false, error: safeGroupTestError(err) });
    });
    return true;
  }
  if (message.type === 'START_MODULE_UPDATE') {
    startModuleUpdate(message.instanceId, message.body).then((task) => {
      sendResponse({ ok: true, task });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message || String(err) });
    });
    return true;
  }
  if (message.type === 'GET_MODULE_UPDATE') {
    sendResponse({ ok: true, task: moduleOperations.get(message.instanceId) || null });
    return false;
  }
  if (message.type === 'TRAFFIC_SAMPLE') {
    applyTrafficBadge(message.traffic, message.error);
    void onTrafficSampleHealth(message);
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'SPIKE_HEALTH_TICK') {
    void reconcileProxyWithHealth();
    sendResponse({ ok: true });
    return false;
  }
});

async function startModuleUpdate(instanceId, body) {
  const instance = await findInstance(instanceId);
  const task = { instanceId, status: 'running', body: body || {}, error: null, result: null };
  moduleOperations.set(instanceId, task);
  broadcastRuntimeTask('MODULE_UPDATE_CHANGED', instanceId, task);
  try {
    const result = await SpikeApiClient.updateModules(instance, body || {});
    const next = { ...task, status: 'completed', result, error: result?.error || null };
    moduleOperations.set(instanceId, next);
    broadcastRuntimeTask('MODULE_UPDATE_CHANGED', instanceId, next);
    return next;
  } catch (error) {
    const next = { ...task, status: 'failed', error: error.message || String(error) };
    moduleOperations.set(instanceId, next);
    broadcastRuntimeTask('MODULE_UPDATE_CHANGED', instanceId, next);
    throw error;
  }
}

function broadcastRuntimeTask(type, instanceId, task) {
  chrome.runtime.sendMessage({ type, instanceId, task }).catch(() => {});
}

async function findInstance(instanceId) {
  const instances = await StorageManager.getInstances();
  const instance = instances.find(candidate => candidate.id === instanceId);
  if (!instance) throw new Error('Spike instance not found');
  return instance;
}

async function startGroupTestTask(instanceId, groupName, memberName) {
  if (!groupName) throw new Error('Policy group is required');
  const instance = await findInstance(instanceId);
  const result = await SpikeApiClient.startGroupTest(instance, groupName, memberName || undefined);
  if (result.mode !== 'async') return result;

  const tasks = mergeGroupTestTasks(
    await StorageManager.getGroupTestTasks(instanceId),
    [result.task]
  );
  await StorageManager.setGroupTestTasks(instanceId, tasks);
  broadcastGroupTestState(instanceId, tasks);
  scheduleGroupTestPoll(instanceId);
  return result;
}

async function refreshGroupTestState(instanceId, { broadcast = false } = {}) {
  const instance = await findInstance(instanceId);
  let tasks;
  try {
    const response = await SpikeApiClient.getGroupTestTasks(instance, 100);
    tasks = Array.isArray(response?.tasks)
      ? response.tasks.slice().sort((left, right) => left.id - right.id)
      : [];
  } catch (error) {
    if (error?.status !== 404) throw error;
    // Legacy Core has only the synchronous endpoint. Keep any already stored
    // snapshots so switching instances or reopening the popup stays harmless.
    tasks = await StorageManager.getGroupTestTasks(instanceId);
  }

  const activeTasks = tasks.filter(task => !terminalGroupTestStatuses.has(task.status));
  const previous = await StorageManager.getGroupTestTasks(instanceId);
  if (JSON.stringify(previous) !== JSON.stringify(activeTasks)) {
    await StorageManager.setGroupTestTasks(instanceId, activeTasks);
    broadcast = true;
  }
  if (broadcast) broadcastGroupTestState(instanceId, tasks);

  if (activeTasks.length > 0) {
    scheduleGroupTestPoll(instanceId);
  } else {
    stopGroupTestPoll(instanceId);
  }
  return tasks;
}

function mergeGroupTestTasks(current, incoming) {
  const byId = new Map();
  for (const task of [...(current || []), ...(incoming || [])]) {
    if (task && Number.isFinite(Number(task.id))) byId.set(Number(task.id), task);
  }
  return Array.from(byId.values())
    .sort((left, right) => Number(left.id) - Number(right.id))
    .slice(-100);
}

function scheduleGroupTestPoll(instanceId) {
  if (!instanceId || groupTestPollTimers.has(instanceId)) return;
  const timer = setTimeout(() => {
    groupTestPollTimers.delete(instanceId);
    void refreshGroupTestState(instanceId, { broadcast: true }).catch(error => {
      console.warn(`Unable to poll group tests: ${safeGroupTestError(error)}`);
      scheduleGroupTestPoll(instanceId);
    });
  }, GROUP_TEST_POLL_INTERVAL_MS);
  groupTestPollTimers.set(instanceId, timer);
  scheduleGroupTestAlarm(instanceId);
}

function stopGroupTestPoll(instanceId) {
  const timer = groupTestPollTimers.get(instanceId);
  if (timer !== undefined) clearTimeout(timer);
  groupTestPollTimers.delete(instanceId);
  if (chrome.alarms?.clear) void chrome.alarms.clear(`${GROUP_TEST_ALARM_PREFIX}${instanceId}`);
}

function scheduleGroupTestAlarm(instanceId) {
  if (!chrome.alarms?.create) return;
  chrome.alarms.create(`${GROUP_TEST_ALARM_PREFIX}${instanceId}`, {
    delayInMinutes: 0.5
  });
}

function broadcastGroupTestState(instanceId, tasks) {
  if (!chrome.runtime.sendMessage) return;
  try {
    const sent = chrome.runtime.sendMessage({
      type: 'GROUP_TEST_STATE_CHANGED',
      instanceId,
      tasks
    });
    if (sent?.catch) void sent.catch(() => {});
  } catch {
    // No extension page is currently open. State is already persisted.
  }
}

async function reconcilePersistedGroupTestTasks() {
  const taskSets = await StorageManager.getGroupTestTaskSets();
  await Promise.all(Object.entries(taskSets).map(async ([instanceId, tasks]) => {
    if (!Array.isArray(tasks) || !tasks.some(task => !terminalGroupTestStatuses.has(task.status))) {
      return;
    }
    try {
      await refreshGroupTestState(instanceId, { broadcast: true });
    } catch (error) {
      console.warn(`Unable to restore group tests: ${safeGroupTestError(error)}`);
      scheduleGroupTestPoll(instanceId);
    }
  }));
}

function safeGroupTestError(error) {
  return String(error?.message || error || 'Unknown group test error').slice(0, 500);
}

async function startProviderRefreshTask(instanceId, providerId, providerIds = []) {
  const instances = await StorageManager.getInstances();
  const instance = instances.find(candidate => candidate.id === instanceId);
  if (!instance) throw new Error('Spike instance not found');

  const existing = await getProviderRefreshTask(instanceId);
  if (existing?.status === 'running') return existing;

  const requestedProviderIds = await resolveRequestedProviderIds(
    instance,
    providerId,
    providerIds
  );
  const task = {
    schemaVersion: 2,
    id: globalThis.crypto?.randomUUID?.() || `provider-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    instanceId,
    providerId: providerId || null,
    requestedProviderIds,
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
      startedAtUnix: Math.floor(Number(coreTask.started_at_unix_ms || Date.now()) / 1000),
      providerResults: normalizeProviderRefreshResults(coreTask.provider_results)
    };
    await StorageManager.setProviderRefreshTask(instanceId, accepted);
    return accepted;
  } catch (error) {
    // Older Core versions do not expose asynchronous refresh tasks. Retain a
    // bounded compatibility path; current Core-owned tasks are the reliable path.
    if (error?.status !== 404) {
      await persistProviderRefreshTask(instanceId, {
        ...task,
        status: 'failed',
        finishedAtUnix: Math.floor(Date.now() / 1000),
        error: safeProviderRefreshError(error)
      });
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

async function resolveRequestedProviderIds(instance, providerId, providerIds) {
  if (providerId) return [providerId];
  const supplied = Array.isArray(providerIds)
    ? providerIds.filter(id => typeof id === 'string' && id.length > 0)
    : [];
  if (supplied.length > 0) return [...new Set(supplied)];

  const inventory = await SpikeApiClient.getProviders(instance).catch(() => null);
  const providers = Array.isArray(inventory?.providers) ? inventory.providers : [];
  return [...new Set(providers.map(provider => provider?.id).filter(Boolean))];
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
    await persistProviderRefreshTask(instance.id, completed);
  } catch (error) {
    const reconciled = await reconcileProviderRefreshTask(instance, task, error);
    await persistProviderRefreshTask(instance.id, reconciled);
  }
}

async function getProviderRefreshState(instanceId) {
  const task = await getProviderRefreshTask(instanceId);
  const failures = await StorageManager.getProviderRefreshFailures(instanceId);
  return { task, failures };
}

async function getProviderRefreshTask(instanceId) {
  if (!instanceId) return null;
  const task = await StorageManager.getProviderRefreshTask(instanceId);
  if (!task) return null;
  if (task.status !== 'running') return persistProviderRefreshTask(instanceId, task);
  if (providerRefreshOperations.has(instanceId)) return task;
  const instances = await StorageManager.getInstances();
  const instance = instances.find(candidate => candidate.id === instanceId);
  if (!instance) return task;
  const reconciled = task.coreTaskId
    ? await reconcileCoreProviderRefreshTask(instance, task)
    : await reconcileProviderRefreshTask(instance, task);
  return persistProviderRefreshTask(instanceId, reconciled);
}

async function persistProviderRefreshTask(instanceId, task) {
  let next = task;
  if (task && task.status !== 'running' && !task.outcomeRecorded) {
    const failures = await StorageManager.getProviderRefreshFailures(instanceId);
    const providerResults = Array.isArray(task.providerResults)
      ? task.providerResults
      : [];
    if (providerResults.length > 0) {
      for (const result of providerResults) {
        if (result.status === 'failed') {
          failures[result.providerId] = {
            failedAtUnix: task.finishedAtUnix || Math.floor(Date.now() / 1000),
            error: safeProviderRefreshError(result.error || task.error || '外部资源更新失败')
          };
        } else if (result.status === 'succeeded') {
          delete failures[result.providerId];
        }
      }
    } else {
      const requestedProviderIds = Array.isArray(task.requestedProviderIds)
        ? task.requestedProviderIds
        : (task.providerId ? [task.providerId] : []);
      if (task.status === 'succeeded') {
        for (const providerId of requestedProviderIds) delete failures[providerId];
      } else if (task.status === 'failed' && task.providerId) {
        // Older Core versions cannot identify the failed member of an
        // aggregate refresh. Only persist a failure when the request targeted
        // one source; the task-level error still reports aggregate failures.
        failures[task.providerId] = {
          failedAtUnix: task.finishedAtUnix || Math.floor(Date.now() / 1000),
          error: safeProviderRefreshError(task.error || '外部资源更新失败')
        };
      }
    }
    await StorageManager.setProviderRefreshFailures(instanceId, failures);
    next = { ...task, outcomeRecorded: true };
  }
  await StorageManager.setProviderRefreshTask(instanceId, next);
  return next;
}

async function reconcileCoreProviderRefreshTask(instance, task) {
  try {
    const coreTask = await SpikeApiClient.getProviderRefreshTask(instance, task.coreTaskId);
    const providerResults = normalizeProviderRefreshResults(coreTask.provider_results);
    if (coreTask.status === 'running') {
      return providerResults.length > 0 ? { ...task, providerResults } : task;
    }
    if (coreTask.status === 'failed') {
      return {
        ...task,
        status: 'failed',
        finishedAtUnix: Math.floor(Number(coreTask.completed_at_unix_ms || Date.now()) / 1000),
        error: safeProviderRefreshError(coreTask.error || '外部资源更新失败'),
        providerResults
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
      error: null,
      providerResults
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

function normalizeProviderRefreshResults(results) {
  if (!Array.isArray(results)) return [];
  const validStatuses = new Set(['pending', 'succeeded', 'failed', 'skipped']);
  return results.flatMap((result) => {
    const providerId = typeof result?.provider_id === 'string'
      ? result.provider_id
      : '';
    const status = typeof result?.status === 'string' ? result.status : '';
    if (!providerId || !validStatuses.has(status)) return [];
    return [{
      providerId,
      status,
      error: status === 'failed'
        ? safeProviderRefreshError(result.error || '外部资源更新失败')
        : null
    }];
  });
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
    await persistProviderRefreshTask(instance.id, reconciled);
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
      await StorageManager.setProxyReleasedForUnhealthy(false);
      await closeHealthOffscreen();
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
      throw new Error('Spike /spike/status did not expose a usable HTTP or SOCKS listener');
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

    await StorageManager.setProxyReleasedForUnhealthy(false);
    await openHealthOffscreen();

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
      if (await StorageManager.isProxyModeEnabled()) {
        await StorageManager.setProxyReleasedForUnhealthy(true);
      }
      await releaseProxyControl();
    } catch (resetErr) {
      console.error('Failed to reset Chrome proxy after error:', resetErr);
    }
    throw err;
  }
}

async function hasHealthOffscreen() {
  if (chrome.runtime?.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    return contexts.some((context) => String(context.documentUrl || '').endsWith(HEALTH_OFFSCREEN_PATH));
  }
  if (chrome.offscreen?.hasDocument) {
    return chrome.offscreen.hasDocument();
  }
  return false;
}

async function openHealthOffscreen() {
  if (!chrome.offscreen?.createDocument) return;
  if (await hasHealthOffscreen()) return;
  try {
    const justification = 'Probe Spike every few seconds while proxy takeover is enabled so a dead engine can release Chrome proxy quickly';
    try {
      await chrome.offscreen.createDocument({
        url: HEALTH_OFFSCREEN_PATH,
        reasons: ['WORKERS'],
        justification
      });
    } catch (workerError) {
      const message = String(workerError?.message || workerError);
      if (message.includes('single offscreen') || message.includes('already exists')) return;
      await chrome.offscreen.createDocument({
        url: HEALTH_OFFSCREEN_PATH,
        reasons: ['BLOBS'],
        justification
      });
    }
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('single offscreen') || message.includes('already exists')) return;
    console.warn(`Health offscreen unavailable: ${message}`);
  }
}

async function closeHealthOffscreen() {
  if (!chrome.offscreen?.closeDocument) return;
  if (!(await hasHealthOffscreen())) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Already closed.
  }
}

async function onTrafficSampleHealth(message) {
  if (!(await StorageManager.isProxyModeEnabled())) return;
  if (message?.error) {
    await reconcileProxyWithHealth();
    return;
  }
  if (await StorageManager.isProxyReleasedForUnhealthy()) {
    await reconcileProxyWithHealth();
  }
}

async function probeActiveInstanceHealth() {
  const instance = await StorageManager.getActiveInstance();
  if (!instance) return { ok: false, error: 'no instance' };
  try {
    await SpikeApiClient.getStatus(instance, { timeoutMs: STATUS_PROBE_TIMEOUT_MS });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'unreachable' };
  }
}

async function yieldProxyForUnhealthy() {
  await StorageManager.setProxyReleasedForUnhealthy(true);
  await releaseProxyControl();
  chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
  chrome.action.setBadgeText({ text: 'ERR' });
  chrome.action.setTitle?.({ title: 'SpikeDeck · Spike unreachable, proxy released' });
  try {
    await chrome.runtime.sendMessage({
      type: 'PROXY_HEALTH_CHANGED',
      releasedForUnhealthy: true
    });
  } catch {
    // No popup/options page listening.
  }
}

async function reconcileProxyWithHealth() {
  if (healthReconcileInFlight) return { action: 'busy', healthy: null };
  healthReconcileInFlight = true;
  try {
    const wantProxy = await StorageManager.isProxyModeEnabled();
    if (!wantProxy) {
      await StorageManager.setProxyReleasedForUnhealthy(false);
      await closeHealthOffscreen();
      return { action: 'idle', healthy: null };
    }

    await openHealthOffscreen();

    const health = await probeActiveInstanceHealth();
    if (!health.ok) {
      await yieldProxyForUnhealthy();
      return { action: 'released', healthy: false, error: health.error };
    }

    const released = await StorageManager.isProxyReleasedForUnhealthy();
    const control = await getProxyControlState();
    if (!released && control.controlledBySpikeDeck) {
      return { action: 'holding', healthy: true };
    }

    const applied = await updateProxySettings();
    return { action: 'restored', healthy: true, ...applied };
  } finally {
    healthReconcileInFlight = false;
  }
}

async function ensureTrafficRateAlarm() {
  if (!chrome.alarms?.create) return;
  chrome.alarms.create(TRAFFIC_RATE_ALARM, { periodInMinutes: 0.5 });
}

async function refreshTrafficBadgeFromActiveInstance() {
  try {
    const instance = await StorageManager.getActiveInstance();
    if (!instance) {
      applyTrafficBadge(null, 'no instance');
      return;
    }
    const metrics = await SpikeApiClient.getMetrics(instance);
    applyTrafficBadge(metrics?.traffic);
  } catch (error) {
    applyTrafficBadge(null, error?.message || 'unreachable');
  }
}

function applyTrafficBadge(traffic, error) {
  const titleApi = chrome.action?.setTitle?.bind(chrome.action);
  const setTitle = (title) => {
    if (titleApi) titleApi({ title });
  };
  if (error || !traffic) {
    setTitle(error ? `SpikeDeck · ${error}` : 'SpikeDeck');
    void restoreProxyBadgeIfNeeded(Boolean(error));
    return;
  }
  const down = Number(traffic.download_bytes_per_second) || 0;
  const up = Number(traffic.upload_bytes_per_second) || 0;
  void StorageManager.isProxyModeEnabled()
    .then((proxyOn) => {
      setTitle(`${trafficTitle(traffic)}${proxyOn ? ' · proxy on' : ''}`);
      if (down > 0 || up > 0) {
        chrome.action.setBadgeBackgroundColor({ color: '#0f766e' });
        chrome.action.setBadgeText({ text: formatBadgeRate(down) });
        return;
      }
      if (proxyOn) {
        chrome.action.setBadgeBackgroundColor({ color: '#6366F1' });
        chrome.action.setBadgeText({ text: 'ON' });
        return;
      }
      chrome.action.setBadgeText({ text: '' });
    })
    .catch(() => {
      setTitle(trafficTitle(traffic));
      chrome.action.setBadgeText({ text: down > 0 || up > 0 ? formatBadgeRate(down) : '' });
    });
}

async function restoreProxyBadgeIfNeeded(keepErrorTitle) {
  try {
    if (await StorageManager.isProxyReleasedForUnhealthy()) {
      chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
      chrome.action.setBadgeText({ text: 'ERR' });
      if (!keepErrorTitle) {
        chrome.action.setTitle?.({ title: 'SpikeDeck · Spike unreachable, proxy released' });
      }
      return;
    }
    if (await StorageManager.isProxyModeEnabled()) {
      chrome.action.setBadgeBackgroundColor({ color: '#6366F1' });
      chrome.action.setBadgeText({ text: 'ON' });
      if (!keepErrorTitle) chrome.action.setTitle?.({ title: 'SpikeDeck · proxy on' });
      return;
    }
  } catch {
    // Fall through and clear.
  }
  chrome.action.setBadgeText({ text: '' });
}

async function releaseProxyControl() {
  await chrome.proxy.settings.clear({ scope: 'regular' });
}

async function getProxyControlState() {
  const setting = await chrome.proxy.settings.get({ incognito: false });
  return {
    levelOfControl: setting.levelOfControl,
    controlledBySpikeDeck: setting.levelOfControl === 'controlled_by_this_extension',
    releasedForUnhealthy: await StorageManager.isProxyReleasedForUnhealthy()
  };
}

export {
  refreshGroupTestState,
  getProviderRefreshTask,
  safeProviderRefreshError,
  startGroupTestTask,
  startProviderRefreshTask,
  reconcileProxyWithHealth
};
