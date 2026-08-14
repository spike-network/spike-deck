import { StorageManager } from './lib/storage.js';
import { SpikeApiClient } from './lib/spike-client.js';
import {
  proxyListenerSummary,
  proxyListenersFromStatus
} from './lib/proxy-listeners.js';

// Global latency cache for leaf nodes by member name
// key: memberName, value: { ms: number | null, ok: boolean, err?: string, at?: number }
const leafProbeResults = new Map();
let currentGroupsData = [];
const terminalGroupTestStatuses = new Set(['completed', 'cancelled', 'failed']);

/** Display labels for protocol / nested-group kinds (product typography, not raw slugs). */
function formatMemberType(type) {
  switch (String(type || '').toLowerCase()) {
    case 'shadowsocks':
    case 'ss':
      return 'SS';
    case 'trojan':
      return 'Trojan';
    case 'snell':
      return 'Snell';
    case 'vmess':
      return 'VMess';
    case 'http':
      return 'HTTP';
    case 'https':
      return 'HTTPS';
    case 'socks5':
      return 'SOCKS5';
    case 'socks5-tls':
      return 'SOCKS5-TLS';
    case 'hysteria2':
      return 'Hysteria2';
    case 'tuic':
    case 'tuic-v5':
      return 'TUIC';
    case 'anytls':
      return 'AnyTLS';
    case 'h2-connect':
      return 'H2';
    case 'ssh':
      return 'SSH';
    case 'wireguard':
      return 'WireGuard';
    case 'tailscale':
      return 'Tailscale';
    case 'external':
      return 'External';
    case 'tcp':
      return 'TCP';
    case 'udp':
      return 'UDP';
    case 'direct':
      return 'DIRECT';
    case 'reject':
      return 'REJECT';
    case 'select':
      return 'Select';
    case 'url-test':
    case 'urltest':
    case 'url':
      return 'URL-Test';
    case 'fallback':
      return 'Fallback';
    case 'load-balance':
    case 'loadbalance':
      return 'Load-Balance';
    case 'smart':
      return 'Smart';
    case 'other':
      return 'Other';
    case 'unknown':
      return 'Unknown';
    default:
      return titleCaseType(type);
  }
}

/** Title-case unknown hyphenated type slugs (`foo_bar` → `Foo-Bar`). */
function titleCaseType(type) {
  return String(type || '')
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('-');
}

function memberTypeLabel(info, fallbackType = '') {
  const raw = (info && info.type) || fallbackType;
  if (!raw) return '';
  const type = formatMemberType(raw);
  return info && info.udp ? `${type}/UDP` : type;
}

/** Helper to create DOM elements cleanly without innerHTML */
function el(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.substring(2).toLowerCase(), value);
    } else if (key === 'className') {
      element.className = value;
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [dKey, dVal] of Object.entries(value)) {
        element.dataset[dKey] = dVal;
      }
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(element.style, value);
    } else if (value !== false && value !== null && value !== undefined) {
      element.setAttribute(key, value);
    }
  }

  for (const child of children) {
    if (typeof child === 'string' || typeof child === 'number') {
      element.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      element.appendChild(child);
    }
  }
  return element;
}

/** Lightning bolt icon used by group test button and empty-node probe affordance. */
function createFlashIcon(size = 13) {
  const flashIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  flashIcon.setAttribute('viewBox', '0 0 24 24');
  flashIcon.setAttribute('width', String(size));
  flashIcon.setAttribute('height', String(size));
  flashIcon.setAttribute('stroke', 'currentColor');
  flashIcon.setAttribute('stroke-width', '2');
  flashIcon.setAttribute('fill', 'none');
  flashIcon.setAttribute('class', 'flash-icon');
  const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  polygon.setAttribute('points', '13 2 3 14 12 14 11 22 21 10 12 10 13 2');
  flashIcon.appendChild(polygon);
  return flashIcon;
}

/** Closed-eye icon for hidden policy groups (compact badge, not the word "hidden"). */
function createEyeOffIcon(size = 11) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('class', 'eye-off-icon');
  svg.setAttribute('aria-hidden', 'true');

  const paths = [
    'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94',
    'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19',
    'M14.12 14.12a3 3 0 1 1-4.24-4.24',
    'M1 1l22 22'
  ];
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** Filled pin icon: group currently has a manual override. */
function createPinIcon(size = 11) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('stroke', 'none');
  svg.setAttribute('class', 'pin-icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  // Compact pin (head + needle).
  path.setAttribute(
    'd',
    'M16 3a1 1 0 0 1 1 1v1.382a3 3 0 0 1-.879 2.121L14 9.624V13a1 1 0 0 1-.553.894l-3 1.5A1 1 0 0 1 9 14.5V9.624L6.879 7.503A3 3 0 0 1 6 5.382V4a1 1 0 0 1 1-1h9zM12 17v4a1 1 0 1 1-2 0v-4.118l1-.5 1 .5z'
  );
  svg.appendChild(path);
  return svg;
}

/** Pin-off icon: clear manual override and resume automatic selection. */
function createPinOffIcon(size = 13) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('class', 'pin-off-icon');
  svg.setAttribute('aria-hidden', 'true');

  const paths = [
    'M12 17v5',
    'M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89',
    'M2 2l20 20',
    'M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h12'
  ];
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** Whether a group kind supports manual pin/override of automatic selection. */
function isAutomaticGroupKind(kind) {
  switch (String(kind || '').toLowerCase()) {
    case 'url-test':
    case 'urltest':
    case 'url':
    case 'fallback':
    case 'smart':
      return true;
    default:
      return false;
  }
}

/** Whether a probe result exists (success or failure), vs never tested. */
function hasLatencyResult(latInfo) {
  if (!latInfo) return false;
  if (typeof latInfo.ok === 'boolean') return true;
  if (typeof latInfo.ms === 'number') return true;
  return false;
}

document.addEventListener('DOMContentLoaded', async () => {
  await StorageManager.init();
  const instances = await StorageManager.getInstances();
  let activeInstance = await StorageManager.getActiveInstance();

  const instanceSelect = document.getElementById('instance-select');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const profileName = document.getElementById('profile-name');
  const badgeGroups = document.getElementById('badge-groups');
  const badgeNodes = document.getElementById('badge-nodes');
  const badgeRules = document.getElementById('badge-rules');
  const proxyListeners = document.getElementById('proxy-listeners');
  const proxyControlState = document.getElementById('proxy-control-state');
  const groupsContainer = document.getElementById('groups-container');
  const appContainer = document.querySelector('.container');

  const btnTestAll = document.getElementById('btn-test-all');
  const btnRefreshProviders = document.getElementById('btn-refresh-providers');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnOptions = document.getElementById('btn-options');
  const providersPanel = document.getElementById('providers-panel');
  const providersPanelCount = document.getElementById('providers-panel-count');
  const providersPanelNotice = document.getElementById('providers-panel-notice');
  const providersList = document.getElementById('providers-list');
  const btnProvidersRefreshAll = document.getElementById('btn-providers-refresh-all');
  const btnProvidersClose = document.getElementById('btn-providers-close');
  const toggleProxy = document.getElementById('toggle-chrome-proxy');
  const proxyToggleWrapper = document.getElementById('proxy-toggle-wrapper');
  const btnToggleHidden = document.getElementById('btn-toggle-hidden');
  const btnExpandAll = document.getElementById('btn-expand-all');
  const btnCollapseAll = document.getElementById('btn-collapse-all');

  let showHiddenGroups = await StorageManager.getShowHiddenGroups();
  let groupExpandMode = await StorageManager.getGroupExpandMode();
  let groupExpandStates = await StorageManager.getGroupExpandStates();
  const activeGroupTests = new Map();
  let groupTestPollTimer = null;
  let providersPanelNoticeTimer = null;
  /** @type {Array<{id: string, type: string, source: string, source_kind: string, group?: string, status: string, last_updated_unix?: number, update_interval_seconds: number}>} */
  let currentProviders = [];
  let providersRefreshing = false;
  /** Busy key: '*' for all, or a provider id. */
  let providersBusyKey = '';
  let providerRefreshTask = null;
  let providerRefreshFailures = {};
  let providerRefreshPollTimer = null;
  let handledProviderTaskState = '';
  updateHiddenToggleUI();

  function showProvidersPanelNotice(message, state, timeoutMs = 0) {
    if (providersPanelNoticeTimer !== null) {
      clearTimeout(providersPanelNoticeTimer);
      providersPanelNoticeTimer = null;
    }
    providersPanelNotice.hidden = false;
    providersPanelNotice.className = `providers-panel-notice ${state}`;
    providersPanelNotice.textContent = message;
    if (timeoutMs > 0) {
      providersPanelNoticeTimer = setTimeout(() => {
        providersPanelNotice.hidden = true;
        providersPanelNoticeTimer = null;
      }, timeoutMs);
    }
  }

  function clearProvidersPanelNotice() {
    if (providersPanelNoticeTimer !== null) {
      clearTimeout(providersPanelNoticeTimer);
      providersPanelNoticeTimer = null;
    }
    providersPanelNotice.hidden = true;
    providersPanelNotice.textContent = '';
    providersPanelNotice.className = 'providers-panel-notice';
  }

  function providerTypeLabel(type) {
    if (type === 'policy-group') return 'POLICY-PATH';
    if (type === 'ruleset') return 'RULE-SET';
    return String(type || 'UNKNOWN').toUpperCase();
  }

  function providerStatusLabel(status) {
    if (status === 'ready') return '就绪';
    if (status === 'missing') return '缺失';
    if (status === 'refreshing') return '更新中';
    if (status === 'update_failed') return '更新失败';
    if (status === 'unknown') return '待确认';
    return status || '未知';
  }

  function safeProviderSource(provider) {
    const source = String(provider?.source || '');
    if (provider?.source_kind !== 'remote') return source;
    try {
      const url = new URL(source);
      const path = url.pathname === '/' ? '' : url.pathname;
      return `${url.host}${path}${url.search ? '?…' : ''}`;
    } catch {
      return source.replace(/\?.*$/, '?…');
    }
  }

  function providerDisplayName(provider) {
    return provider?.group || safeProviderSource(provider) || provider?.id || '未命名资源';
  }

  function formatProviderInterval(seconds) {
    const value = Number(seconds) || 0;
    if (value <= 0) return '手动';
    if (value < 60) return `${value}s`;
    if (value < 3600) return `${Math.round(value / 60)}m`;
    if (value < 86400) return `${Math.round(value / 3600)}h`;
    return `${Math.round(value / 86400)}d`;
  }

  function formatProviderAbsoluteTime(unixSeconds) {
    if (!unixSeconds) return '从未';
    return new Date(unixSeconds * 1000).toLocaleString();
  }

  function formatProviderRelativeTime(unixSeconds) {
    if (!unixSeconds) return '—';
    const delta = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
    if (delta < 60) return '刚刚';
    if (delta < 3600) {
      const minutes = Math.floor(delta / 60);
      return `${minutes} 分钟前`;
    }
    if (delta < 86400) {
      const hours = Math.floor(delta / 3600);
      return `${hours} 小时前`;
    }
    const days = Math.floor(delta / 86400);
    return `${days} 天前`;
  }

  function summarizeProviderRefreshTask(task) {
    const parts = [];
    if (task.providerId) {
      const target = currentProviders.find(provider => provider.id === task.providerId);
      parts.push(`已更新：${target ? providerDisplayName(target) : '所选资源'}`);
    } else {
      parts.push('全部外部资源更新完成');
    }
    if (Number.isFinite(task.ready) && Number.isFinite(task.total)) {
      parts.push(`${task.ready}/${task.total} 就绪`);
    }
    if (Number(task.missing) > 0) parts.push(`${task.missing} 缺失`);
    if (task.revision) parts.push(`rev ${task.revision}`);
    return parts.join(' · ');
  }

  function setProvidersPanelOpen(open) {
    providersPanel.hidden = !open;
    btnRefreshProviders.setAttribute('aria-expanded', open ? 'true' : 'false');
    btnRefreshProviders.classList.toggle('active', open);
    btnRefresh.title = open ? '刷新外部资源状态' : '刷新列表';
    appContainer?.classList.toggle('providers-view', open);
    if (!open) {
      clearProvidersPanelNotice();
      if (providerRefreshTask && providerRefreshTask.status !== 'running') {
        void StorageManager.setProviderRefreshTask(activeInstance.id, null);
        providerRefreshTask = null;
        handledProviderTaskState = '';
      }
    }
  }

  function isProvidersPanelOpen() {
    return !providersPanel.hidden;
  }

  async function openProvidersPanel() {
    setProvidersPanelOpen(true);
    await Promise.all([
      loadProvidersList(),
      syncProviderRefreshTask({ announce: true })
    ]);
    renderProvidersList();
  }

  async function loadProvidersList(showLoading = true) {
    const targetInstance = activeInstance;
    if (showLoading) {
      providersList.replaceChildren(
        el('div', { className: 'providers-empty' },
          el('span', { className: 'mini-spinner' }),
          el('span', {}, '正在加载外部资源…')
        )
      );
      providersPanelCount.textContent = '';
    }
    try {
      const data = await SpikeApiClient.getProviders(targetInstance);
      if (activeInstance?.id !== targetInstance?.id) return;
      currentProviders = Array.isArray(data.providers) ? data.providers : [];
      providersRefreshing = data.refreshing === true;
      renderProvidersList();
      if (providersRefreshing) {
        scheduleProviderRefreshPoll();
      }
    } catch (err) {
      if (activeInstance?.id !== targetInstance?.id) return;
      if (showLoading || currentProviders.length === 0) {
        currentProviders = [];
        providersRefreshing = false;
        providersPanelCount.textContent = '';
        providersList.replaceChildren(
          el('div', { className: 'providers-empty error' },
            `加载失败: ${err.message || '未知错误'}`
          )
        );
        btnProvidersRefreshAll.disabled = true;
      }
    }
  }

  function scheduleProviderRefreshPoll(delay = 750) {
    if (providerRefreshPollTimer !== null) return;
    providerRefreshPollTimer = setTimeout(async () => {
      providerRefreshPollTimer = null;
      await syncProviderRefreshTask({ announce: true });
      if (providerRefreshTask?.status !== 'running' && providersRefreshing) {
        await loadProvidersList(false);
      }
      if (providerRefreshTask?.status === 'running' || providersRefreshing) {
        scheduleProviderRefreshPoll(1000);
      }
    }, delay);
  }

  async function syncProviderRefreshTask({ announce = false } = {}) {
    const targetInstance = activeInstance;
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'GET_PROVIDER_REFRESH_TASK',
        instanceId: targetInstance.id
      });
    } catch (error) {
      console.warn(`Unable to restore provider refresh task: ${error.message}`);
      return;
    }
    if (activeInstance?.id !== targetInstance?.id || !response?.ok) return;

    const previousStatus = providerRefreshTask?.status;
    providerRefreshTask = response.task || null;
    providerRefreshFailures = response.failures && typeof response.failures === 'object'
      ? response.failures
      : {};
    const running = providerRefreshTask?.status === 'running';
    providersBusyKey = running
      ? (providerRefreshTask.providerId || '*')
      : '';
    btnRefreshProviders.classList.toggle('testing', running || providersRefreshing);

    if (running) {
      clearProvidersPanelNotice();
      renderProvidersList();
      scheduleProviderRefreshPoll();
      return;
    }

    const stateKey = providerRefreshTask
      ? `${providerRefreshTask.id}:${providerRefreshTask.status}`
      : '';
    const newlySettled = stateKey && stateKey !== handledProviderTaskState;
    if (newlySettled && (announce || previousStatus === 'running')) {
      await loadProvidersList(false);
      if (providerRefreshTask.status === 'succeeded') {
        if (isProvidersPanelOpen()) {
          handledProviderTaskState = stateKey;
          showProvidersPanelNotice(
            summarizeProviderRefreshTask(providerRefreshTask),
            'success'
          );
        }
        void loadDashboard();
      } else if (providerRefreshTask.status === 'failed' && isProvidersPanelOpen()) {
        handledProviderTaskState = stateKey;
        showProvidersPanelNotice(
          `更新失败：${providerRefreshTask.error || '未知错误'}；当前运行配置未改变。`,
          'error'
        );
      }
    } else if (!providerRefreshTask && providersRefreshing) {
      clearProvidersPanelNotice();
    }
    renderProvidersList();
  }

  function resolveProviderDisplayStatus(provider) {
    if (providersBusyKey === '*' || providersBusyKey === provider.id) {
      return 'refreshing';
    }
    if (providersRefreshing && provider.status === 'refreshing') {
      return 'refreshing';
    }
    if (providerRefreshFailures[provider.id]) {
      return 'update_failed';
    }
    return provider.status || 'unknown';
  }

  function renderProvidersList() {
    const count = currentProviders.length;
    providersPanelCount.textContent = count > 0 ? `${count} 项` : '';
    const busyAll = providersBusyKey === '*';
    const anyLocalBusy = Boolean(providersBusyKey);
    const headerBusy = anyLocalBusy || providersRefreshing;

    btnProvidersRefreshAll.disabled = count === 0 || anyLocalBusy || providersRefreshing;
    btnProvidersRefreshAll.textContent = headerBusy ? '更新中…' : '全部更新';
    btnProvidersRefreshAll.classList.toggle('testing', headerBusy);
    btnRefreshProviders.classList.toggle('testing', headerBusy);

    if (count === 0) {
      providersList.replaceChildren(
        el('div', { className: 'providers-empty' }, '未配置外部资源（policy-path / RULE-SET / DOMAIN-SET）')
      );
      return;
    }

    providersList.replaceChildren();
    currentProviders.forEach((provider) => {
      const rowUpdating = providersBusyKey === '*' || providersBusyKey === provider.id;
      const displayStatus = resolveProviderDisplayStatus(provider);
      const statusClass = `provider-status status-${displayStatus}`;
      const typeLabel = providerTypeLabel(provider.type);
      const statusLabel = providerStatusLabel(displayStatus);
      const refreshFailure = providerRefreshFailures[provider.id];
      const safeSource = safeProviderSource(provider);
      const sourceTitle = [
        safeSource,
        provider.group ? `组: ${provider.group}` : null,
        `来源: ${provider.source_kind || 'unknown'}`,
        `间隔: ${formatProviderInterval(provider.update_interval_seconds)}`,
        `更新: ${formatProviderAbsoluteTime(provider.last_updated_unix)}`
      ].filter(Boolean).join('\n');

      const updateBtn = el('button', {
        type: 'button',
        className: 'btn-provider-row-update',
        disabled: anyLocalBusy || providersRefreshing,
        title: provider.source_kind === 'local' ? '重新读取此本地资源' : '强制下载并应用此资源',
        onClick: (e) => {
          e.stopPropagation();
          void runProviderRefresh(provider.id);
        }
      }, rowUpdating ? '…' : (provider.source_kind === 'local' ? '重读' : '更新'));

      const metaParts = [];
      metaParts.push(provider.source_kind === 'remote' ? '远程' : (provider.source_kind === 'local' ? '本地' : (provider.source_kind || '未知')));
      metaParts.push(formatProviderInterval(provider.update_interval_seconds));

      const row = el('div', {
        className: `provider-row ${rowUpdating ? 'busy' : ''}`,
        dataset: { providerId: provider.id }
      },
        el('div', { className: 'provider-row-main' },
          el('div', { className: 'provider-row-top' },
            el('span', { className: 'provider-type' }, typeLabel),
            el('span', {
              className: statusClass,
              title: refreshFailure?.error || ''
            }, statusLabel),
            updateBtn
          ),
          el('div', {
            className: 'provider-source',
            title: sourceTitle
          }, providerDisplayName(provider)),
          provider.group && safeSource
            ? el('div', { className: 'provider-origin', title: safeSource }, safeSource)
            : null,
          el('div', { className: 'provider-row-meta' },
            el('span', {
              className: 'provider-updated',
              title: formatProviderAbsoluteTime(provider.last_updated_unix)
            }, formatProviderRelativeTime(provider.last_updated_unix)),
            el('span', { className: 'provider-meta-sep' }, '·'),
            el('span', { className: 'provider-meta-extra' }, metaParts.join(' · '))
          )
        )
      );
      providersList.appendChild(row);
    });
  }

  async function runProviderRefresh(providerId) {
    if (providersBusyKey || providersRefreshing) return;
    const targetInstance = activeInstance;
    providerRefreshTask = {
      id: 'starting',
      instanceId: targetInstance.id,
      providerId: providerId || null,
      status: 'running'
    };
    providersBusyKey = providerId || '*';
    btnRefreshProviders.classList.add('testing');
    clearProvidersPanelNotice();
    renderProvidersList();

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'START_PROVIDER_REFRESH',
        instanceId: targetInstance.id,
        providerId: providerId || null,
        providerIds: providerId ? [providerId] : currentProviders.map(provider => provider.id)
      });
      if (activeInstance?.id !== targetInstance?.id) return;
      if (!response?.ok || !response.task) {
        throw new Error(response?.error || '无法启动外部资源更新');
      }
      providerRefreshTask = response.task;
      providersBusyKey = providerRefreshTask.providerId || '*';
      handledProviderTaskState = '';
      clearProvidersPanelNotice();
      renderProvidersList();
      scheduleProviderRefreshPoll(250);
    } catch (err) {
      if (activeInstance?.id !== targetInstance?.id) return;
      providerRefreshTask = null;
      providersBusyKey = '';
      btnRefreshProviders.classList.remove('testing');
      showProvidersPanelNotice(
        `无法启动更新：${err.message || '未知错误'}；当前运行配置未改变。`,
        'error'
      );
      renderProvidersList();
      await syncProviderRefreshTask({ announce: true });
    }
  }

  function scheduleGroupTestPoll(delay = 350) {
    if (groupTestPollTimer !== null || activeGroupTests.size === 0) return;
    groupTestPollTimer = setTimeout(() => {
      groupTestPollTimer = null;
      void pollGroupTests();
    }, delay);
  }

  async function pollGroupTests() {
    const taskIds = Array.from(activeGroupTests.keys());
    await Promise.all(taskIds.map(async (taskId) => {
      try {
        const task = await SpikeApiClient.getGroupTestTask(activeInstance, taskId);
        handleGroupTestTask(task);
      } catch (err) {
        if (err.status === 404) {
          finishGroupTestTask(taskId);
        } else {
          console.warn(`Unable to poll group test ${taskId}: ${err.message}`);
        }
      }
    }));
    scheduleGroupTestPoll(700);
  }

  function handleGroupTestTask(task) {
    const metadata = activeGroupTests.get(task.id) || {
      groupName: task.group,
      targetMember: task.member || null,
      completedMembers: new Set()
    };
    metadata.completedMembers = new Set(
      (task.results || []).map((result) => result.member)
    );
    activeGroupTests.set(task.id, metadata);
    if (Array.isArray(task.results) && task.results.length > 0) {
      const recordedAt = task.completed_at_unix_ms
        || task.started_at_unix_ms
        || task.created_at_unix_ms
        || Date.now();
      recordProbeResults(task.results, recordedAt);
    }
    updateAllLatencyBadgesDOM();
    if (terminalGroupTestStatuses.has(task.status)) {
      finishGroupTestTask(task.id);
      void refreshProbeSnapshots();
    } else {
      activeGroupTests.set(task.id, metadata);
    }
  }

  function finishGroupTestTask(taskId) {
    const metadata = activeGroupTests.get(taskId);
    activeGroupTests.delete(taskId);
    if (metadata) {
      const stillTestingGroup = Array.from(activeGroupTests.values())
        .some((task) => task.groupName === metadata.groupName);
      if (!stillTestingGroup) {
        const button = document.querySelector(
          `.btn-test-group[data-group="${CSS.escape(metadata.groupName)}"]`
        );
        if (button) button.classList.remove('testing');
      }
    }
    updateAllLatencyBadgesDOM();
  }

  async function refreshProbeSnapshots() {
    try {
      const groupsData = await SpikeApiClient.getGroups(activeInstance);
      currentGroupsData = groupsData.groups || [];
      ingestPersistedMemberInfo(currentGroupsData);
      updateAllLatencyBadgesDOM();
    } catch {
      // Progressive task results already populated the UI; retry on refresh.
    }
  }

  async function restoreRecentGroupTests() {
    try {
      const response = await SpikeApiClient.getGroupTestTasks(activeInstance, 100);
      const tasks = Array.isArray(response.tasks)
        ? response.tasks.slice().sort((left, right) => left.id - right.id)
        : [];
      for (const task of tasks) {
        const recordedAt = task.completed_at_unix_ms
          || task.started_at_unix_ms
          || task.created_at_unix_ms
          || Date.now();
        recordProbeResults(task.results, recordedAt);
        if (!terminalGroupTestStatuses.has(task.status)) {
          activeGroupTests.set(task.id, {
            groupName: task.group,
            targetMember: task.member || null,
            completedMembers: new Set(
              (task.results || []).map((result) => result.member)
            )
          });
        }
      }
      updateAllLatencyBadgesDOM();
      scheduleGroupTestPoll();
    } catch (err) {
      if (err.status !== 404) {
        console.warn(`Unable to restore group tests: ${err.message}`);
      }
    }
  }

  function resetGroupTestTracking() {
    activeGroupTests.clear();
    if (groupTestPollTimer !== null) {
      clearTimeout(groupTestPollTimer);
      groupTestPollTimer = null;
    }
  }

  btnToggleHidden.addEventListener('click', async () => {
    showHiddenGroups = !showHiddenGroups;
    await StorageManager.setShowHiddenGroups(showHiddenGroups);
    updateHiddenToggleUI();
    renderGroups(currentGroupsData);
  });

  btnExpandAll.addEventListener('click', () => {
    void setAllGroupsExpanded(true);
  });

  btnCollapseAll.addEventListener('click', () => {
    void setAllGroupsExpanded(false);
  });

  function updateHiddenToggleUI() {
    if (showHiddenGroups) {
      btnToggleHidden.classList.add('active');
    } else {
      btnToggleHidden.classList.remove('active');
    }
  }

  /**
   * Expand or collapse every visible group card.
   * When mode is 'remember', persist the resulting states.
   */
  async function setAllGroupsExpanded(expanded) {
    const cards = groupsContainer.querySelectorAll('.group-card');
    if (cards.length === 0) return;

    const nextStates = { ...groupExpandStates };
    cards.forEach((card) => {
      card.classList.toggle('expanded', expanded);
      if (card.dataset.group) {
        nextStates[card.dataset.group] = expanded;
      }
    });

    groupExpandStates = nextStates;
    if (groupExpandMode === 'remember') {
      await StorageManager.setGroupExpandStates(nextStates);
    }
  }

  async function persistGroupExpandState(groupName, expanded) {
    if (!groupName) return;
    groupExpandStates = { ...groupExpandStates, [groupName]: Boolean(expanded) };
    if (groupExpandMode === 'remember') {
      await StorageManager.setGroupExpandState(groupName, expanded);
    }
  }

  function resolveInitialExpand(group, idx) {
    if (groupExpandMode === 'expand-all') return true;
    if (groupExpandMode === 'collapse-all') return false;
    if (groupExpandMode === 'remember') {
      if (Object.prototype.hasOwnProperty.call(groupExpandStates, group.name)) {
        return Boolean(groupExpandStates[group.name]);
      }
      // Unknown groups fall back to smart defaults until the user toggles them.
      return idx < 2 || group.kind === 'select';
    }
    // smart
    return idx < 2 || group.kind === 'select';
  }

  // Populate Instance Selector
  function renderInstanceSelector() {
    instanceSelect.replaceChildren();
    instances.forEach((inst) => {
      const opt = el('option', { value: inst.id }, inst.name);
      if (inst.id === activeInstance.id) {
        opt.selected = true;
      }
      instanceSelect.appendChild(opt);
    });
  }
  renderInstanceSelector();

  // Proxy toggle state
  const isProxyEnabled = await StorageManager.isProxyModeEnabled();
  toggleProxy.checked = isProxyEnabled;
  void refreshProxyControlState();

  toggleProxy.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    const previous = !enabled;
    toggleProxy.disabled = true;
    proxyToggleWrapper.classList.add('busy');
    try {
      await StorageManager.setProxyModeEnabled(enabled);
      const response = await chrome.runtime.sendMessage({ type: 'UPDATE_PROXY_SETTING' });
      if (!response || !response.ok) {
        throw new Error(response?.error || '无法更新浏览器代理设置');
      }
      renderProxyControlState(response, enabled);
    } catch (err) {
      await StorageManager.setProxyModeEnabled(previous);
      toggleProxy.checked = previous;
      proxyControlState.className = 'proxy-control-state blocked';
      proxyControlState.textContent = `代理控制失败: ${err.message}`;
    } finally {
      toggleProxy.disabled = false;
      proxyToggleWrapper.classList.remove('busy');
    }
  });

  // Instance selector change handler
  instanceSelect.addEventListener('change', async (e) => {
    const selectedId = e.target.value;
    await StorageManager.setActiveInstanceId(selectedId);
    resetGroupTestTracking();
    activeInstance = await StorageManager.getActiveInstance();
    providersBusyKey = '';
    providerRefreshTask = null;
    providerRefreshFailures = {};
    handledProviderTaskState = '';
    if (providerRefreshPollTimer !== null) {
      clearTimeout(providerRefreshPollTimer);
      providerRefreshPollTimer = null;
    }
    currentProviders = [];
    providersRefreshing = false;
    btnRefreshProviders.classList.remove('testing');
    chrome.runtime.sendMessage({ type: 'UPDATE_PROXY_SETTING' });
    if (isProvidersPanelOpen()) {
      clearProvidersPanelNotice();
      await Promise.all([
        loadProvidersList(),
        syncProviderRefreshTask({ announce: true })
      ]);
    } else {
      void syncProviderRefreshTask();
    }
    loadDashboard();
  });

  btnRefresh.addEventListener('click', () => {
    if (isProvidersPanelOpen()) {
      void Promise.all([
        loadProvidersList(),
        syncProviderRefreshTask({ announce: true })
      ]);
    } else {
      loadDashboard();
    }
  });

  btnRefreshProviders.addEventListener('click', async () => {
    if (isProvidersPanelOpen()) {
      setProvidersPanelOpen(false);
      return;
    }
    await openProvidersPanel();
  });

  btnProvidersClose.addEventListener('click', () => {
    setProvidersPanelOpen(false);
  });

  btnProvidersRefreshAll.addEventListener('click', async () => {
    await runProviderRefresh();
  });

  btnOptions.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options.html'));
    }
  });

  btnTestAll.addEventListener('click', async () => {
    await runTestAll();
  });

  // Main Dashboard Loader
  async function loadDashboard() {
    setStatus('testing', '正在连接...');
    
    const loadingNode = el('div', { className: 'loading-placeholder' },
      el('div', { className: 'spinner' }),
      el('span', {}, '正在加载 Spike 策略组...')
    );
    groupsContainer.replaceChildren(loadingNode);

    try {
      const [status, groupsData] = await Promise.all([
        SpikeApiClient.getStatus(activeInstance),
        SpikeApiClient.getGroups(activeInstance)
      ]);

      setStatus('online', '已连接');
      profileName.textContent = status.profile || 'Default';
      badgeGroups.textContent = `组: ${status.groups || groupsData.groups?.length || 0}`;
      badgeNodes.textContent = `节点: ${status.leaves || 0}`;
      badgeRules.textContent = `规则: ${status.rules || 0}`;
      renderProxyListeners(status);

      currentGroupsData = groupsData.groups || [];

      // Ingest persisted probe results from all group member_info fields
      ingestPersistedMemberInfo(currentGroupsData);

      renderGroups(currentGroupsData);
      void restoreRecentGroupTests();
    } catch (err) {
      setStatus('offline', '未连接');
      profileName.textContent = '-';
      badgeGroups.textContent = '组: -';
      badgeNodes.textContent = '节点: -';
      badgeRules.textContent = '规则: -';
      proxyListeners.replaceChildren(el('span', { className: 'proxy-listener-empty' }, '-'));

      const retryBtn = el('button', { id: 'btn-retry', className: 'icon-btn', style: { marginTop: '6px' } }, '重试连接');
      retryBtn.addEventListener('click', () => loadDashboard());

      const errorNode = el('div', { className: 'empty-state' },
        el('p', {}, '⚠️ 无法连接到 Spike 实例'),
        el('p', { style: { fontSize: '11px', color: 'var(--text-dim)' } }, err.message || '未知错误'),
        retryBtn
      );
      groupsContainer.replaceChildren(errorNode);
    }
  }

  function renderProxyListeners(status) {
    const listeners = proxyListenerSummary(proxyListenersFromStatus(status, activeInstance));
    if (listeners.length === 0) {
      proxyListeners.replaceChildren(
        el('span', { className: 'proxy-listener-empty' }, '未发现 HTTP / SOCKS5 / Mixed')
      );
      return;
    }
    proxyListeners.replaceChildren(...listeners.map((listener) =>
      el('span', { className: 'proxy-listener' },
        el('span', { className: 'proxy-listener-kind' }, listener.label),
        el('span', { className: 'proxy-listener-address' }, listener.address)
      )
    ));
  }

  async function refreshProxyControlState() {
    const enabled = await StorageManager.isProxyModeEnabled();
    try {
      const state = await chrome.runtime.sendMessage({ type: 'GET_PROXY_SETTING_STATE' });
      if (!state || !state.ok) throw new Error(state?.error || '无法读取 Chrome 代理状态');
      renderProxyControlState(state, enabled);
    } catch (err) {
      proxyControlState.className = 'proxy-control-state blocked';
      proxyControlState.textContent = `代理状态未知: ${err.message}`;
    }
  }

  function renderProxyControlState(state, enabled) {
    if (enabled && state.controlledBySpikeDeck) {
      proxyControlState.className = 'proxy-control-state owned';
      proxyControlState.textContent = 'SpikeDeck 正在接管浏览器代理';
      return;
    }
    if (enabled && state.levelOfControl === 'controlled_by_other_extensions') {
      proxyControlState.className = 'proxy-control-state blocked';
      proxyControlState.textContent = '浏览器代理当前由其他扩展控制';
      return;
    }
    proxyControlState.className = 'proxy-control-state';
    proxyControlState.textContent = '未接管；其他代理扩展可控制浏览器';
  }

  /** Ingest member_info last_test_* fields into leafProbeResults map */
  function ingestPersistedMemberInfo(groups) {
    (groups || []).forEach((g) => {
      if (Array.isArray(g.member_info)) {
        g.member_info.forEach((info) => {
          if (info && info.name && typeof info.last_test_ok === 'boolean') {
            const existing = leafProbeResults.get(info.name);
            const newAt = info.last_test_at_unix_ms || 0;
            if (!existing || !existing.at || newAt >= existing.at) {
              leafProbeResults.set(info.name, {
                sourceMember: info.name,
                ms: info.last_test_ms ?? null,
                ok: info.last_test_ok === true,
                err: info.last_test_ok ? null : 'Timeout',
                at: newAt
              });
            }
          }
        });
      }
    });
  }

  function recordProbeResults(results, recordedAt = Date.now()) {
    (results || []).forEach((result) => {
      const existing = leafProbeResults.get(result.member);
      if (existing && existing.at && recordedAt < existing.at) return;
      leafProbeResults.set(result.member, {
        sourceMember: result.member,
        ms: result.latency_ms ?? null,
        ok: result.ok === true,
        err: result.error || (result.ok ? null : 'Timeout'),
        at: recordedAt
      });
    });
  }

  function setStatus(state, text) {
    statusDot.className = `status-dot ${state}`;
    statusText.textContent = text;
  }

  /**
   * Resolve latency information for any member (leaf node or sub-group).
   * Supports recursive lookup for nested policy groups.
   */
  function resolveMemberLatency(memberName, visited = new Set(), depth = 0) {
    // 1. Direct leaf node match
    const directResult = leafProbeResults.get(memberName);
    if (directResult) return directResult;

    if (depth >= 64) return null;

    // 2. Sub-group match
    const memberIdentity = memberName.toLocaleLowerCase();
    const subGroup = currentGroupsData.find(
      (g) => g.name.toLocaleLowerCase() === memberIdentity
    );
    if (!subGroup) return null;
    const groupIdentity = subGroup.name.toLocaleLowerCase();
    if (visited.has(groupIdentity)) return null;
    const nextVisited = new Set(visited);
    nextVisited.add(groupIdentity);

    // 2a. Check latency of current selected member of subGroup
    const selectedMember = subGroup.override_member || subGroup.selected || (subGroup.members && subGroup.members[0]);
    if (selectedMember && selectedMember.toLocaleLowerCase() !== memberIdentity) {
      const selectedRes = resolveMemberLatency(selectedMember, nextVisited, depth + 1);
      if (selectedRes) return selectedRes;
    }

    // 2b. Fallback to best (lowest RTT) member latency in subGroup
    let bestResult = null;
    (subGroup.members || []).forEach((child) => {
      if (child.toLocaleLowerCase() === memberIdentity) return;
      const res = resolveMemberLatency(child, nextVisited, depth + 1);
      if (res && res.ok && typeof res.ms === 'number') {
        if (!bestResult || !bestResult.ok || bestResult.ms === null || res.ms < bestResult.ms) {
          bestResult = res;
        }
      } else if (res && !bestResult) {
        bestResult = res;
      }
    });

    return bestResult;
  }

  // Render Policy Groups
  function renderGroups(groups) {
    const visibleGroups = (groups || []).filter((g) => showHiddenGroups || !g.hidden);

    if (visibleGroups.length === 0) {
      groupsContainer.replaceChildren(
        el('div', { className: 'empty-state' }, '暂无策略组')
      );
      return;
    }

    groupsContainer.replaceChildren();

    visibleGroups.forEach((group, idx) => {
      const isExpand = resolveInitialExpand(group, idx);

      const isOverridden = Boolean(group.override_member);
      const currentSelected = group.override_member || group.selected || (group.members && group.members[0]) || '-';

      // Chevron Icon SVG
      const svgIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svgIcon.setAttribute('class', 'expand-icon');
      svgIcon.setAttribute('viewBox', '0 0 24 24');
      svgIcon.setAttribute('fill', 'none');
      svgIcon.setAttribute('stroke', 'currentColor');
      svgIcon.setAttribute('stroke-width', '2');
      const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      polyline.setAttribute('points', '9 18 15 12 9 6');
      svgIcon.appendChild(polyline);

      const testBtn = el('button', { 
        className: 'btn-test-group',
        title: '测试该组延迟',
        dataset: { group: group.name },
        onClick: async (e) => {
          e.stopPropagation();
          await runTestGroup(group.name);
        }
      }, createFlashIcon(13));

      const selectedSummaryEl = el('span', {
        className: `current-selected${isOverridden ? ' pinned' : ''}`,
        title: isOverridden
          ? `已固定: ${currentSelected}（点击图钉可恢复自动选择）`
          : currentSelected
      }, currentSelected);

      // Clear pin/override for automatic groups (url-test / fallback / smart).
      const resumeAutoBtn = isOverridden
        ? el('button', {
            className: 'btn-resume-auto',
            title: '恢复自动选择',
            'aria-label': '恢复自动选择',
            dataset: { group: group.name },
            onClick: async (e) => {
              e.stopPropagation();
              await resumeAutomaticSelection(group.name);
            }
          }, createPinOffIcon(13))
        : null;

      const hiddenBadge = group.hidden
        ? el('span', {
            className: 'hidden-kind-badge',
            title: '隐藏组',
            'aria-label': '隐藏组'
          }, createEyeOffIcon(11))
        : null;

      const overrideBadge = isOverridden
        ? el('span', {
            className: 'override-kind-badge',
            title: '已手动固定节点',
            'aria-label': '已固定'
          }, createPinIcon(11))
        : null;

      const headerEl = el('div', { className: 'group-header' },
        el('div', { className: 'group-title-wrapper' },
          svgIcon,
          el('span', { className: 'group-name' }, group.name),
          el('span', { className: 'group-kind-badge' }, formatMemberType(group.kind || 'select')),
          overrideBadge,
          hiddenBadge
        ),
        el('div', { className: 'group-summary' },
          selectedSummaryEl,
          resumeAutoBtn,
          testBtn
        )
      );

      // Members List
      const membersContainer = el('div', {
        className: 'group-members'
      });

      const memberInfoMap = new Map();
      if (Array.isArray(group.member_info)) {
        group.member_info.forEach((info) => {
          if (info && info.name) memberInfoMap.set(info.name, info);
        });
      }

      (group.members || []).forEach((member) => {
        const isSelected = member === currentSelected;
        const isPinnedMember = isOverridden && member === group.override_member;
        const memberInfo = memberInfoMap.get(member);
        const subGroupTarget = currentGroupsData.find((g) => g.name === member);

        // Resolve latency for leaf node or sub-group
        const latencyInfo = resolveMemberLatency(member);

        const checkMark = el('span', { className: 'check-mark' }, isSelected ? '✓' : '');
        const memberNameEl = el('span', { className: 'member-name' }, member);

        // Type tag badge (product casing; nested groups use group kind)
        const typeLabel = subGroupTarget
          ? formatMemberType(subGroupTarget.kind || 'select')
          : memberTypeLabel(memberInfo);

        const typeTag = typeLabel
          ? el('span', { className: 'member-type-tag', title: typeLabel }, typeLabel)
          : null;

        const latencyBadge = el('span', {
          className: 'latency-badge',
          onClick: async (e) => {
            e.stopPropagation();
            await runTestGroup(group.name, member);
          }
        });
        applyLatencyBadge(latencyBadge, latencyInfo, { member });

        // On automatic groups, re-clicking the pinned member clears the override.
        const memberItem = el('div', {
          className: `member-item ${isSelected ? 'selected' : ''}${isPinnedMember ? ' pinned' : ''}`,
          dataset: { group: group.name, member: member },
          title: isPinnedMember ? '再次点击可恢复自动选择' : undefined,
          onClick: async () => {
            if (isPinnedMember) {
              await resumeAutomaticSelection(group.name);
              return;
            }
            await selectMember(group.name, member);
          }
        },
          el('div', { className: 'member-left' }, checkMark, memberNameEl, typeTag),
          el('div', { className: 'member-right' }, latencyBadge)
        );

        membersContainer.appendChild(memberItem);
      });

      const groupCard = el('div', {
        className: `group-card ${isExpand ? 'expanded' : ''}${isOverridden ? ' overridden' : ''}`,
        dataset: { group: group.name }
      }, headerEl, membersContainer);

      headerEl.addEventListener('click', (e) => {
        if (e.target.closest('.btn-test-group, .btn-resume-auto')) return;
        groupCard.classList.toggle('expanded');
        void persistGroupExpandState(group.name, groupCard.classList.contains('expanded'));
      });

      groupsContainer.appendChild(groupCard);
    });
  }

  /** Re-fetch groups so selected / override_member stay in sync with Spike. */
  async function refreshGroupsSelectionState() {
    const groupsData = await SpikeApiClient.getGroups(activeInstance);
    currentGroupsData = groupsData.groups || [];
    ingestPersistedMemberInfo(currentGroupsData);
    renderGroups(currentGroupsData);
    updateAllLatencyBadgesDOM();
  }

  // Select Member Action
  async function selectMember(groupName, memberName) {
    try {
      await SpikeApiClient.selectGroupMember(activeInstance, groupName, memberName);

      const group = currentGroupsData.find((g) => g.name === groupName);
      if (group) {
        group.selected = memberName;
        if (isAutomaticGroupKind(group.kind)) {
          group.override_member = memberName;
        }
      }

      try {
        await refreshGroupsSelectionState();
      } catch {
        // Fall back to optimistic local paint if re-fetch fails.
        const groupCard = document.querySelector(`.group-card[data-group="${CSS.escape(groupName)}"]`);
        if (groupCard) {
          const selectedSummary = groupCard.querySelector('.current-selected');
          if (selectedSummary) selectedSummary.textContent = memberName;

          const memberItems = groupCard.querySelectorAll('.member-item');
          memberItems.forEach((item) => {
            const isTarget = item.dataset.member === memberName;
            item.classList.toggle('selected', isTarget);
            const check = item.querySelector('.check-mark');
            if (check) check.textContent = isTarget ? '✓' : '';
          });
        }
        updateAllLatencyBadgesDOM();
      }
    } catch (err) {
      alert(`切换节点失败: ${err.message}`);
    }
  }

  /** Clear pin/override and resume url-test / fallback / smart automatic selection. */
  async function resumeAutomaticSelection(groupName) {
    try {
      await SpikeApiClient.clearGroupSelection(activeInstance, groupName);
      try {
        await refreshGroupsSelectionState();
      } catch (err) {
        // Still try to drop local override so the reverse affordance goes away.
        const group = currentGroupsData.find((g) => g.name === groupName);
        if (group) {
          group.override_member = null;
        }
        renderGroups(currentGroupsData);
        updateAllLatencyBadgesDOM();
        console.warn(`Cleared override but failed to refresh groups: ${err.message}`);
      }
    } catch (err) {
      alert(`恢复自动选择失败: ${err.message}`);
    }
  }

  // Latency Testing with visual feedback
  async function runTestGroup(groupName, targetMember = null) {
    const testBtn = document.querySelector(`.btn-test-group[data-group="${CSS.escape(groupName)}"]`);
    if (testBtn) testBtn.classList.add('testing');

    // Update target badges to "Testing..." spinner status immediately
    setGroupBadgesTesting(groupName, targetMember);

    let asyncTaskStarted = false;
    try {
      const result = await SpikeApiClient.startGroupTest(
        activeInstance,
        groupName,
        targetMember
      );
      if (result.mode === 'async') {
        asyncTaskStarted = true;
        activeGroupTests.set(result.task.id, {
          groupName,
          targetMember,
          completedMembers: new Set()
        });
        handleGroupTestTask(result.task);
        scheduleGroupTestPoll();
      } else {
        recordProbeResults(result.results);
        updateAllLatencyBadgesDOM();
      }
    } catch (err) {
      console.error(`Group test failed: ${err.message}`);
      // Mark as error if failed
      if (targetMember) {
        leafProbeResults.set(targetMember, { ok: false, err: 'Failed', at: Date.now() });
      }
      updateAllLatencyBadgesDOM();
    } finally {
      if (!asyncTaskStarted && testBtn) testBtn.classList.remove('testing');
    }
  }

  function setGroupBadgesTesting(groupName, targetMember = null) {
    const groupCard = document.querySelector(`.group-card[data-group="${CSS.escape(groupName)}"]`);
    if (!groupCard) return;

    const badges = groupCard.querySelectorAll('.latency-badge');
    badges.forEach((badge) => {
      const parentItem = badge.closest('.member-item');
      const member = parentItem ? parentItem.dataset.member : null;
      if (!targetMember || member === targetMember) {
        badge.className = 'latency-badge lat-testing';
        badge.replaceChildren(
          el('span', { className: 'mini-spinner' })
        );
      }
    });
  }

  async function runTestAll() {
    btnTestAll.disabled = true;
    btnTestAll.classList.add('testing');
    const labelSpan = btnTestAll.querySelector('.btn-label');
    if (labelSpan) labelSpan.textContent = '测速中...';

    // Mark all visible group badges as testing
    const allBadges = document.querySelectorAll('.latency-badge');
    allBadges.forEach((badge) => {
      badge.className = 'latency-badge lat-testing';
      badge.replaceChildren(
        el('span', { className: 'mini-spinner' })
      );
    });

    const groupCards = document.querySelectorAll('.group-card');
    const groupNames = Array.from(groupCards).map((card) => card.dataset.group);

    for (const gName of groupNames) {
      await runTestGroup(gName);
    }

    btnTestAll.disabled = false;
    btnTestAll.classList.remove('testing');
    if (labelSpan) labelSpan.textContent = '测速';
  }

  /** Update latency badges across all visible groups and members in DOM */
  function memberProbeIsPending(groupName, memberName, latencyInfo) {
    return Array.from(activeGroupTests.values()).some((task) => {
      if (task.groupName !== groupName) return false;
      if (task.targetMember && task.targetMember !== memberName) return false;
      if (task.completedMembers.has(memberName)) return false;
      return !latencyInfo?.sourceMember
        || !task.completedMembers.has(latencyInfo.sourceMember);
    });
  }

  function updateAllLatencyBadgesDOM() {
    groupsContainer.querySelectorAll('.member-item').forEach((memberItem) => {
      const groupName = memberItem.dataset.group;
      const member = memberItem.dataset.member;
      const badgeEl = memberItem.querySelector('.latency-badge');
      if (!groupName || !member || !badgeEl) return;

      const latData = resolveMemberLatency(member);
      const pending = memberProbeIsPending(groupName, member, latData);
      // Avoid rebuilding spinner DOM every poll tick while still testing.
      if (pending && badgeEl.classList.contains('lat-testing') && badgeEl.querySelector('.mini-spinner')) {
        return;
      }
      applyLatencyBadge(badgeEl, latData, { member, pending });
    });
  }

  /**
   * Paint a member latency badge: spinner / result text / empty (hover flash).
   */
  function applyLatencyBadge(badgeEl, latInfo, { member = '', pending = false } = {}) {
    if (pending) {
      badgeEl.className = 'latency-badge lat-testing';
      badgeEl.title = '正在测速...';
      badgeEl.replaceChildren(el('span', { className: 'mini-spinner' }));
      return;
    }

    const subGroupTarget = currentGroupsData.find((g) => g.name === member);
    if (hasLatencyResult(latInfo) && !latInfo.ok) {
      // Failure reason only in native tooltip; badge shows a red "F".
      badgeEl.title = latInfo.err || 'Timeout';
    } else if (subGroupTarget) {
      const subSel = subGroupTarget.override_member || subGroupTarget.selected;
      badgeEl.title = `子分组: ${member}${subSel ? ` (指向: ${subSel})` : ''} - 点击测试`;
    } else if (hasLatencyResult(latInfo) && latInfo.at) {
      badgeEl.title = `测试时间: ${new Date(latInfo.at).toLocaleTimeString()} - 点击重新测试`;
    } else {
      badgeEl.title = '点击单独测试该节点';
    }

    if (!hasLatencyResult(latInfo)) {
      badgeEl.className = 'latency-badge lat-empty';
      if (!badgeEl.querySelector('.flash-icon')) {
        badgeEl.replaceChildren(createFlashIcon(13));
      }
      return;
    }

    badgeEl.className = `latency-badge ${getLatencyClass(latInfo)}`;
    badgeEl.textContent = formatLatencyText(latInfo);
  }

  function getLatencyClass(latInfo) {
    if (!latInfo) return 'lat-empty';
    if (!latInfo.ok) return 'lat-error';
    if (typeof latInfo.ms !== 'number') return 'lat-error';
    if (latInfo.ms < 120) return 'lat-fast';
    if (latInfo.ms < 300) return 'lat-medium';
    return 'lat-slow';
  }

  function formatLatencyText(latInfo) {
    if (!hasLatencyResult(latInfo)) return '';
    if (!latInfo.ok) return 'F';
    if (typeof latInfo.ms === 'number') return `${latInfo.ms}ms`;
    return '';
  }

  // Initial load
  void syncProviderRefreshTask();
  loadDashboard();
});
