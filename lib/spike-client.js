/**
 * Spike API Client for Chrome Extension.
 * Interacts with Spike Control REST API (/status, /groups, /groups/{name}/select, /groups/test, etc.)
 */

export class SpikeApiClient {
  /**
   * Send fetch request to a Spike instance with optional authorization header.
   */
  static async request(instance, path, options = {}) {
    const baseUrl = (instance.baseUrl || 'http://127.0.0.1:9090').replace(/\/+$/, '');
    const url = `${baseUrl}${path}`;

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
    return await SpikeApiClient.request(instance, '/status');
  }

  /**
   * Fetch policy groups.
   * @returns {Promise<{revision: number, groups: Array<{name: string, kind: string, members: string[], selected?: string, hidden?: boolean, member_info?: Array<{name: string, type: string, udp?: boolean}>}>}>}
   */
  static async getGroups(instance) {
    return await SpikeApiClient.request(instance, '/groups');
  }

  /**
   * Select a member for a policy group.
   * @param {Object} instance
   * @param {string} groupName
   * @param {string} memberName
   */
  static async selectGroupMember(instance, groupName, memberName) {
    const encodedGroup = encodeURIComponent(groupName);
    return await SpikeApiClient.request(instance, `/groups/${encodedGroup}/select`, {
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
    return await SpikeApiClient.request(instance, `/groups/${encodedGroup}/select`, {
      method: 'DELETE'
    });
  }

  static async startGroupTest(instance, groupName, memberName) {
    const body = { group: groupName };
    if (memberName) body.member = memberName;

    try {
      const task = await SpikeApiClient.request(instance, '/group-tests', {
        method: 'POST',
        body
      });
      return { mode: 'async', task };
    } catch (err) {
      if (err.status !== 404) throw err;
      const result = await SpikeApiClient.request(instance, '/groups/test', {
        method: 'POST',
        body,
        timeoutMs: 120000
      });
      return { mode: 'legacy', results: result.results || [] };
    }
  }

  static async getGroupTestTask(instance, taskId) {
    return await SpikeApiClient.request(instance, `/group-tests/${taskId}`);
  }

  static async getGroupTestTasks(instance, limit = 100) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
    return await SpikeApiClient.request(instance, `/group-tests?limit=${safeLimit}`);
  }

  /**
   * Fetch metrics.
   */
  static async getMetrics(instance) {
    return await SpikeApiClient.request(instance, '/metrics.json');
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
    return await SpikeApiClient.request(instance, '/providers');
  }

  /**
   * Force-fetch remote policy/ruleset providers, then transactionally activate
   * the validated runtime snapshot. Pass `providerId` to refresh a single source.
   * @param {Object} instance
   * @param {string} [providerId]
   */
  static async refreshProviders(instance, providerId) {
    const body = providerId ? { id: providerId } : undefined;
    return await SpikeApiClient.request(instance, '/providers/refresh', {
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
    return await SpikeApiClient.request(instance, '/provider-refreshes', {
      method: 'POST',
      body
    });
  }

  static async getProviderRefreshTask(instance, taskId) {
    return await SpikeApiClient.request(instance, `/provider-refreshes/${taskId}`);
  }
}
