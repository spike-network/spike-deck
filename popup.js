import { StorageManager } from './lib/storage.js';
import { SpikeApiClient } from './lib/spike-client.js';

// Global latency cache for leaf nodes by member name
// key: memberName, value: { ms: number | null, ok: boolean, err?: string, at?: number }
const leafProbeResults = new Map();
let currentGroupsData = [];
const terminalGroupTestStatuses = new Set(['completed', 'cancelled', 'failed']);

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
  const btnToggleHidden = document.getElementById('btn-toggle-hidden');

  let showHiddenGroups = await StorageManager.getShowHiddenGroups();
  let groupExpandMode = await StorageManager.getGroupExpandMode();
  const activeGroupTests = new Map();
  let groupTestPollTimer = null;
  updateHiddenToggleUI();

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

  function updateHiddenToggleUI() {
    if (showHiddenGroups) {
      btnToggleHidden.classList.add('active');
    } else {
      btnToggleHidden.classList.remove('active');
    }
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

  toggleProxy.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    await StorageManager.setProxyModeEnabled(enabled);
    chrome.runtime.sendMessage({ type: 'UPDATE_PROXY_SETTING' });
  });

  // Instance selector change handler
  instanceSelect.addEventListener('change', async (e) => {
    const selectedId = e.target.value;
    await StorageManager.setActiveInstanceId(selectedId);
    resetGroupTestTracking();
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
      let isExpand = false;
      if (groupExpandMode === 'expand-all') {
        isExpand = true;
      } else if (groupExpandMode === 'collapse-all') {
        isExpand = false;
      } else {
        isExpand = idx < 2 || group.kind === 'select';
      }

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
        dataset: { group: group.name },
        onClick: async (e) => {
          e.stopPropagation();
          await runTestGroup(group.name);
        }
      }, flashIcon);

      const selectedSummaryEl = el('span', {
        className: 'current-selected'
      }, currentSelected);

      const hiddenBadge = group.hidden
        ? el('span', { className: 'hidden-kind-badge' }, 'hidden')
        : null;

      const headerEl = el('div', { className: 'group-header' },
        el('div', { className: 'group-title-wrapper' },
          svgIcon,
          el('span', { className: 'group-name' }, group.name),
          el('span', { className: 'group-kind-badge' }, group.kind || 'select'),
          hiddenBadge
        ),
        el('div', { className: 'group-summary' },
          selectedSummaryEl,
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
        const memberInfo = memberInfoMap.get(member);
        const subGroupTarget = currentGroupsData.find((g) => g.name === member);

        // Resolve latency for leaf node or sub-group
        const latencyInfo = resolveMemberLatency(member);

        const checkMark = el('span', { className: 'check-mark' }, isSelected ? '✓' : '');
        const memberNameEl = el('span', { className: 'member-name' }, member);

        // Type tag badge
        let typeLabel = memberInfo && memberInfo.type ? memberInfo.type : '';
        if (subGroupTarget) {
          typeLabel = subGroupTarget.kind || 'select';
        }

        const typeTag = typeLabel
          ? el('span', { className: 'member-type-tag' }, typeLabel)
          : null;

        let titleText = '点击单独测试该节点';
        if (subGroupTarget) {
          const subSel = subGroupTarget.override_member || subGroupTarget.selected;
          titleText = `子分组: ${member}${subSel ? ` (指向: ${subSel})` : ''} - 点击测试`;
        } else if (latencyInfo && latencyInfo.at) {
          titleText = `测试时间: ${new Date(latencyInfo.at).toLocaleTimeString()} - 点击重新测试`;
        }

        const latencyBadge = el('span', {
          className: `latency-badge ${getLatencyClass(latencyInfo)}`,
          title: titleText,
          onClick: async (e) => {
            e.stopPropagation();
            await runTestGroup(group.name, member);
          }
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

      // Refresh latency display for sub-groups after selection change
      updateAllLatencyBadgesDOM();
    } catch (err) {
      alert(`切换节点失败: ${err.message}`);
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
      if (memberProbeIsPending(groupName, member, latData)) {
        badgeEl.className = 'latency-badge lat-testing';
        if (!badgeEl.querySelector('.mini-spinner')) {
          badgeEl.replaceChildren(el('span', { className: 'mini-spinner' }));
        }
        return;
      }
      badgeEl.className = `latency-badge ${getLatencyClass(latData)}`;
      badgeEl.textContent = formatLatencyText(latData);

      const subGroupTarget = currentGroupsData.find((g) => g.name === member);
      if (subGroupTarget) {
        const subSel = subGroupTarget.override_member || subGroupTarget.selected;
        badgeEl.title = `子分组: ${member}${subSel ? ` (指向: ${subSel})` : ''} - 点击测试`;
      } else if (latData && latData.at) {
        badgeEl.title = `测试时间: ${new Date(latData.at).toLocaleTimeString()} - 点击重新测试`;
      } else {
        badgeEl.title = '点击单独测试该节点';
      }
    });
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

  // Initial load
  loadDashboard();
});
