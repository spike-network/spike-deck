const GROUP_SELECTION_BASIS_LABELS = Object.freeze({
  manual_override: "手动选择",
  configured_default: "配置默认",
  first_usable_member: "首个可用",
  network_condition: "网络条件",
  first_available_member: "首个健康",
  retry_first_member: "顺序重试",
  url_test_winner: "测速最优",
  last_smart_selection: "智能选择",
  per_connection_preview: "逐连接选择",
  empty_group_substitute: "空组替代",
  cycle_substitute: "循环阻断",
  unavailable: "无可用成员",
});

export function groupSelectionBasisLabel(basis) {
  return GROUP_SELECTION_BASIS_LABELS[String(basis || "")] || "";
}
