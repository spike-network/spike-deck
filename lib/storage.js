/**
 * Storage manager for SpikeDeck Chrome Extension.
 * Handles storage of Spike instances and extension settings using chrome.storage.local.
 */

const DEFAULT_INSTANCES = [
  {
    id: 'default-local',
    name: 'Local Spike',
    baseUrl: 'http://127.0.0.1:9090',
    secret: ''
  }
];

export class StorageManager {
  /**
   * Initialize storage with defaults if empty.
   */
  static async init() {
    const data = await chrome.storage.local.get(['instances', 'activeInstanceId', 'enableProxyMode']);
    if (!data.instances || data.instances.length === 0) {
      await chrome.storage.local.set({
        instances: DEFAULT_INSTANCES,
        activeInstanceId: DEFAULT_INSTANCES[0].id,
        enableProxyMode: false
      });
    }
  }

  /**
   * Get all instances.
   * Proxy ports are discovered from Spike `/status.listeners` at runtime.
   * @returns {Promise<Array<{id: string, name: string, baseUrl: string, secret?: string}>>}
   */
  static async getInstances() {
    await StorageManager.init();
    const data = await chrome.storage.local.get(['instances']);
    const instances = data.instances || DEFAULT_INSTANCES;
    // Drop legacy manual proxy fields; ports come from `/status.listeners`.
    return instances.map((inst) => {
      if (!inst || (inst.httpProxy == null && inst.socksProxy == null)) return inst;
      const next = { ...inst };
      delete next.httpProxy;
      delete next.socksProxy;
      return next;
    });
  }

  /**
   * Get the currently active instance.
   */
  static async getActiveInstance() {
    await StorageManager.init();
    const data = await chrome.storage.local.get(['instances', 'activeInstanceId']);
    const instances = data.instances || DEFAULT_INSTANCES;
    const activeId = data.activeInstanceId || instances[0].id;
    return instances.find(inst => inst.id === activeId) || instances[0];
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
    await chrome.storage.local.set({ instances });
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
      // Proxy ports come from `/status.listeners`; drop legacy manual fields.
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
    if (instances.length <= 1) {
      throw new Error('At least one Spike instance must be retained.');
    }
    instances = instances.filter(i => i.id !== id);
    const activeInstance = await StorageManager.getActiveInstance();
    let newActiveId = activeInstance.id;
    if (activeInstance.id === id) {
      newActiveId = instances[0].id;
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
   * Group expansion mode: 'smart' | 'expand-all' | 'collapse-all'
   */
  static async getGroupExpandMode() {
    const data = await chrome.storage.local.get(['groupExpandMode']);
    return data.groupExpandMode || 'smart';
  }

  static async setGroupExpandMode(mode) {
    await chrome.storage.local.set({ groupExpandMode: mode || 'smart' });
  }
}
