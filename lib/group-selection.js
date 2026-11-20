import { msg } from "./i18n.js";

const rejectPolicies = new Set([
  "REJECT", "REJECT-UNSUPPORTED-UDP", "REJECT-DROP", "REJECT-NO-DROP", "REJECT-TINYGIF",
  "REJECT-IMG", "REJECT-DICT", "REJECT-ARRAY", "REJECT-VIDEO", "REJECT-NOVIDEO",
]);

export const isRejectPolicy = (name) => rejectPolicies.has(name);

const GROUP_SELECTION_BASIS_LABEL_KEYS = Object.freeze({
  manual_override: "popup.manual2",
  configured_default: "popup.configuredDefault",
  first_usable_member: "popup.firstUsable",
  network_condition: "popup.networkCondition",
  first_available_member: "popup.firstAvailable",
  retry_first_member: "popup.retryOrder",
  url_test_winner: "popup.latencyWinner",
  last_smart_selection: "popup.smartChoice",
  per_connection_preview: "popup.perConnection",
  empty_group_substitute: "popup.emptySubstitute",
  cycle_substitute: "popup.cycleBlocked",
  unavailable: "popup.unavailable",
});

export function groupSelectionBasisLabel(basis) {
  const key = GROUP_SELECTION_BASIS_LABEL_KEYS[String(basis || "")];
  return key ? msg(key) : "";
}

export function isAutomaticGroupKind(kind) {
  return ["url-test", "fallback", "load-balance", "smart", "subnet"].includes(String(kind || "").toLowerCase());
}

export function groupMemberAction(group, member) {
  const kind = String(group?.kind || "").toLowerCase();
  if (!["select", "other", "url-test", "fallback", "load-balance", "smart", "subnet"].includes(kind)) return "none";
  if (isAutomaticGroupKind(kind) && group?.override_member === member) return "auto";
  if (!isAutomaticGroupKind(kind) && group?.selected === member) return "none";
  return "select";
}

/**
 * Avoidance state of a member in groups whose automatic choice honors the
 * core's avoidance set; null where avoiding has no effect.
 */
export function groupMemberAvoidance(group, info) {
  const kind = String(group?.kind || "").toLowerCase();
  if (!["url-test", "fallback", "load-balance", "smart"].includes(kind)) return null;
  return { avoided: info?.avoided === true };
}

export function shouldCollapseGroupAfterSelection(enabled, event) {
  return Boolean(enabled) && !Boolean(event?.altKey);
}

export function isDirectGroupProbeResult(group, result) {
  if (result.paths === undefined) return true;
  return Array.isArray(result.paths) && result.paths.some(
    (path) => Array.isArray(path) && path.length === 2 && path[0] === group && path[1] === result.member,
  );
}

export function splitSelectedSummary(label) {
  const parts = String(label || "").trim().split(/\s+/);
  if (parts.length <= 2) return { leading: parts.join(" "), trailing: "" };
  return {
    leading: parts.slice(0, -2).join(" "),
    trailing: parts.slice(-2).join(" "),
  };
}
