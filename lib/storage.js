/**
 * Storage manager for SpikeDeck Chrome Extension.
 * Handles storage of Spike instances and extension settings using chrome.storage.local.
 */

const PROVIDER_REFRESH_TASKS_KEY = 'providerRefreshTasks';
const PROVIDER_REFRESH_FAILURES_KEY = 'providerRefreshFailures';
const GROUP_TEST_TASKS_KEY = 'groupTestTasks';
export const DEFAULT_HEALTH_CHECK_INTERVAL = 5;
export const DEFAULT_TRAFFIC_REFRESH_INTERVAL = 1;
const HEALTH_CHECK_INTERVAL_KEY = 'healthCheckInterval';
const TRAFFIC_REFRESH_INTERVAL_KEY = 'trafficRefreshInterval';

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

  static async setProxyModeEnabled(enabled) {
    await chrome.storage.local.set({ enableProxyMode: Boolean(enabled) });
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
   * Whether to display hidden policy groups in popup.
   */
  static async getShowHiddenGroups() {
    const data = await chrome.storage.local.get(['showHiddenGroups']);
    return Boolean(data.showHiddenGroups);
  }

  static async setShowHiddenGroups(show) {
    await chrome.storage.local.set({ showHiddenGroups: Boolean(show) });
  }

  /**
   * Return the latest persisted provider-refresh task for one Spike instance.
   * Task records never contain the instance secret or provider source URL.
   */
  static async getProviderRefreshTask(instanceId) {
    if (!instanceId) return null;
    const data = await chrome.storage.local.get([PROVIDER_REFRESH_TASKS_KEY]);
    const tasks = data[PROVIDER_REFRESH_TASKS_KEY];
    if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) return null;
    const task = tasks[instanceId];
    return task && typeof task === 'object' ? task : null;
  }

  static async setProviderRefreshTask(instanceId, task) {
    if (!instanceId) return;
    const data = await chrome.storage.local.get([PROVIDER_REFRESH_TASKS_KEY]);
    const current = data[PROVIDER_REFRESH_TASKS_KEY];
    const tasks = current && typeof current === 'object' && !Array.isArray(current)
      ? { ...current }
      : {};
    if (task) {
      tasks[instanceId] = task;
    } else {
      delete tasks[instanceId];
    }
    await chrome.storage.local.set({ [PROVIDER_REFRESH_TASKS_KEY]: tasks });
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
    if (!instanceId) return {};
    const data = await chrome.storage.local.get([PROVIDER_REFRESH_FAILURES_KEY]);
    const allFailures = data[PROVIDER_REFRESH_FAILURES_KEY];
    if (!allFailures || typeof allFailures !== 'object' || Array.isArray(allFailures)) {
      return {};
    }
    const failures = allFailures[instanceId];
    return failures && typeof failures === 'object' && !Array.isArray(failures)
      ? { ...failures }
      : {};
  }

  static async setProviderRefreshFailures(instanceId, failures) {
    if (!instanceId) return;
    const data = await chrome.storage.local.get([PROVIDER_REFRESH_FAILURES_KEY]);
    const current = data[PROVIDER_REFRESH_FAILURES_KEY];
    const allFailures = current && typeof current === 'object' && !Array.isArray(current)
      ? { ...current }
      : {};
    const next = failures && typeof failures === 'object' && !Array.isArray(failures)
      ? { ...failures }
      : {};
    if (Object.keys(next).length > 0) {
      allFailures[instanceId] = next;
    } else {
      delete allFailures[instanceId];
    }
    await chrome.storage.local.set({ [PROVIDER_REFRESH_FAILURES_KEY]: allFailures });
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
    const allTasks = { ...(await StorageManager.getGroupTestTaskSets()) };
    const next = Array.isArray(tasks) ? tasks.slice(-100) : [];
    if (next.length > 0) {
      allTasks[instanceId] = next;
    } else {
      delete allTasks[instanceId];
    }
    await chrome.storage.local.set({ [GROUP_TEST_TASKS_KEY]: allTasks });
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
