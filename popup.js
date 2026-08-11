import { StorageManager } from './lib/storage.js';
import { SpikeApiClient } from './lib/spike-client.js';

// Local latency test cache to retain ping values during runtime session
const latencyMap = new Map(); // key: `${groupName}:${memberName}`, value: { ms, ok, err, at }

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
  const groupsContainer = document.getElementById('groups-container');

  const btnTestAll = document.getElementById('btn-test-all');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnOptions = document.getElementById('btn-options');
  const toggleProxy = document.getElementById('toggle-chrome-proxy');

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

  toggleProxy.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    await StorageManager.setProxyModeEnabled(enabled);
    chrome.runtime.sendMessage({ type: 'UPDATE_PROXY_SETTING' });
  });

  // Instance selector change handler
  instanceSelect.addEventListener('change', async (e) => {
    const selectedId = e.target.value;
    await StorageManager.setActiveInstanceId(selectedId);
    activeInstance = await StorageManager.getActiveInstance();
    chrome.runtime.sendMessage({ type: 'UPDATE_PROXY_SETTING' });
    loadDashboard();
  });

  btnRefresh.addEventListener('click', () => {
    loadDashboard();
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

      renderGroups(groupsData.groups || []);
    } catch (err) {
      setStatus('offline', '未连接');
      profileName.textContent = '-';
      badgeGroups.textContent = '组: -';
      badgeNodes.textContent = '节点: -';
      badgeRules.textContent = '规则: -';

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

  function setStatus(state, text) {
    statusDot.className = `status-dot ${state}`;
    statusText.textContent = text;
  }

  // Render Policy Groups
  function renderGroups(groups) {
    const visibleGroups = (groups || []).filter((g) => !g.hidden);

    if (visibleGroups.length === 0) {
      groupsContainer.replaceChildren(
        el('div', { className: 'empty-state' }, '暂无策略组')
      );
      return;
    }

    groupsContainer.replaceChildren();

    visibleGroups.forEach((group, idx) => {
      const isExpand = idx < 2 || group.kind === 'select';
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

      // Flash Test Icon SVG
      const flashIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      flashIcon.setAttribute('viewBox', '0 0 24 24');
      flashIcon.setAttribute('width', '13');
      flashIcon.setAttribute('height', '13');
      flashIcon.setAttribute('stroke', 'currentColor');
      flashIcon.setAttribute('stroke-width', '2');
      flashIcon.setAttribute('fill', 'none');
      const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      polygon.setAttribute('points', '13 2 3 14 12 14 11 22 21 10 12 10 13 2');
      flashIcon.appendChild(polygon);

      const testBtn = el('button', { 
        className: 'btn-test-group',
        title: '测试该组延迟',
        onClick: async (e) => {
          e.stopPropagation();
          await runTestGroup(group.name);
        }
      }, flashIcon);

      const selectedSummaryEl = el('span', { 
        className: 'current-selected',
        id: `selected-${cssSafe(group.name)}`
      }, currentSelected);

      const headerEl = el('div', { className: 'group-header' },
        el('div', { className: 'group-title-wrapper' },
          svgIcon,
          el('span', { className: 'group-name' }, group.name),
          el('span', { className: 'group-kind-badge' }, group.kind || 'select')
        ),
        el('div', { className: 'group-summary' },
          selectedSummaryEl,
          testBtn
        )
      );

      // Members List
      const membersContainer = el('div', { 
        className: 'group-members',
        id: `members-${cssSafe(group.name)}`
      });

      // Build member_info map if available from Spike API commit 5008853
      const memberInfoMap = new Map();
      if (Array.isArray(group.member_info)) {
        group.member_info.forEach((info) => {
          if (info && info.name) memberInfoMap.set(info.name, info);
        });
      }

      (group.members || []).forEach((member) => {
        const isSelected = member === currentSelected;
        const memberInfo = memberInfoMap.get(member);

        // Extract persisted latency from Spike 5008853 member_info
        let persistedTest = null;
        if (memberInfo && typeof memberInfo.last_test_ok === 'boolean') {
          persistedTest = {
            ms: memberInfo.last_test_ms,
            ok: memberInfo.last_test_ok,
            at: memberInfo.last_test_at_unix_ms,
            err: memberInfo.last_test_ok ? null : 'Timeout'
          };
        }

        // Prefer local trigger test result, fallback to Spike persisted probe result
        const latencyInfo = latencyMap.get(`${group.name}:${member}`) || persistedTest;

        const checkMark = el('span', { className: 'check-mark' }, isSelected ? '✓' : '');
        const memberNameEl = el('span', { className: 'member-name' }, member);

        // Display node protocol type badge if available (e.g. shadowsocks, trojan, etc.)
        const typeTag = memberInfo && memberInfo.type
          ? el('span', { className: 'member-type-tag' }, memberInfo.type)
          : null;

        const titleText = latencyInfo && latencyInfo.at 
          ? `上次测试时间: ${new Date(latencyInfo.at).toLocaleTimeString()}`
          : '点击测试该节点';

        const latencyBadge = el('span', {
          className: `latency-badge ${getLatencyClass(latencyInfo)}`,
          id: `lat-${cssSafe(group.name)}-${cssSafe(member)}`,
          title: titleText
        }, formatLatencyText(latencyInfo));

        const memberItem = el('div', {
          className: `member-item ${isSelected ? 'selected' : ''}`,
          dataset: { group: group.name, member: member },
          onClick: async () => {
            await selectMember(group.name, member);
          }
        },
          el('div', { className: 'member-left' }, checkMark, memberNameEl, typeTag),
          el('div', { className: 'member-right' }, latencyBadge)
        );

        membersContainer.appendChild(memberItem);
      });

      const groupCard = el('div', {
        className: `group-card ${isExpand ? 'expanded' : ''}`,
        dataset: { group: group.name }
      }, headerEl, membersContainer);

      headerEl.addEventListener('click', (e) => {
        if (e.target.closest('.btn-test-group')) return;
        groupCard.classList.toggle('expanded');
      });

      groupsContainer.appendChild(groupCard);
    });
  }

  // Select Member Action
  async function selectMember(groupName, memberName) {
    try {
      await SpikeApiClient.selectGroupMember(activeInstance, groupName, memberName);

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
    } catch (err) {
      alert(`切换节点失败: ${err.message}`);
    }
  }

  // Latency Testing
  async function runTestGroup(groupName) {
    const testBtn = document.querySelector(`.btn-test-group[data-group="${CSS.escape(groupName)}"]`);
    if (testBtn) testBtn.style.opacity = '0.4';

    try {
      const res = await SpikeApiClient.testGroup(activeInstance, groupName);
      if (res && res.results) {
        const nowMs = Date.now();
        res.results.forEach((r) => {
          const key = `${groupName}:${r.member}`;
          const latData = { ms: r.latency_ms, ok: r.ok, err: r.error, at: nowMs };
          latencyMap.set(key, latData);
          updateLatencyBadgeDOM(groupName, r.member, latData);
        });
      }
    } catch (err) {
      console.error(`Group test failed: ${err.message}`);
    } finally {
      if (testBtn) testBtn.style.opacity = '1';
    }
  }

  async function runTestAll() {
    btnTestAll.disabled = true;
    btnTestAll.style.opacity = '0.6';

    const groupCards = document.querySelectorAll('.group-card');
    const groupNames = Array.from(groupCards).map((card) => card.dataset.group);

    for (const gName of groupNames) {
      await runTestGroup(gName);
    }

    btnTestAll.disabled = false;
    btnTestAll.style.opacity = '1';
  }

  function updateLatencyBadgeDOM(groupName, memberName, latData) {
    const badgeEl = document.getElementById(`lat-${cssSafe(groupName)}-${cssSafe(memberName)}`);
    if (badgeEl) {
      badgeEl.className = `latency-badge ${getLatencyClass(latData)}`;
      badgeEl.textContent = formatLatencyText(latData);
      if (latData && latData.at) {
        badgeEl.title = `测试时间: ${new Date(latData.at).toLocaleTimeString()}`;
      }
    }
  }

  function getLatencyClass(latInfo) {
    if (!latInfo) return '';
    if (!latInfo.ok) return 'lat-error';
    if (typeof latInfo.ms !== 'number') return 'lat-error';
    if (latInfo.ms < 120) return 'lat-fast';
    if (latInfo.ms < 300) return 'lat-medium';
    return 'lat-slow';
  }

  function formatLatencyText(latInfo) {
    if (!latInfo) return '—';
    if (!latInfo.ok) return latInfo.err || 'Timeout';
    if (typeof latInfo.ms === 'number') return `${latInfo.ms}ms`;
    return '—';
  }

  function cssSafe(str) {
    return (str || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  // Initial load
  loadDashboard();
});
