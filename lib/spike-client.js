/**
 * Spike API Client for Chrome Extension.
 * Interacts with the native Spike Control REST API under /spike/*.
 */

export class SpikeApiClient {
  /**
   * Send fetch request to a Spike instance with optional authorization header.
   */
  static nativePath(path) {
    const separator = path.indexOf('?');
    const pathname = separator < 0 ? path : path.slice(0, separator);
    const query = separator < 0 ? '' : path.slice(separator);
    if (pathname === '/v1' || pathname.startsWith('/v1/')) {
      throw new Error('SpikeDeck uses native /spike APIs only');
    }
    const native =
      pathname === '/spike' || pathname.startsWith('/spike/')
        ? pathname
        : `/spike${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
    return `${native}${query}`;
  }

  /**
   * URL of the Spike embedded web dashboard (`GET /` on the Control API).
   * Empty when the instance has no usable http(s) base URL.
   */
  static dashboardUrl(instance) {
    const raw = String(instance?.baseUrl || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      url.hash = '';
      url.search = '';
      url.username = '';
      url.password = '';
      const path = url.pathname.replace(/\/+$/u, '');
      return `${url.origin}${path}/`;
    } catch {
      return '';
    }
  }

  static async request(instance, path, options = {}) {
    const baseUrl = (instance.baseUrl || 'http://127.0.0.1:9090').replace(/\/+$/, '');
    const url = `${baseUrl}${SpikeApiClient.nativePath(path)}`;

    const headers = new Headers(options.headers || {});
    if (instance.secret) {
      headers.set('Authorization', `Bearer ${instance.secret}`);
    }
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
      options.body = JSON.stringify(options.body);
    }

    const timeoutMs = options.timeoutMs || 10000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body,
        signal: controller.signal,
        cache: 'no-store'
      });

      if (response.status === 401) {
        throw new Error('Authentication failed (Secret incorrect)');
      }
      if (!response.ok) {
        let msg = `HTTP ${response.status}`;
        try {
          const errJson = await response.json();
          if (errJson.error) msg = errJson.error;
        } catch {
          // ignore non-json error
        }
        const error = new Error(`Spike API error: ${msg}`);
        error.status = response.status;
        throw error;
      }

      return await response.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('Request timed out (Spike server not responding)');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch runtime status.
   * @returns {Promise<{
   *   profile: string,
   *   loaded_at_unix: number,
   *   groups: number,
   *   leaves: number,
   *   rules: number,
   *   listeners?: Array<{kind: string, address: string}>
   * }>}
   */
  static async getStatus(instance) {
    return await SpikeApiClient.request(instance, '/spike/status');
  }

  /**
   * Fetch policy groups.
   * @returns {Promise<{revision: number, groups: Array<{name: string, kind: string, members: string[], selected?: string, hidden?: boolean, member_info?: Array<{name: string, type: string, udp?: boolean}>}>}>}
   */
  static async getGroups(instance) {
    return await SpikeApiClient.request(instance, '/spike/groups');
  }

  /**
   * Fetch native process-wide outbound mode.
   * @returns {Promise<{mode: 'rule'|'direct'|'global', global_policy?: string|null}>}
   */
  static async getOutbound(instance) {
    return await SpikeApiClient.request(instance, '/spike/outbound');
  }

  /**
   * Atomically switch native process-wide outbound mode.
   * @param {Object} instance
   * @param {'rule'|'direct'|'global'} mode
   * @param {string} [policy]
   */
  static async setOutbound(instance, mode, policy) {
    const body = mode === 'global' ? { mode, policy } : { mode };
    return await SpikeApiClient.request(instance, '/spike/outbound', {
      method: 'PUT',
      body
    });
  }

  /**
   * Fetch native policy inventory.
   * @returns {Promise<{policies: Array<{name: string, type: string, udp?: boolean}>}>}
   */
  static async getPolicies(instance) {
    return await SpikeApiClient.request(instance, '/spike/policies');
  }

  /**
   * Select a member for a policy group.
   * @param {Object} instance
   * @param {string} groupName
   * @param {string} memberName
   */
  static async selectGroupMember(instance, groupName, memberName) {
    const encodedGroup = encodeURIComponent(groupName);
    return await SpikeApiClient.request(instance, `/spike/groups/${encodedGroup}/select`, {
      method: 'PUT',
      body: { member: memberName }
    });
  }

  /**
   * Clear a manual selection/override and resume default/automatic behavior.
   * @param {Object} instance
   * @param {string} groupName
   * @returns {Promise<{group: string, member: string, override_active?: boolean}>}
   */
  static async clearGroupSelection(instance, groupName) {
    const encodedGroup = encodeURIComponent(groupName);
    return await SpikeApiClient.request(instance, `/spike/groups/${encodedGroup}/select`, {
      method: 'DELETE'
    });
  }

  static async startGroupTest(instance, groupName, memberName) {
    const body = { group: groupName };
    if (memberName) body.member = memberName;

    try {
      const task = await SpikeApiClient.request(instance, '/spike/group-tests', {
        method: 'POST',
        body
      });
      return { mode: 'async', task };
    } catch (err) {
      if (err.status !== 404) throw err;
      const result = await SpikeApiClient.request(instance, '/spike/groups/test', {
        method: 'POST',
        body,
        timeoutMs: 120000
      });
      return { mode: 'legacy', results: result.results || [] };
    }
  }

  static async getGroupTestTask(instance, taskId) {
    return await SpikeApiClient.request(instance, `/spike/group-tests/${taskId}`);
  }

  static async getGroupTestTasks(instance, limit = 100) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
    return await SpikeApiClient.request(instance, `/spike/group-tests?limit=${safeLimit}`);
  }

  /**
   * Fetch process metrics, including windowed traffic rates.
   * @returns {Promise<{
   *   traffic?: {
   *     upload_bytes_total: number,
   *     download_bytes_total: number,
   *     upload_bytes_per_second?: number,
   *     download_bytes_per_second?: number,
   *     sampled_at_unix_ms?: number
   *   }
   * }>}
   */
  static async getMetrics(instance) {
    return await SpikeApiClient.request(instance, '/spike/metrics.json');
  }

  /**
   * List configured policy-path / RULE-SET / DOMAIN-SET providers and status.
   * @returns {Promise<{
   *   schema_version?: number,
   *   ok?: boolean,
   *   refreshing: boolean,
   *   providers: Array<{
   *     id: string,
   *     type: string,
   *     source: string,
   *     source_kind: string,
   *     group?: string,
   *     status: string,
   *     last_updated_unix?: number,
   *     update_interval_seconds: number
   *   }>
   * }>}
   */
  static async getProviders(instance) {
    return await SpikeApiClient.request(instance, '/spike/providers');
  }

  /**
   * Force-fetch remote policy/ruleset providers, then transactionally activate
   * the validated runtime snapshot. Pass `providerId` to refresh a single source.
   * @param {Object} instance
   * @param {string} [providerId]
   */
  static async refreshProviders(instance, providerId) {
    const body = providerId ? { id: providerId } : undefined;
    return await SpikeApiClient.request(instance, '/spike/providers/refresh', {
      method: 'POST',
      body,
      timeoutMs: 180000
    });
  }

  /**
   * Start a Core-owned provider refresh task. The task continues even when the
   * extension popup or service worker is suspended.
   */
  static async startProviderRefreshTask(instance, providerId) {
    const body = providerId ? { id: providerId } : undefined;
    return await SpikeApiClient.request(instance, '/spike/provider-refreshes', {
      method: 'POST',
      body
    });
  }

  static async getProviderRefreshTask(instance, taskId) {
    return await SpikeApiClient.request(instance, `/spike/provider-refreshes/${taskId}`);
  }

  static profileStem(path) {
    const file = String(path || '').split(/[\\/]/).filter(Boolean).at(-1) || path || '';
    return file.replace(/\.conf$/i, '');
  }

  static parseManagedProfile(text) {
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.toUpperCase().startsWith('#!MANAGED-CONFIG')) continue;
      const rest = line.slice('#!MANAGED-CONFIG'.length);
      const interval = /(?:^|[\s,])interval=(\d+)/i.exec(rest);
      const strict = /(?:^|[\s,])strict=(true|false|1|0)/i.exec(rest);
      return {
        managed: true,
        intervalSeconds: interval ? Number(interval[1]) : undefined,
        strict: strict ? ['true', '1'].includes(strict[1].toLowerCase()) : undefined
      };
    }
    return null;
  }

  static async getProfiles(instance) {
    return await SpikeApiClient.request(instance, '/spike/profiles');
  }

  static async getCurrentProfile(instance) {
    return await SpikeApiClient.request(instance, '/spike/profiles/current');
  }

  static async checkProfile(instance, name) {
    return await SpikeApiClient.request(instance, '/spike/profiles/check', {
      method: 'POST',
      body: { name }
    });
  }

  static async switchProfile(instance, name) {
    return await SpikeApiClient.request(instance, '/spike/profiles/switch', {
      method: 'POST',
      body: { name },
      timeoutMs: 30000
    });
  }

  static async getModules(instance) {
    return await SpikeApiClient.request(instance, '/spike/modules');
  }

  static async updateModules(instance, body) {
    return await SpikeApiClient.request(instance, '/spike/modules', {
      method: 'POST',
      body,
      timeoutMs: 30000
    });
  }

  static async getScripts(instance) {
    return await SpikeApiClient.request(instance, '/spike/scripts');
  }

  static async getDnsCache(instance) {
    return await SpikeApiClient.request(instance, '/spike/dns/cache');
  }

  static async measureDnsDelay(instance) {
    return await SpikeApiClient.request(instance, '/spike/dns/delay', {
      method: 'POST'
    });
  }
}
