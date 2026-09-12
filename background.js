import { StorageManager } from './lib/storage.js';
import { dismissUnknownModuleUpdate, getModuleUpdateState, startModuleUpdate } from './lib/module-update.js';
import { SpikeApiClient } from './lib/spike-client.js';
import { getProxyControlState, invalidateProxyIntent, reconcileProxyIntent } from './lib/proxy-control.js';
import { badgeTraffic, trafficTitle } from './lib/format-rate.js';
import { initializeI18n } from './lib/i18n.js';

void initializeI18n();

// Background Service Worker for SpikeDeck

const PROVIDER_REFRESH_RECONCILE_AFTER_SECONDS = 240;
const providerRefreshOperations = new Map();
const providerRefreshStarts = new Map();
const providerRefreshPolls = new Map();
const GROUP_TEST_POLL_INTERVAL_MS = 700;
const GROUP_TEST_ALARM_PREFIX = 'group-test-reconcile:';
const OPEN_POPUP_COMMAND = 'open-popup';
const TRAFFIC_RATE_ALARM = 'traffic-rate';
const HEALTH_OFFSCREEN_PATH = 'offscreen.html';
const terminalGroupTestStatuses = new Set(['completed', 'cancelled', 'failed']);
const groupTestPollTimers = new Map();
const groupTestOperations = new Map();
let trafficWatchPorts = 0;
let isWindowFocused = true;

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || !['enableProxyMode', 'activeInstanceId', 'instances'].some((key) => key in changes)) return;
  invalidateProxyIntent();
  void reconcileProxyWithHealth().catch((error) => console.warn('Proxy intent reconciliation failed:', error));
});

async function updateWindowFocusState() {
  if (!chrome.windows?.getLastFocused) return;
  try {
    const win = await chrome.windows.getLastFocused();
    isWindowFocused = Boolean(win && win.focused && win.state !== 'minimized');
  } catch {
    isWindowFocused = true;
  }
}

if (chrome.windows?.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    const wasFocused = isWindowFocused;
    isWindowFocused = (windowId !== chrome.windows.WINDOW_ID_NONE);
    if (!wasFocused && isWindowFocused && trafficWatchPorts === 0) {
      void refreshTrafficBadgeFromActiveInstance();
    }
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await StorageManager.init();
  await updateWindowFocusState();
  await ensureOffscreenDocument();
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
  await updateWindowFocusState();
  await ensureOffscreenDocument();
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
      void ensureOffscreenDocument();
      void reconcileProxyWithHealth();
      if (trafficWatchPorts > 0) return;
      if (isWindowFocused) {
        void refreshTrafficBadgeFromActiveInstance();
      }
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

if (chrome.commands?.onCommand?.addListener) {
  chrome.commands.onCommand.addListener((command) => {
    if (command !== OPEN_POPUP_COMMAND) return;
    void openPopupFromCommand().catch((error) => {
      console.warn(`Unable to open popup from shortcut: ${error?.message || error}`);
    });
  });
}

async function openPopupFromCommand() {
  if (!(await StorageManager.isPopupShortcutEnabled())) return false;
  if (typeof chrome.action?.openPopup !== 'function') {
    throw new Error('Popup shortcut requires Chrome 127 or newer');
  }
  await chrome.action.openPopup();
  return true;
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
  if (message.type === 'ENSURE_LOG_STREAM') {
    ensureOffscreenDocument().then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message || String(err) });
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
  if (message.type === 'DISMISS_PROVIDER_REFRESH_TASK') {
    dismissProviderRefreshTask(message.instanceId, message.taskId).then((state) => {
      sendResponse({ ok: true, ...state });
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
  if (message.type === 'CANCEL_GROUP_TEST') {
    cancelGroupTestTask(message.instanceId, message.taskId).then((result) => {
      sendResponse({ ok: true, ...result });
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
    getModuleUpdateState(message.instanceId).then((state) => sendResponse({ ok: true, ...state }))
      .catch(() => sendResponse({ ok: false, error: '暂时无法查询模块任务，正在重试' }));
    return true;
  }
  if (message.type === 'DISMISS_UNKNOWN_MODULE_UPDATE') {
    dismissUnknownModuleUpdate(message.instanceId, message.taskId, message.taskSequence).then((state) => sendResponse({ ok: true, ...state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
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
  if (message.type === 'SPIKE_TRAFFIC_TICK') {
    if (isWindowFocused && trafficWatchPorts === 0) {
      void refreshTrafficBadgeFromActiveInstance();
    }
    sendResponse({ ok: true });
    return false;
  }
});

async function findInstance(instanceId) {
  const instances = await StorageManager.getInstances();
  const instance = instances.find(candidate => candidate.id === instanceId);
  if (!instance) throw new Error('Spike instance not found');
  return instance;
}

function serializeGroupTestOperation(instanceId, operation) {
  const previous = groupTestOperations.get(instanceId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  groupTestOperations.set(instanceId, current);
  return current.finally(() => {
    if (groupTestOperations.get(instanceId) === current) groupTestOperations.delete(instanceId);
  });
}

function startGroupTestTask(instanceId, groupName, memberName) {
  return serializeGroupTestOperation(instanceId, () =>
    startGroupTestTaskInner(instanceId, groupName, memberName)
  );
}

async function startGroupTestTaskInner(instanceId, groupName, memberName) {
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

function cancelGroupTestTask(instanceId, taskId) {
  return serializeGroupTestOperation(instanceId, () =>
    cancelGroupTestTaskInner(instanceId, taskId)
  );
}

async function cancelGroupTestTaskInner(instanceId, taskId) {
  const id = Number(taskId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Group test task is required');

  const instance = await findInstance(instanceId);
  const task = await SpikeApiClient.cancelGroupTestTask(instance, id);
  const tasks = mergeGroupTestTasks(
    await StorageManager.getGroupTestTasks(instanceId),
    [task]
  );
  const activeTasks = tasks.filter(candidate => !terminalGroupTestStatuses.has(candidate.status));
  await StorageManager.setGroupTestTasks(instanceId, activeTasks);
  broadcastGroupTestState(instanceId, tasks);
  if (activeTasks.length > 0) {
    scheduleGroupTestPoll(instanceId);
  } else {
    stopGroupTestPoll(instanceId);
  }
  return { task, tasks };
}

function refreshGroupTestState(instanceId, { broadcast = false } = {}) {
  return serializeGroupTestOperation(instanceId, () =>
    refreshGroupTestStateInner(instanceId, { broadcast })
  );
}

async function refreshGroupTestStateInner(instanceId, { broadcast = false } = {}) {
  const instance = await findInstance(instanceId);
  let tasks;
  try {
    const response = await SpikeApiClient.getGroupTestTasks(instance, 100);
    const snapshots = [...(response?.tasks || []), ...(response?.active_tasks || [])];
    tasks = mergeGroupTestTasks([], snapshots);
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
  const incomingNamespaces = new Set(
    (incoming || []).map(task => task?.task_namespace).filter(Boolean)
  );
  const compatibleCurrent = incomingNamespaces.size === 1
    ? (current || []).filter(task => !task?.task_namespace || incomingNamespaces.has(task.task_namespace))
    : (current || []);
  const byId = new Map();
  for (const task of [...compatibleCurrent, ...(incoming || [])]) {
    if (!task || !Number.isFinite(Number(task.id))) continue;
    const key = `${task.task_namespace || "legacy"}:${Number(task.id)}`;
    const previous = byId.get(key);
    const previousSequence = Number(previous?.update_sequence || 0);
    const incomingSequence = Number(task.update_sequence || 0);
    const previousTerminal = terminalGroupTestStatuses.has(previous?.status);
    const incomingTerminal = terminalGroupTestStatuses.has(task.status);
    if (
      previous &&
      ((previousSequence || incomingSequence)
        ? incomingSequence < previousSequence
        : (previousTerminal && !incomingTerminal) || Number(task.completed || 0) < Number(previous.completed || 0))
    ) {
      continue;
    }
    byId.set(key, task);
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

function startProviderRefreshTask(instanceId, providerId, providerIds = []) {
  if (providerRefreshStarts.has(instanceId)) return providerRefreshStarts.get(instanceId);
  const operation = startProviderRefresh(instanceId, providerId, providerIds).finally(() => {
    if (providerRefreshStarts.get(instanceId) === operation) providerRefreshStarts.delete(instanceId);
  });
  providerRefreshStarts.set(instanceId, operation);
  return operation;
}

async function startProviderRefresh(instanceId, providerId, providerIds) {
  const instances = await StorageManager.getInstances();
  const instance = instances.find(candidate => candidate.id === instanceId);
  if (!instance) throw new Error('Spike instance not found');

  const existing = await refreshProviderTask(instanceId);
  if (existing?.status === 'running') return existing;

  const requestedProviderIds = await resolveRequestedProviderIds(
    instance,
    providerId,
    providerIds
  );
  const task = {
    schemaVersion: 3,
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
  const reserved = await StorageManager.updateProviderRefreshState(instanceId, state => {
    if (state.task?.status === 'running') return;
    return { ...state, task };
  });
  if (reserved.task?.id !== task.id) return reserved.task;

  let coreTask;
  try {
    coreTask = await SpikeApiClient.startProviderRefreshTask(
      instance,
      task.providerId || undefined
    );
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
  // Failure to persist an accepted task is not evidence that the Core task failed.
  const coreTaskNamespace = typeof coreTask.task_namespace === 'string'
    && coreTask.task_namespace.length > 0
    ? coreTask.task_namespace
    : null;
  const coreTaskId = coreTaskNamespace && Number.isSafeInteger(Number(coreTask.id))
    && Number(coreTask.id) > 0
    ? Number(coreTask.id)
    : null;
  return await persistProviderRefreshTask(instanceId, {
    ...task,
    coreTaskId,
    coreTaskNamespace,
    startedAtUnix: Math.floor(Number(coreTask.started_at_unix_ms || Date.now()) / 1000),
    providerResults: normalizeProviderRefreshResults(coreTask.provider_results)
  });
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

function providerIsAvailable(provider) {
  return provider?.availability
    ? provider.availability === 'available'
    : provider?.status !== 'missing';
}

function providerIsMissing(provider) {
  return provider?.availability
    ? provider.availability === 'missing'
    : provider?.status === 'missing';
}

async function executeProviderRefreshTask(instance, task) {
  let next;
  try {
    const result = await SpikeApiClient.refreshProviders(instance, task.providerId || undefined);
    const providers = Array.isArray(result?.providers) ? result.providers : [];
    next = {
      ...task,
      status: 'succeeded',
      finishedAtUnix: Math.floor(Date.now() / 1000),
      revision: Number(result?.reload?.revision) || null,
      total: providers.length,
      ready: providers.filter(providerIsAvailable).length,
      missing: providers.filter(providerIsMissing).length,
      error: null
    };
  } catch (error) {
    next = await reconcileProviderRefreshTask(instance, task, error);
  }
  await persistProviderRefreshTask(instance.id, next);
}

async function getProviderRefreshState(instanceId) {
  await getProviderRefreshTask(instanceId);
  return await StorageManager.getProviderRefreshState(instanceId);
}

function getProviderRefreshTask(instanceId) {
  return providerRefreshStarts.get(instanceId) || refreshProviderTask(instanceId);
}

function refreshProviderTask(instanceId) {
  if (providerRefreshPolls.has(instanceId)) return providerRefreshPolls.get(instanceId);
  const operation = readProviderRefreshTask(instanceId).finally(() => {
    if (providerRefreshPolls.get(instanceId) === operation) providerRefreshPolls.delete(instanceId);
  });
  providerRefreshPolls.set(instanceId, operation);
  return operation;
}

async function readProviderRefreshTask(instanceId) {
  if (!instanceId) return null;
  const task = await StorageManager.getProviderRefreshTask(instanceId);
  if (!task) return null;
  if (task.status !== 'running') return persistProviderRefreshTask(instanceId, task);
  if (providerRefreshOperations.has(instanceId)) return task;
  const instances = await StorageManager.getInstances();
  const instance = instances.find(candidate => candidate.id === instanceId);
  if (!instance) return task;
  const reconciled = task.coreTaskId && task.coreTaskNamespace
    ? await reconcileCoreProviderRefreshTask(instance, task)
    : await reconcileProviderRefreshTask(instance, task);
  return persistProviderRefreshTask(instanceId, reconciled);
}

async function persistProviderRefreshTask(instanceId, task) {
  const committed = await StorageManager.updateProviderRefreshState(instanceId, state => {
    if (!task || state.task?.id !== task.id) return;
    // A late running snapshot or outcome cannot replace a committed terminal result.
    if (state.task.status !== 'running') {
      return state.task.outcomeRecorded ? undefined : providerRefreshOutcome(state, state.task);
    }
    return providerRefreshOutcome(state, task);
  });
  return committed.task;
}

async function dismissProviderRefreshTask(instanceId, taskId) {
  return await StorageManager.updateProviderRefreshState(instanceId, state => {
    if (!taskId || state.task?.id !== taskId || state.task.status === 'running') return;
    return { ...state, task: null };
  });
}

function providerRefreshOutcome(state, task) {
  let next = task;
  const failures = { ...state.failures };
  if (task && task.status !== 'running' && !task.outcomeRecorded) {
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
    next = { ...task, outcomeRecorded: true };
  }
  return { task: next, failures };
}

async function reconcileCoreProviderRefreshTask(instance, task) {
  try {
    const coreTask = await SpikeApiClient.getProviderRefreshTask(instance, task.coreTaskId);
    if (
      Number(coreTask.id) !== Number(task.coreTaskId)
      || coreTask.task_namespace !== task.coreTaskNamespace
    ) {
      await SpikeApiClient.getProviders(instance).catch(() => null);
      return {
        ...task,
        status: 'unknown',
        finishedAtUnix: Math.floor(Date.now() / 1000),
        error: 'Core 已重启，无法确认此前更新任务的结果；请检查当前资源状态'
      };
    }
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
        ? providers.filter(providerIsAvailable).length
        : null,
      missing: providers.length
        ? providers.filter(providerIsMissing).length
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
          ? providers.filter(providerIsAvailable).length
          : null,
        missing: providers.length
          ? providers.filter(providerIsMissing).length
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
  } catch {
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
    await getProviderRefreshTask(instance.id);
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
  const result = await reconcileProxyIntent({ timeoutMs: 10000 });
  if (result.error) throw new Error(result.error);
  if (result.healthy) void ensureOffscreenDocument().catch((error) => console.warn('Health offscreen unavailable:', error));
  return result;
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

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) return;
  if (await hasHealthOffscreen()) return;
  try {
    const justification = 'Probe runtime health, stream logs and maintain traffic badge rate updates';
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

async function reconcileProxyWithHealth() {
  const result = await reconcileProxyIntent();
  if (result.healthy) void ensureOffscreenDocument().catch((error) => console.warn('Health offscreen unavailable:', error));
  if (result.action === 'released') {
    chrome.runtime.sendMessage({ type: 'PROXY_HEALTH_CHANGED', releasedForUnhealthy: true }).catch(() => {});
  }
  return result;
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
  void StorageManager.isProxyModeEnabled()
    .then((proxyOn) => {
      setTitle(`${trafficTitle(traffic)}${proxyOn ? ' · proxy on' : ''}`);
      const badge = badgeTraffic(traffic);
      if (badge) {
        chrome.action.setBadgeBackgroundColor({ color: badge.color });
        chrome.action.setBadgeText({ text: badge.text });
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
      chrome.action.setBadgeText({ text: badgeTraffic(traffic)?.text || '' });
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

export {
  cancelGroupTestTask,
  openPopupFromCommand,
  refreshGroupTestState,
  getProviderRefreshTask,
  safeProviderRefreshError,
  startGroupTestTask,
  startProviderRefreshTask,
  reconcileProxyWithHealth
};
