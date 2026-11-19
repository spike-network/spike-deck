import { getCurrentLanguage, MESSAGE_CATALOGS } from "./i18n.js";

const keys = Object.freeze({
  "network_unavailable": "core.networkUnavailable",
  "provider_refresh_disabled": "core.providerRefreshDisabled",
  "provider_refresh_not_found": "core.providerRefreshNotFound",
  "provider_refresh_task_not_found": "core.providerRefreshTaskNotFound",
  "provider_refresh.incomplete": "core.providerRefresh.incomplete",
  "profile.document_too_large": "core.profile.documentTooLarge",
  "profile.content_outside_section": "core.profile.contentOutsideSection",
  "profile.include_outside_section": "core.profile.includeOutsideSection",
  "profile.include_not_found": "core.profile.includeNotFound",
  "profile.include_cycle": "core.profile.includeCycle",
  "profile.include_escapes_base": "core.profile.includeEscapesBase",
  "profile.include_depth_exceeded": "core.profile.includeDepthExceeded",
  "profile.remote_include_unavailable": "core.profile.remoteIncludeUnavailable",
  "profile.section_line_invalid": "core.profile.sectionLineInvalid",
  "profile.section_key_unknown": "core.profile.sectionKeyUnknown",
  "profile.section_key_duplicate": "core.profile.sectionKeyDuplicate",
  "profile.section_value_invalid": "core.profile.sectionValueInvalid",
  "profile.device_duplicate": "core.profile.deviceDuplicate",
  "profile.device_mac_invalid": "core.profile.deviceMacInvalid",
  "profile.proxy_invalid": "core.profile.proxyInvalid",
  "profile.group_invalid": "core.profile.groupInvalid",
  "profile.group_member_unavailable": "core.profile.groupMemberUnavailable",
  "profile.smart_group_member_unknown": "core.profile.smartGroupMemberUnknown",
  "profile.smart_group_in_auto_group": "core.profile.smartGroupInAutoGroup",
  "profile.include_other_group_unknown": "core.profile.includeOtherGroupUnknown",
  "profile.include_other_group_cycle": "core.profile.includeOtherGroupCycle",
  "profile.underlying_proxy_cycle": "core.profile.underlyingProxyCycle",
  "profile.policy_path_failed": "core.profile.policyPathFailed",
  "profile.rule_policy_unavailable": "core.profile.rulePolicyUnavailable",
  "profile.rule_script_unavailable": "core.profile.ruleScriptUnavailable",
  "profile.ruleset_load_failed": "core.profile.rulesetLoadFailed",
  "profile.ruleset_unfetched": "core.profile.rulesetUnfetched",
  "profile.ruleset_invalid": "core.profile.rulesetInvalid",
  "editor.document_invalid": "core.editor.documentInvalid",
  "net.timeout": "core.net.timeout",
  "net.connection_refused": "core.net.connectionRefused",
  "net.connection_reset": "core.net.connectionReset",
  "net.dns_failed": "core.net.dnsFailed",
  "net.tls_failed": "core.net.tlsFailed",
  "net.auth_failed": "core.net.authFailed",
  "net.udp_unsupported": "core.net.udpUnsupported",
  "policy.tailscale_private_only": "core.policy.tailscalePrivateOnly",
  "policy.wireguard_private_only": "core.policy.wireguardPrivateOnly",
});

const detailCodes = new Set(["profile.proxy_invalid", "profile.group_invalid", "profile.ruleset_load_failed"]);

export function coreError(code, args, english, language = getCurrentLanguage()) {
  if (!Object.hasOwn(keys, code)) return english;
  const template = MESSAGE_CATALOGS[language]?.[keys[code]];
  if (!template || (language === "en" && english)) return english;
  let missing = false;
  const text = template.replace(/\{([a-z0-9_]+)\}/g, (_, name) => {
    if (args && Object.hasOwn(args, name) && typeof args[name] === "string") return args[name];
    missing = true;
    return "";
  });
  if (missing) return english;
  return detailCodes.has(code) && english ? `${text} (${english})` : text;
}

export function statusError(record, field = "error") {
  return coreError(record?.[`${field}_code`], record?.[`${field}_args`], record?.[field]);
}

export function requestErrorText(error) {
  return coreError(error?.code, error?.args, error?.coreMessage ?? error?.error ?? error?.message);
}

// Send the structured fields separately from the user-visible text.
export function errorDetails(error) {
  return typeof error?.code === "string" ? { code: error.code, args: error.args } : {};
}

export async function decodeResponseError(response) {
  let body;
  try { body = await response.json(); } catch { /* The gateway may send a non-JSON error. */ }
  const coreMessage = typeof body?.error === "string" ? body.error : undefined;
  const message = response.status === 401 ? "Authentication failed (Secret incorrect)" :
    `Spike API error: ${coreMessage ?? `HTTP ${response.status}`}`;
  return Object.assign(new Error(message), {
    status: response.status,
    coreMessage,
    code: typeof body?.code === "string" ? body.code : undefined,
    args: body?.args,
  });
}
