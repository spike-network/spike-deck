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
        throw new Error(`Spike API error: ${msg}`);
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
   * @returns {Promise<{profile: string, loaded_at_unix: number, groups: number, leaves: number, rules: number}>}
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
      body: { selected: memberName }
    });
  }

  /**
   * Trigger latency test for a group or specific member.
   * @param {Object} instance
   * @param {string} groupName
   * @param {string} [memberName]
   * @returns {Promise<{group: string, member?: string, results: Array<{member: string, ok: boolean, latency_ms?: number, error?: string}>}>}
   */
  static async testGroup(instance, groupName, memberName) {
    const body = { group: groupName };
    if (memberName) body.member = memberName;
    return await SpikeApiClient.request(instance, '/groups/test', {
      method: 'POST',
      body,
      timeoutMs: 30000 // Probe timeouts can take a bit longer
    });
  }

  /**
   * Fetch metrics.
   */
  static async getMetrics(instance) {
    return await SpikeApiClient.request(instance, '/metrics.json');
  }
}
