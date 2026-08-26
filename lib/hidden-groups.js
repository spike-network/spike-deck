/**
 * Hidden policy-group visibility: hide | smart | show.
 *
 * smart: a hidden group is listed when a currently visible group selects it
 * (override_member or selected). Newly listed groups count as visible, so the
 * current selection chain is followed.
 */

export const HIDDEN_GROUPS_MODES = ['hide', 'smart', 'show'];
export const DEFAULT_HIDDEN_GROUPS_MODE = 'hide';

const MODE_LABELS = {
  hide: {
    title: '隐藏组已隐藏 · 点击切换为智能展示',
    aria: '隐藏组展示：已隐藏'
  },
  smart: {
    title: '智能展示被选中的隐藏组 · 点击切换为全部展示',
    aria: '隐藏组展示：智能'
  },
  show: {
    title: '已显示全部隐藏组 · 点击切换为隐藏',
    aria: '隐藏组展示：全部展示'
  }
};

export function normalizeHiddenGroupsMode(mode, legacyShowHiddenGroups) {
  if (HIDDEN_GROUPS_MODES.includes(mode)) return mode;
  if (legacyShowHiddenGroups === true) return 'show';
  return DEFAULT_HIDDEN_GROUPS_MODE;
}

export function nextHiddenGroupsMode(mode) {
  const current = normalizeHiddenGroupsMode(mode);
  const index = HIDDEN_GROUPS_MODES.indexOf(current);
  return HIDDEN_GROUPS_MODES[(index + 1) % HIDDEN_GROUPS_MODES.length];
}

export function hiddenGroupsModeLabel(mode) {
  return MODE_LABELS[normalizeHiddenGroupsMode(mode)];
}

export function selectedGroupMember(group) {
  const override = String(group?.override_member || '').trim();
  if (override) return override;
  return String(group?.selected || '').trim();
}

export function visiblePolicyGroups(groups, mode) {
  const list = Array.isArray(groups) ? groups.filter((group) => group && group.name) : [];
  const normalized = normalizeHiddenGroupsMode(mode);
  if (normalized === 'show') return list.slice();

  const byName = new Map(list.map((group) => [group.name, group]));
  const visible = new Set();
  for (const group of list) {
    if (!group.hidden) visible.add(group.name);
  }

  if (normalized === 'smart') {
    const queue = [...visible];
    while (queue.length) {
      const current = byName.get(queue.pop());
      const selected = selectedGroupMember(current);
      if (!selected) continue;
      const child = byName.get(selected);
      if (!child?.hidden || visible.has(child.name)) continue;
      visible.add(child.name);
      queue.push(child.name);
    }
  }

  return list.filter((group) => visible.has(group.name));
}
