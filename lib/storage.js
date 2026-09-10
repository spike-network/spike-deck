/**
 * Storage manager for SpikeDeck Chrome Extension.
 * Handles storage of Spike instances and extension settings using chrome.storage.local.
 */

import { normalizeHiddenGroupsMode } from './hidden-groups.js';

const PROVIDER_REFRESH_TASKS_KEY = 'providerRefreshTasks';
const PROVIDER_REFRESH_FAILURES_KEY = 'providerRefreshFailures';
const GROUP_TEST_TASKS_KEY = 'groupTestTasks';
let groupTestStorageWrite = Promise.resolve();
let providerStateWrite = Promise.resolve();
let moduleStateWrite = Promise.resolve();
export const DEFAULT_HEALTH_CHECK_INTERVAL = 5;
export const DEFAULT_TRAFFIC_REFRESH_INTERVAL = 1;
const HEALTH_CHECK_INTERVAL_KEY = 'healthCheckInterval';
const TRAFFIC_REFRESH_INTERVAL_KEY = 'trafficRefreshInterval';
const POPUP_SHORTCUT_ENABLED_KEY = 'enablePopupShortcut';
const COLLAPSE_GROUP_AFTER_SELECTION_KEY = 'collapseGroupAfterSelection';
const POPUP_GROUP_SNAPSHOTS_KEY = 'popupGroupSnapshots';
const MAX_POPUP_GROUP_SNAPSHOTS = 5;
let popupSnapshotWrite = Promise.resolve();

export class StorageManager {
  /**
   * Initialize storage with defaults if empty.
   */
  static async init() {
    const data = await chrome.storage.local.get(['instances', 'activeInstanceId', 'enableProxyMode']);
    if (data.instances === undefined) {
      await chrome.storage.local.set({
        instances: [],
        activeInstanceId: null,
        enableProxyMode: false
      });
    }
  }

  /**
   * Get all instances.
   * Proxy ports are discovered from Spike `/spike/status.listeners` at runtime.
   * @returns {Promise<Array<{id: string, name: string, baseUrl: string, secret?: string}>>}
   */
  static async getInstances() {
    await StorageManager.init();
    const data = await chrome.storage.local.get(['instances']);
    const instances = Array.isArray(data.instances) ? data.instances : [];
    // Drop legacy manual proxy fields; ports come from `/spike/status.listeners`.
    return instances.map((inst) => {
      if (!inst || (inst.httpProxy == null && inst.socksProxy == null)) return inst;
      const next = { ...inst };
      delete next.httpProxy;
      delete next.socksProxy;
      return next;
    });
  }

  /**
   * Get the currently active instance, or null if no instances exist.
   */
  static async getActiveInstance() {
    await StorageManager.init();
    const data = await chrome.storage.local.get(['instances', 'activeInstanceId']);
    const instances = Array.isArray(data.instances) ? data.instances : [];
    if (instances.length === 0) return null;
    const activeId = data.activeInstanceId || instances[0].id;
    return instances.find(inst => inst.id === activeId) || instances[0] || null;
  }

  /**
   * Set active instance ID.
   */
  static async setActiveInstanceId(id) {
    await chrome.storage.local.set({ activeInstanceId: id });
  }

  /**
   * Add a new instance.
   */
  static async addInstance(instance) {
    const instances = await StorageManager.getInstances();
    const newInst = {
      id: instance.id || 'inst_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      name: instance.name || 'Spike Server',
      baseUrl: (instance.baseUrl || 'http://127.0.0.1:9090').replace(/\/+$/, ''),
      secret: instance.secret || ''
    };
    instances.push(newInst);
    const data = await chrome.storage.local.get(['activeInstanceId']);
    const activeInstanceId = data.activeInstanceId || newInst.id;
    await chrome.storage.local.set({ instances, activeInstanceId });
    return newInst;
  }

  /**
   * Update an existing instance.
   */
  static async updateInstance(id, updatedData) {
    const instances = await StorageManager.getInstances();
    const idx = instances.findIndex(i => i.id === id);
    if (idx !== -1) {
      const next = {
        ...instances[idx],
        ...updatedData,
        baseUrl: (updatedData.baseUrl || instances[idx].baseUrl).replace(/\/+$/, '')
      };
      // Proxy ports come from `/spike/status.listeners`; drop legacy manual fields.
      delete next.httpProxy;
      delete next.socksProxy;
      instances[idx] = next;
      await chrome.storage.local.set({ instances });
    }
  }

  /**
   * Delete an instance by ID.
   */
  static async deleteInstance(id) {
    let instances = await StorageManager.getInstances();
    instances = instances.filter(i => i.id !== id);
    const activeInstance = await StorageManager.getActiveInstance();
    let newActiveId = null;
    if (instances.length > 0) {
      newActiveId = (activeInstance && activeInstance.id !== id && instances.some(i => i.id === activeInstance.id))
        ? activeInstance.id
        : instances[0].id;
    }
    await chrome.storage.local.set({ instances, activeInstanceId: newActiveId });
  }

  /**
   * Proxy mode status (whether Chrome browser proxy points to current instance).
   */
  static async isProxyModeEnabled() {
    const data = await chrome.storage.local.get(['enableProxyMode']);
    return Boolean(data.enableProxyMode);
  }

  static async getProxyIntent() {
    const data = await chrome.storage.local.get(['enableProxyMode', 'activeInstanceId', 'instances']);
    const instances = Array.isArray(data.instances) ? data.instances : [];
    const instance = instances.find((item) => item.id === data.activeInstanceId) || instances[0];
    return {
      enabled: Boolean(data.enableProxyMode),
      instance: instance ? { id: instance.id, baseUrl: instance.baseUrl, secret: instance.secret } : null
    };
  }

  static async setProxyModeEnabled(enabled) {
    await chrome.storage.local.set({ enableProxyMode: Boolean(enabled) });
  }

  /**
   * Whether the configured extension command may open the popup.
   * Defaults to enabled for existing installations.
   */
  static async isPopupShortcutEnabled() {
    const data = await chrome.storage.local.get([POPUP_SHORTCUT_ENABLED_KEY]);
    return data[POPUP_SHORTCUT_ENABLED_KEY] !== false;
  }

  static async setPopupShortcutEnabled(enabled) {
    await chrome.storage.local.set({ [POPUP_SHORTCUT_ENABLED_KEY]: Boolean(enabled) });
  }

  /** Whether member activation immediately collapses its policy group. */
  static async shouldCollapseGroupAfterSelection() {
    const data = await chrome.storage.local.get([COLLAPSE_GROUP_AFTER_SELECTION_KEY]);
    return data[COLLAPSE_GROUP_AFTER_SELECTION_KEY] !== false;
  }

  static async setCollapseGroupAfterSelection(enabled) {
    await chrome.storage.local.set({
      [COLLAPSE_GROUP_AFTER_SELECTION_KEY]: Boolean(enabled)
    });
  }

  /**
   * Last successful group inventory for progressive popup rendering.
   * Snapshots contain only the native groups response, never instance secrets.
   */
  static async getPopupGroupSnapshot(instanceId) {
    if (!instanceId) return null;
    const data = await chrome.storage.local.get([POPUP_GROUP_SNAPSHOTS_KEY]);
    const snapshots = data[POPUP_GROUP_SNAPSHOTS_KEY];
    const snapshot = snapshots && typeof snapshots === 'object'
      ? snapshots[instanceId]
      : null;
    return snapshot && Array.isArray(snapshot.groups) ? snapshot : null;
  }

  static async setPopupGroupSnapshot(instanceId, groups, isCurrent = () => true) {
    if (!instanceId || !Array.isArray(groups)) return;
    // Popup is the snapshot writer. Serialize its read-modify-write operations
    // and recheck the request after the asynchronous storage read.
    const write = popupSnapshotWrite.then(async () => {
      if (!isCurrent()) return;
      const data = await chrome.storage.local.get([POPUP_GROUP_SNAPSHOTS_KEY]);
      if (!isCurrent()) return;
      const current = data[POPUP_GROUP_SNAPSHOTS_KEY];
      const snapshots = current && typeof current === 'object' && !Array.isArray(current)
        ? { ...current }
        : {};
      snapshots[instanceId] = {
        groups,
        storedAtUnixMs: Date.now()
      };
      const bounded = Object.fromEntries(
        Object.entries(snapshots)
          .sort(([, left], [, right]) =>
            Number(left?.storedAtUnixMs || 0) - Number(right?.storedAtUnixMs || 0))
          .slice(-MAX_POPUP_GROUP_SNAPSHOTS)
      );
      await chrome.storage.local.set({ [POPUP_GROUP_SNAPSHOTS_KEY]: bounded });
    });
    popupSnapshotWrite = write.catch(() => {});
    return await write;
  }

  /**
   * True when SpikeDeck released chrome.proxy because Spike was unreachable
   * while the user still wants takeover. Recovery should re-apply proxy.
   */
  static async isProxyReleasedForUnhealthy() {
    const data = await chrome.storage.local.get(['proxyReleasedForUnhealthy']);
    return Boolean(data.proxyReleasedForUnhealthy);
  }

  static async setProxyReleasedForUnhealthy(released) {
    await chrome.storage.local.set({ proxyReleasedForUnhealthy: Boolean(released) });
  }

  /**
   * Hidden policy-group visibility: 'hide' | 'smart' | 'show'.
   * Migrates the legacy `showHiddenGroups` boolean when the new key is unset.
   */
  static async getHiddenGroupsMode() {
    const data = await chrome.storage.local.get(['hiddenGroupsMode', 'showHiddenGroups']);
    return normalizeHiddenGroupsMode(data.hiddenGroupsMode, data.showHiddenGroups);
  }

  static async setHiddenGroupsMode(mode) {
    const next = normalizeHiddenGroupsMode(mode);
    await chrome.storage.local.set({
      hiddenGroupsMode: next,
      showHiddenGroups: next === 'show'
    });
    return next;
  }

  /**
   * Return the latest persisted provider-refresh task for one Spike instance.
   * Task records never contain the instance secret or provider source URL.
   */
  static async getProviderRefreshTask(instanceId) {
    return (await StorageManager.getProviderRefreshState(instanceId)).task;
  }

  static async getProviderRefreshState(instanceId) {
    if (!instanceId) return { task: null, failures: {} };
    const data = await chrome.storage.local.get([
      PROVIDER_REFRESH_TASKS_KEY, PROVIDER_REFRESH_FAILURES_KEY
    ]);
    const task = data[PROVIDER_REFRESH_TASKS_KEY]?.[instanceId];
    const failures = data[PROVIDER_REFRESH_FAILURES_KEY]?.[instanceId];
    return {
      task: task && typeof task === 'object' && !Array.isArray(task) ? task : null,
      failures: failures && typeof failures === 'object' && !Array.isArray(failures)
        ? { ...failures } : {}
    };
  }

  // Background is the only writer. Popup dismissal must go through its message handler.
  // Commit task identity and its failure outcomes together; network I/O stays outside this queue.
  static async updateProviderRefreshState(instanceId, update) {
    if (!instanceId) throw new Error('Spike instance not specified');
    const write = providerStateWrite.then(async () => {
      const data = await chrome.storage.local.get([
        PROVIDER_REFRESH_TASKS_KEY, PROVIDER_REFRESH_FAILURES_KEY
      ]);
      const map = value => value && typeof value === 'object' && !Array.isArray(value)
        ? { ...value } : {};
      const tasks = map(data[PROVIDER_REFRESH_TASKS_KEY]);
      const allFailures = map(data[PROVIDER_REFRESH_FAILURES_KEY]);
      const current = { task: tasks[instanceId] || null, failures: map(allFailures[instanceId]) };
      const next = update(current);
      if (!next) return current;
      if (next.task) tasks[instanceId] = next.task;
      else delete tasks[instanceId];
      if (Object.keys(next.failures).length) allFailures[instanceId] = next.failures;
      else delete allFailures[instanceId];
      await chrome.storage.local.set({
        [PROVIDER_REFRESH_TASKS_KEY]: tasks,
        [PROVIDER_REFRESH_FAILURES_KEY]: allFailures
      });
      return next;
    });
    providerStateWrite = write.catch(() => {});
    return await write;
  }

  static async getProviderRefreshTasks() {
    const data = await chrome.storage.local.get([PROVIDER_REFRESH_TASKS_KEY]);
    const tasks = data[PROVIDER_REFRESH_TASKS_KEY];
    return tasks && typeof tasks === 'object' && !Array.isArray(tasks) ? tasks : {};
  }

  /**
   * Return the latest failed refresh outcome for each provider in one instance.
   * A failure is retained until that provider refreshes successfully.
   */
  static async getProviderRefreshFailures(instanceId) {
    return (await StorageManager.getProviderRefreshState(instanceId)).failures;
  }

  static async getModuleUpdateTask(instanceId) {
    if (!instanceId) return null;
    const key = `moduleUpdateTask:${instanceId}`;
    const data = await chrome.storage.local.get([key]);
    return data[key] && typeof data[key] === 'object' ? data[key] : null;
  }

  // Only the background module controller writes these instance-scoped records.
  static async updateModuleUpdateTask(instanceId, update) {
    const write = moduleStateWrite.then(async () => {
      const current = await StorageManager.getModuleUpdateTask(instanceId);
      const next = update(current);
      if (!next) return current;
      const task = { ...next, sequence: Number(current?.sequence || 0) + 1 };
      await chrome.storage.local.set({ [`moduleUpdateTask:${instanceId}`]: task });
      return task;
    });
    moduleStateWrite = write.catch(() => {});
    return await write;
  }

  /**
   * Return active Core-owned group-test snapshots for one Spike instance. The
   * background worker keeps these records so it can resume reconciliation
   * after Manifest V3 suspends it. Completed history remains authoritative in
   * Core and is fetched when an extension page reconnects.
   */
  static async getGroupTestTasks(instanceId) {
    if (!instanceId) return [];
    const allTasks = await StorageManager.getGroupTestTaskSets();
    const tasks = allTasks[instanceId];
    return Array.isArray(tasks) ? tasks : [];
  }

  static async setGroupTestTasks(instanceId, tasks) {
    if (!instanceId) return;
    const write = groupTestStorageWrite.catch(() => {}).then(async () => {
      const allTasks = { ...(await StorageManager.getGroupTestTaskSets()) };
      const next = Array.isArray(tasks) ? tasks.slice(-100) : [];
      if (next.length > 0) {
        allTasks[instanceId] = next;
      } else {
        delete allTasks[instanceId];
      }
      await chrome.storage.local.set({ [GROUP_TEST_TASKS_KEY]: allTasks });
    });
    groupTestStorageWrite = write;
    await write;
  }

  static async getGroupTestTaskSets() {
    const data = await chrome.storage.local.get([GROUP_TEST_TASKS_KEY]);
    const taskSets = data[GROUP_TEST_TASKS_KEY];
    return taskSets && typeof taskSets === 'object' && !Array.isArray(taskSets)
      ? taskSets
      : {};
  }

  /**
   * Group expansion mode: 'smart' | 'expand-all' | 'collapse-all' | 'remember'
   */
  static async getGroupExpandMode() {
    const data = await chrome.storage.local.get(['groupExpandMode']);
    const mode = data.groupExpandMode || 'smart';
    const allowed = new Set(['smart', 'expand-all', 'collapse-all', 'remember']);
    return allowed.has(mode) ? mode : 'smart';
  }

  static async setGroupExpandMode(mode) {
    const allowed = new Set(['smart', 'expand-all', 'collapse-all', 'remember']);
    await chrome.storage.local.set({
      groupExpandMode: allowed.has(mode) ? mode : 'smart'
    });
  }

  /**
   * Per-group expand/collapse memory used when mode is 'remember'.
   * @returns {Promise<Record<string, boolean>>} map of groupName -> expanded
   */
  static async getGroupExpandStates() {
    const data = await chrome.storage.local.get(['groupExpandStates']);
    const states = data.groupExpandStates;
    return states && typeof states === 'object' && !Array.isArray(states) ? states : {};
  }

  /**
   * Persist one group's expand/collapse state.
   */
  static async setGroupExpandState(groupName, expanded) {
    if (!groupName) return;
    const states = await StorageManager.getGroupExpandStates();
    states[groupName] = Boolean(expanded);
    await chrome.storage.local.set({ groupExpandStates: states });
  }

  /**
   * Replace or merge many group expand states.
   * @param {Record<string, boolean>} states
   * @param {{ merge?: boolean }} [options]
   */
  static async setGroupExpandStates(states, options = {}) {
    const next = states && typeof states === 'object' && !Array.isArray(states)
      ? { ...states }
      : {};
    if (options.merge) {
      const current = await StorageManager.getGroupExpandStates();
      await chrome.storage.local.set({ groupExpandStates: { ...current, ...next } });
      return;
    }
    await chrome.storage.local.set({ groupExpandStates: next });
  }

  /**
   * Health check interval (seconds). Runs regardless of window visibility.
   * Default: 5 seconds.
   */
  static async getHealthCheckInterval() {
    const data = await chrome.storage.local.get([HEALTH_CHECK_INTERVAL_KEY]);
    const val = Number(data[HEALTH_CHECK_INTERVAL_KEY]);
    return Number.isFinite(val) && val >= 1 ? Math.min(300, Math.round(val)) : DEFAULT_HEALTH_CHECK_INTERVAL;
  }

  static async setHealthCheckInterval(seconds) {
    const n = Number(seconds);
    const val = Number.isFinite(n)
      ? Math.max(1, Math.min(300, Math.round(n)))
      : DEFAULT_HEALTH_CHECK_INTERVAL;
    await chrome.storage.local.set({ [HEALTH_CHECK_INTERVAL_KEY]: val });
    return val;
  }

  /**
   * Traffic refresh interval (seconds). Runs only when Chrome window is visible.
   * Default: 1 second.
   */
  static async getTrafficRefreshInterval() {
    const data = await chrome.storage.local.get([TRAFFIC_REFRESH_INTERVAL_KEY]);
    const val = Number(data[TRAFFIC_REFRESH_INTERVAL_KEY]);
    return Number.isFinite(val) && val >= 1 ? Math.min(60, Math.round(val)) : DEFAULT_TRAFFIC_REFRESH_INTERVAL;
  }

  static async setTrafficRefreshInterval(seconds) {
    const n = Number(seconds);
    const val = Number.isFinite(n)
      ? Math.max(1, Math.min(60, Math.round(n)))
      : DEFAULT_TRAFFIC_REFRESH_INTERVAL;
    await chrome.storage.local.set({ [TRAFFIC_REFRESH_INTERVAL_KEY]: val });
    return val;
  }
}
