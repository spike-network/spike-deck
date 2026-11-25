import { coreError, requestErrorText, statusError } from "./lib/core-error.js";
import { StorageManager } from "./lib/storage.js";
import { SpikeApiClient } from "./lib/spike-client.js";
import { activeTabTarget, summarizeCurrentSite } from "./lib/current-site.js";
import { ensureHostPermission } from "./lib/permissions.js";
import { proxyListenerSummary, proxyListenersFromStatus } from "./lib/proxy-listeners.js";
import { formatByteCount, formatRate, formatCompactByteCount } from "./lib/format-rate.js";
import {
  hiddenGroupsModeLabel,
  nextHiddenGroupsMode,
  visiblePolicyGroups,
} from "./lib/hidden-groups.js";
import { initializeI18n, msg, onLanguageChange } from "./lib/i18n.js";
import { GROUP_TEST_TERMINAL_STATUSES, OUTBOUND_MODES } from "./lib/control-api-contract.js";
import { GroupBatchControls } from "./lib/group-batch-controls.js";
import {
  ingestPersistedMemberInfo,
  probeResultKey,
  recordProbeResults,
} from "./lib/probe-results.js";
import { installPopupInteractions } from "./lib/popup-interactions.js";
import {
  groupMemberAction,
  groupMemberAvoidance,
  isDirectGroupProbeResult,
  shouldCollapseGroupAfterSelection,
  splitSelectedSummary,
} from "./lib/group-selection.js";
import {
  providerRefreshState,
  observeProviderActivations,
  providerTaskProgress,
  summarizeProviderRefreshError,
} from "./lib/provider-refresh-view.js";

// Group/member-scoped current health; task samples only fill legacy metadata gaps.
const leafProbeResults = new Map();
let currentGroupsData = [];
const terminalGroupTestStatuses = new Set(GROUP_TEST_TERMINAL_STATUSES);
const cancellingGroupTests = new Map();
const submittingGroupTests = new Map();
const groupTestTaskVersions = new Map();
let groupTestEpoch = 0;
let groupReadSequence = 0;
let probeSnapshotRefresh = null;
let probeSnapshotsDirty = false;

/** Display labels for protocol / nested-group kinds (product typography, not raw slugs). */
function formatMemberType(type) {
  switch (String(type || "").toLowerCase()) {
    case "shadowsocks":
    case "ss":
      return "SS";
    case "trojan":
      return "Trojan";
    case "snell":
      return "Snell";
    case "vmess":
      return "VMess";
    case "http":
      return "HTTP";
    case "https":
      return "HTTPS";
    case "socks5":
      return "SOCKS5";
    case "socks5-tls":
      return "SOCKS5-TLS";
    case "hysteria2":
      return "Hysteria2";
    case "tuic":
    case "tuic-v5":
      return "TUIC";
    case "anytls":
      return "AnyTLS";
    case "h2-connect":
      return "H2";
    case "ssh":
      return "SSH";
    case "wireguard":
      return "WireGuard";
    case "tailscale":
      return "Tailscale";
    case "external":
      return "External";
    case "tcp":
      return "TCP";
    case "udp":
      return "UDP";
    case "direct":
      return "DIRECT";
    case "reject":
      return "REJECT";
    case "select":
      return "Select";
    case "url-test":
    case "urltest":
    case "url":
      return "URL-Test";
    case "fallback":
      return "Fallback";
    case "load-balance":
    case "loadbalance":
      return "Load-Balance";
    case "smart":
      return "Smart";
    case "other":
      return "Other";
    case "unknown":
      return "Unknown";
    default:
      return titleCaseType(type);
  }
}

/** Title-case unknown hyphenated type slugs (`foo_bar` → `Foo-Bar`). */
function titleCaseType(type) {
  return String(type || "")
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("-");
}

function memberTypeLabel(info, fallbackType = "") {
  const raw = (info && info.type) || fallbackType;
  if (!raw) return "";
  const type = formatMemberType(raw);
  return info && info.udp ? `${type}/UDP` : type;
}

/** Helper to create DOM elements cleanly without innerHTML */
function el(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.substring(2).toLowerCase(), value);
    } else if (key === "className") {
      element.className = value;
    } else if (key === "dataset" && typeof value === "object") {
      for (const [dKey, dVal] of Object.entries(value)) {
        element.dataset[dKey] = dVal;
      }
    } else if (key === "style" && typeof value === "object") {
      Object.assign(element.style, value);
    } else if (value !== false && value !== null && value !== undefined) {
      element.setAttribute(key, value);
    }
  }

  for (const child of children) {
    if (typeof child === "string" || typeof child === "number") {
      element.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      element.appendChild(child);
    }
  }
  return element;
}

const toastHost = document.body.appendChild(
  el("div", { className: "toast-host", role: "status", "aria-live": "polite" }),
);

function showToast(message, kind = "", timeoutMs = 2600) {
  const toast = el("div", { className: `toast ${kind}`.trim() }, message);
  toastHost.appendChild(toast);
  while (toastHost.children.length > 3) {
    toastHost.firstChild.remove();
  }
  setTimeout(() => {
    toast.classList.add("hide");
    setTimeout(() => toast.remove(), 220);
  }, timeoutMs);
}

function attachKeyboardActivate(element, handler) {
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handler(event);
    }
  });
}

/** Lightning bolt icon used by group test button and empty-node probe affordance. */
function createFlashIcon(size = 13) {
  const flashIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  flashIcon.setAttribute("viewBox", "0 0 24 24");
  flashIcon.setAttribute("width", String(size));
  flashIcon.setAttribute("height", String(size));
  flashIcon.setAttribute("stroke", "currentColor");
  flashIcon.setAttribute("stroke-width", "2");
  flashIcon.setAttribute("fill", "none");
  flashIcon.setAttribute("class", "flash-icon");
  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  polygon.setAttribute("points", "13 2 3 14 12 14 11 22 21 10 12 10 13 2");
  flashIcon.appendChild(polygon);
  return flashIcon;
}

/** Open-eye icon: all hidden groups are listed. */
function createEyeIcon(size = 14) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z");
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "3");
  svg.append(path, circle);
  return svg;
}

/** Sparkles icon: smart mode lists hidden groups on the current selection chain. */
function createSparklesIcon(size = 14) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const paths = [
    "m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z",
    "M5 3v4",
    "M19 17v4",
    "M3 5h4",
    "M17 19h4",
  ];
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/** Closed-eye icon for hidden policy groups (compact badge, not the word "hidden"). */
function createEyeOffIcon(size = 11) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("fill", "none");
  svg.setAttribute("class", "eye-off-icon");
  svg.setAttribute("aria-hidden", "true");

  const paths = [
    "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94",
    "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19",
    "M14.12 14.12a3 3 0 1 1-4.24-4.24",
    "M1 1l22 22",
  ];
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/** Whether a group kind supports manual pin/override of automatic selection. */
function isAutomaticGroupKind(kind) {
  switch (String(kind || "").toLowerCase()) {
    case "url-test":
    case "urltest":
    case "url":
    case "fallback":
    case "smart":
      return true;
    default:
      return false;
  }
}

/** Whether a probe result exists (success or failure), vs never tested. */
function hasLatencyResult(latInfo) {
  if (!latInfo) return false;
  if (typeof latInfo.ok === "boolean") return true;
  if (typeof latInfo.ms === "number") return true;
  return false;
}

document.addEventListener("DOMContentLoaded", async () => {
  await initializeI18n();
  // Text built in script is not re-translated in place; a language switch made
  // on another page reloads the popup so every label is rendered again.
  onLanguageChange(() => window.location.reload());
  await StorageManager.init();
  const instances = await StorageManager.getInstances();
  let activeInstance = await StorageManager.getActiveInstance();
  let instanceGeneration = 0;
  let instanceSelectionWrite = Promise.resolve();
  let profileSwitchOperation = null;
  const disconnectAffectedConnectionsOnSelection =
    await StorageManager.shouldDisconnectAffectedConnectionsOnSelection();
  const popupInteractions = installPopupInteractions({
    getInstanceId: () => activeInstance?.id || null,
    shouldDisconnectAffectedConnections: () =>
      disconnectAffectedConnectionsOnSelection,
  });

  const instanceSelect = document.getElementById("instance-select");
  const btnQuickInstance = document.getElementById("btn-quick-instance");
  const btnQuickOutbound = document.getElementById("btn-quick-outbound");
  const btnQuickProfile = document.getElementById("btn-quick-profile");
  const quickInstanceValue = document.getElementById("quick-instance-value");
  const quickOutboundValue = document.getElementById("quick-outbound-value");
  const quickProfileValue = document.getElementById("quick-profile-value");
  const quickPanelInstance = document.getElementById("quick-panel-instance");
  const quickPanelProfile = document.getElementById("quick-panel-profile");
  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const profileName = document.getElementById("profile-name");
  const badgeGroups = document.getElementById("badge-groups");
  const badgeNodes = document.getElementById("badge-nodes");
  const badgeRules = document.getElementById("badge-rules");
  const trafficDown = document.getElementById("traffic-down");
  const trafficUp = document.getElementById("traffic-up");
  const trafficTotal = document.getElementById("traffic-total");
  const proxyListeners = document.getElementById("proxy-listeners");
  const proxyControlState = document.getElementById("proxy-control-state");
  const groupsContainer = document.getElementById("groups-container");
  const appContainer = document.querySelector(".container");
  const outboundModeCard = document.getElementById("outbound-mode-card");
  const outboundModeState = document.getElementById("outbound-mode-state");
  const outboundPolicySelect = document.getElementById("outbound-policy-select");
  const outboundModeButtons = Array.from(document.querySelectorAll(".btn-outbound-mode"));

  const managedBadge = document.getElementById("managed-badge");
  const badgeDnsDelay = document.getElementById("badge-dns-delay");
  const profileSelect = document.getElementById("profile-select");
  const btnProfileSwitch = document.getElementById("btn-profile-switch");
  const profileListError = document.getElementById("profile-list-error");
  const btnProfileRetry = document.getElementById("btn-profile-retry");
  const btnModules = document.getElementById("btn-modules");
  const modulesPanel = document.getElementById("modules-panel");
  const modulesPanelCount = document.getElementById("modules-panel-count");
  const modulesPanelNotice = document.getElementById("modules-panel-notice");
  const modulesList = document.getElementById("modules-list");
  const moduleInstallForm = document.getElementById("module-install-form");
  const moduleNameInput = document.getElementById("module-name-input");
  const moduleUrlInput = document.getElementById("module-url-input");
  const btnModulesClose = document.getElementById("btn-modules-close");
  const btnRefreshProviders = document.getElementById("btn-refresh-providers");
  const btnRefresh = document.getElementById("btn-refresh");
  const btnEmbeddedUi = document.getElementById("btn-embedded-ui");
  const btnOptions = document.getElementById("btn-options");
  const providersPanel = document.getElementById("providers-panel");
  const providersPanelCount = document.getElementById("providers-panel-count");
  const providersPanelNotice = document.getElementById("providers-panel-notice");
  const providersList = document.getElementById("providers-list");
  const btnProvidersRefreshAll = document.getElementById("btn-providers-refresh-all");
  const btnProvidersClose = document.getElementById("btn-providers-close");
  const toggleProxy = document.getElementById("toggle-chrome-proxy");
  const proxyToggleWrapper = document.getElementById("proxy-toggle-wrapper");
  const btnToggleHidden = document.getElementById("btn-toggle-hidden");
  const trafficPort = chrome.runtime.connect({ name: "traffic-watch" });
  let trafficTimer = null;
  const btnExpandAll = document.getElementById("btn-expand-all");
  const btnCollapseAll = document.getElementById("btn-collapse-all");
  const filterBar = document.getElementById("filter-bar");
  const groupFilterInput = document.getElementById("group-filter");
  const btnFilter = document.getElementById("btn-filter");
  const btnFilterClear = document.getElementById("btn-filter-clear");
  const btnCurrentSiteCheck = document.getElementById("btn-current-site-check");
  const btnCurrentSiteToggle = document.getElementById("btn-current-site-toggle");
  const currentSitePanel = document.getElementById("current-site-panel");
  const currentSiteHost = document.getElementById("current-site-host");
  const currentSiteResult = document.getElementById("current-site-result");

  let hiddenGroupsMode = await StorageManager.getHiddenGroupsMode();
  let groupExpandMode = await StorageManager.getGroupExpandMode();
  let groupExpandStates = await StorageManager.getGroupExpandStates();
  const collapseGroupAfterSelection = await StorageManager.shouldCollapseGroupAfterSelection();
  const activeGroupTests = new Map();
  let providersPanelNoticeTimer = null;
  /** @type {Array<{id: string, type: string, source: string, source_kind: string, group?: string, status: string, last_updated_unix?: number, update_interval_seconds: number}>} */
  let currentProviders = [];
  let providersRefreshing = false;
  let providerObservations = new Map();
  let providerFlashTimer = null;
  const providerRefreshOperations = new Set();

  // The header button's "testing" class (used by CSS) and the task hub's
  // provider row are one piece of state; always change them together.
  function setProviderRefreshIndicator(running) {
    btnRefreshProviders.classList.toggle("testing", running);
    popupInteractions.setTaskRunning("providers", running);
  }
  let providerRefreshTask = null;
  let providerRefreshPollTimer = null;
  let handledProviderTaskState = "";
  let providerListRead = null;
  let providerTaskRead = null;
  let currentOutbound = null;
  let currentOutboundPolicies = [];
  let outboundOperation = null;
  let currentSiteOperation = null;
  let currentProfileStem = "";
  let profileInventoryInstance = null;
  let profileInventoryStem = "";
  let profileInventoryFailed = true;
  let profileInventoryRead = 0;
  let currentModules = [];
  let moduleBusy = false;
  let moduleTask = null;
  let moduleCanDismiss = false;
  let moduleSequence = 0;
  let moduleEpoch = 0;
  let moduleSync = null;
  let moduleListRead = 0;
  let modulePollTimer = null;
  let moduleRetryDelay = 1000;
  let moduleInstallPending = null;
  const moduleTaskActions = document.getElementById("module-task-actions");
  const moduleTaskCheck = document.getElementById("btn-module-task-check");
  const moduleTaskDismiss = document.getElementById("btn-module-task-dismiss");
  const runtimeExpansion = new Map();
  let groupFilterText = "";
  let filterRenderTimer = null;
  let dashboardLoad = null;
  let offlineRetryTimer = null;
  const selectingGroups = new Map();
  const groupBatch = new GroupBatchControls({
    document,
    scope: captureGroupTestRequest,
    names: () => displayedPolicyGroups(currentGroupsData).map(group => group.name),
    active: group => Array.from(activeGroupTests.values()).some(task => task.groupName === group),
    record: handleGroupTestTask,
    changed: () => { syncGroupTestButtons(); updateAllLatencyBadgesDOM(); },
  });
  window.addEventListener("pagehide", () => groupBatch.reset());
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
    providersPanelNotice.textContent = "";
    providersPanelNotice.className = "providers-panel-notice";
  }

  function providerTypeLabel(type) {
    if (type === "policy-group") return "POLICY-PATH";
    if (type === "ruleset") return "RULE-SET";
    return String(type || "UNKNOWN").toUpperCase();
  }

  function providerStatusLabel(status) {
    if (status === "ready") return msg("common.ready");
    if (status === "missing") return msg("popup.missing");
    if (status === "stale") return msg("common.stale");
    if (status === "refreshing") return msg("popup.updating");
    if (status === "update_failed") return msg("common.updateFailed");
    if (status === "refresh_succeeded") return msg("popup.updated");
    if (status === "queued") return msg("popup.waiting");
    if (status === "skipped") return msg("popup.skipped");
    if (status === "unknown") return msg("popup.pendingConfirmation");
    return status || msg("common.unknown");
  }

  function safeProviderSource(provider) {
    const source = String(provider?.source || "");
    if (provider?.source_kind !== "remote") return source;
    try {
      const url = new URL(source);
      const path = url.pathname === "/" ? "" : url.pathname;
      return `${url.host}${path}${url.search ? "?…" : ""}`;
    } catch {
      return source.replace(/\?.*$/, "?…");
    }
  }

  function providerDisplayName(provider) {
    return provider?.group || safeProviderSource(provider) || provider?.id || msg("popup.unnamedResource");
  }

  function formatProviderInterval(seconds) {
    const value = Number(seconds) || 0;
    if (value <= 0) return msg("popup.manual");
    if (value < 60) return `${value}s`;
    if (value < 3600) return `${Math.round(value / 60)}m`;
    if (value < 86400) return `${Math.round(value / 3600)}h`;
    return `${Math.round(value / 86400)}d`;
  }

  function formatProviderAbsoluteTime(unixSeconds) {
    if (!unixSeconds) return msg("popup.never");
    return new Date(unixSeconds * 1000).toLocaleString();
  }

  function outboundModeLabel(mode) {
    if (mode === "direct") return msg("popup.directAll");
    if (mode === "global") return msg("popup.globalProxy");
    return msg("popup.ruleMode");
  }

  function outboundPolicyNames(policies, groups, rememberedPolicy) {
    const names = new Set();
    if (rememberedPolicy) names.add(rememberedPolicy);
    const policyRows = Array.isArray(policies?.policies) ? policies.policies : [];
    if (policyRows.length > 0) {
      policyRows.forEach((policy) => {
        if (policy?.name) names.add(policy.name);
      });
      return Array.from(names);
    }
    (groups || []).forEach((group) => {
      if (group?.name) names.add(group.name);
      (group?.members || []).forEach((member) => names.add(member));
    });
    return Array.from(names);
  }

  function renderOutboundMode(outbound, policies, unavailableMessage = "") {
    currentOutbound = outbound;
    currentOutboundPolicies = policies || [];
    const unavailable = !outbound;
    const outboundBusy = Boolean(outboundOperation?.isCurrent());
    outboundModeCard.classList.toggle("unavailable", unavailable);
    outboundModeCard.classList.toggle("busy", outboundBusy);

    const previousPolicySelection = outboundPolicySelect.value;
    outboundPolicySelect.replaceChildren();
    if (currentOutboundPolicies.length > 0) {
      currentOutboundPolicies.forEach((policy) => {
        const option = el("option", { value: policy }, policy);
        outboundPolicySelect.appendChild(option);
      });
      const preferred =
        previousPolicySelection || outbound?.global_policy || currentOutboundPolicies[0];
      outboundPolicySelect.value = currentOutboundPolicies.includes(preferred)
        ? preferred
        : currentOutboundPolicies[0];
    } else {
      outboundPolicySelect.appendChild(el("option", { value: "" }, msg("popup.noAvailablePolicies")));
      outboundPolicySelect.value = "";
    }

    outboundModeButtons.forEach((button) => {
      const mode = button.dataset.mode;
      const active = outbound?.mode === mode;
      const changesGlobalPolicy =
        mode === "global" &&
        active &&
        outboundPolicySelect.value &&
        outboundPolicySelect.value !== outbound?.global_policy;
      button.classList.toggle("active", active && !changesGlobalPolicy);
      button.disabled =
        unavailable ||
        outboundBusy ||
        (active && !changesGlobalPolicy) ||
        (mode === "global" && !outboundPolicySelect.value);
    });
    outboundPolicySelect.disabled =
      unavailable || outboundBusy || currentOutboundPolicies.length === 0;

    if (unavailable) {
      outboundModeState.textContent = unavailableMessage || msg("popup.notSupportedCurrentCore");
      updateQuickSummaries();
      return;
    }
    outboundModeState.textContent =
      outbound.mode === "global"
        ? `${outboundModeLabel(outbound.mode)} · ${outbound.global_policy || outboundPolicySelect.value || msg("popup.notSelected")}`
        : outboundModeLabel(outbound.mode);
    updateQuickSummaries();
  }

  async function optionalApiRequest(label, run) {
    try {
      return await run();
    } catch (err) {
      console.warn(`${label} unavailable: ${err.message || err}`);
      return null;
    }
  }

  function formatProviderRelativeTime(unixSeconds) {
    if (!unixSeconds) return "—";
    const delta = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
    if (delta < 60) return msg("popup.justNow");
    if (delta < 3600) {
      const minutes = Math.floor(delta / 60);
      return msg("popup.minutesMinAgo", { minutes });
    }
    if (delta < 86400) {
      const hours = Math.floor(delta / 3600);
      return msg("popup.hoursHrAgo", { hours });
    }
    const days = Math.floor(delta / 86400);
    return msg("popup.daysDAgo", { days });
  }

  function summarizeProviderRefreshTask(task) {
    const parts = [];
    if (task.providerId) {
      const target = currentProviders.find((provider) => provider.id === task.providerId);
      parts.push(msg("popup.updatedValue", { value: target ? providerDisplayName(target) : msg("popup.selectedResources") }));
    } else {
      parts.push(msg("popup.allResourcesUpdated"));
    }
    if (Number.isFinite(task.ready) && Number.isFinite(task.total)) {
      parts.push(msg("popup.readyTotalReady", { ready: task.ready, total: task.total }));
    }
    if (Number(task.missing) > 0) parts.push(msg("popup.missingMissing", { missing: task.missing }));
    if (task.revision) parts.push(`rev ${task.revision}`);
    return parts.join(" · ");
  }

  function currentQuickPanel() {
    if (!quickPanelInstance.hidden) return "instance";
    if (!outboundModeCard.hidden) return "outbound";
    if (!quickPanelProfile.hidden) return "profile";
    return null;
  }

  function setQuickPanel(name) {
    const next = name && name !== currentQuickPanel() ? name : null;
    if (next) {
      if (isProvidersPanelOpen()) setProvidersPanelOpen(false);
      if (!modulesPanel.hidden) setModulesPanelOpen(false);
    }
    const panels = [
      ["instance", quickPanelInstance, btnQuickInstance],
      ["outbound", outboundModeCard, btnQuickOutbound],
      ["profile", quickPanelProfile, btnQuickProfile],
    ];
    panels.forEach(([key, panel, button]) => {
      const open = key === next;
      panel.hidden = !open;
      button.classList.toggle("active", open);
      button.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  function updateQuickSummaries() {
    const instanceName = activeInstance?.name || msg("common.notConfigured");
    quickInstanceValue.textContent = instanceName;
    btnQuickInstance.title = msg("popup.instanceInstancename", { instanceName });

    const outboundShort = currentOutbound ? outboundModeLabel(currentOutbound.mode) : "—";
    quickOutboundValue.textContent = outboundShort;
    btnQuickOutbound.title = currentOutbound
      ? currentOutbound.mode === "global"
        ? `${outboundShort} · ${currentOutbound.global_policy || outboundPolicySelect.value || msg("popup.notSelected")}`
        : outboundShort
      : outboundModeState.textContent || msg("popup.runtimeMode");

    const profileText = currentProfileStem || profileSelect.value || "—";
    quickProfileValue.textContent = profileText;
    const fullProfile = profileName.title || profileName.textContent || profileText;
    btnQuickProfile.title = fullProfile && fullProfile !== "-" ? fullProfile : "Profile";
  }

  function setProvidersPanelOpen(open) {
    if (open) setQuickPanel(null);
    providersPanel.hidden = !open;
    btnRefreshProviders.setAttribute("aria-expanded", open ? "true" : "false");
    btnRefreshProviders.classList.toggle("active", open);
    btnRefresh.title = open ? msg("popup.refreshResourceStatus") : msg("popup.refreshList");
    modulesPanel.hidden = true;
    btnModules.setAttribute("aria-expanded", "false");
    appContainer?.classList.toggle("dock-view", open);
    if (!open) {
      clearProvidersPanelNotice();
      if (activeInstance && providerRefreshTask && providerRefreshTask.status !== "running") {
        void chrome.runtime.sendMessage({
          type: "DISMISS_PROVIDER_REFRESH_TASK",
          instanceId: activeInstance.id,
          taskId: providerRefreshTask.id,
        }).catch((error) => console.warn("Unable to dismiss provider task:", error));
        providerRefreshTask = null;
        handledProviderTaskState = "";
      }
    }
  }

  function isProvidersPanelOpen() {
    return !providersPanel.hidden;
  }

  async function openProvidersPanel() {
    setProvidersPanelOpen(true);
    await Promise.all([loadProvidersList(), syncProviderRefreshTask({ announce: true })]);
    renderProvidersList();
  }

  async function loadProvidersList(showLoading = true) {
    const scope = captureInstanceRequest();
    const read = {
      isCurrent: () => scope.isCurrent() && providerListRead === read,
    };
    providerListRead = read;
    if (!scope.instance) {
      currentProviders = [];
      providersRefreshing = false;
      providersPanelCount.textContent = "";
      providersList.replaceChildren(
        el("div", { className: "providers-empty" }, msg("popup.noSpikeInstanceConfigured")),
      );
      btnProvidersRefreshAll.disabled = true;
      return;
    }
    if (showLoading) {
      providersList.replaceChildren(
        el(
          "div",
          { className: "providers-empty" },
          el("span", { className: "mini-spinner" }),
          el("span", {}, msg("popup.loadingResources")),
        ),
      );
      providersPanelCount.textContent = "";
    }
    try {
      const data = await SpikeApiClient.getProviders(scope.instance);
      if (!read.isCurrent()) return;
      currentProviders = Array.isArray(data.providers) ? data.providers : [];
      providerObservations = observeProviderActivations(providerObservations, currentProviders);
      providersRefreshing = currentProviders.some(provider => providerRefreshState(provider) !== "idle");
      renderProvidersList();
      if (providersRefreshing) {
        scheduleProviderRefreshPoll();
      }
    } catch (err) {
      if (!read.isCurrent()) return;
      if (showLoading || currentProviders.length === 0) {
        currentProviders = [];
        providersRefreshing = false;
        providersPanelCount.textContent = "";
        providersList.replaceChildren(
          el(
            "div",
            { className: "providers-empty error" },
            msg("popup.loadFailedError", { error: requestErrorText(err) || msg("common.unknownError") }),
          ),
        );
        btnProvidersRefreshAll.disabled = true;
      }
    }
  }

  function scheduleProviderRefreshPoll(delay = 350) {
    if (providerRefreshPollTimer !== null) return;
    const scope = captureInstanceRequest();
    providerRefreshPollTimer = setTimeout(async () => {
      providerRefreshPollTimer = null;
      if (!scope.isCurrent()) return;
      await syncProviderRefreshTask({ announce: true });
      if (!scope.isCurrent()) return;
      await loadProvidersList(false);
      if (providerRefreshTask?.status === "running" || providersRefreshing || [...providerRefreshOperations].some(operation => operation.isCurrent())) {
        scheduleProviderRefreshPoll(350);
      }
    }, delay);
  }

  async function syncProviderRefreshTask({ announce = false } = {}) {
    const scope = captureInstanceRequest();
    if (!scope.instance) return;
    const read = {
      isCurrent: () =>
        scope.isCurrent() &&
        providerTaskRead === read &&
        ![...providerRefreshOperations].some(operation => operation.isCurrent()),
    };
    providerTaskRead = read;
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "GET_PROVIDER_REFRESH_TASK",
        instanceId: scope.instance.id,
      });
    } catch (error) {
      if (!read.isCurrent()) return;
      console.warn(`Unable to restore provider refresh task: ${error.message}`);
      return;
    }
    if (!read.isCurrent() || !response?.ok) return;

    const previousStatus = providerRefreshTask?.status;
    const task = response.task || null;
    providerRefreshTask = task;
    const running = task?.status === "running";

    setProviderRefreshIndicator(running || providersRefreshing);

    if (running) {
      clearProvidersPanelNotice();
      renderProvidersList();
      scheduleProviderRefreshPoll();
      return;
    }

    const stateKey = task
      ? `${task.id}:${task.status}`
      : "";
    const newlySettled = stateKey && stateKey !== handledProviderTaskState;
    if (newlySettled && (announce || previousStatus === "running")) {
      await loadProvidersList(false);
      if (!read.isCurrent()) return;
      if (task.status === "succeeded") {
        if (isProvidersPanelOpen()) {
          handledProviderTaskState = stateKey;
          showProvidersPanelNotice(summarizeProviderRefreshTask(task), "success");
        }
        void loadDashboard();
      } else if (task.status === "failed" && isProvidersPanelOpen()) {
        handledProviderTaskState = stateKey;
        const progress = providerTaskProgress(task);
        showProvidersPanelNotice(
          statusError(task) || (progress.failed > 0
            ? msg("popup.failedResourcesFailedUpdate", { failed: progress.failed })
            : msg("popup.externalResourceUpdateFailed")),
          "error",
        );
      } else if (task.status === "unknown" && isProvidersPanelOpen()) {
        handledProviderTaskState = stateKey;
        showProvidersPanelNotice(
          summarizeProviderRefreshError(task.error || msg("popup.unableConfirmExternalResource")),
          "error",
        );
      }
    } else if (!providerRefreshTask && providersRefreshing) {
      clearProvidersPanelNotice();
    }
    renderProvidersList();
  }

  function resolveProviderDisplayStatus(provider) {
    const state = providerRefreshState(provider);
    if (state === "queued") return "queued";
    if (state !== "idle") return "refreshing";
    if (provider.last_refresh_error) return "update_failed";
    if (providerObservations.get(provider.id)?.updatedUntil > Date.now()) return "refresh_succeeded";
    const availability =
      provider.availability || (provider.status === "missing" ? "missing" : "available");
    if (availability === "missing") return "missing";
    if (provider.freshness === "stale") return "stale";
    return "ready";
  }

  function renderProvidersList() {
    clearTimeout(providerFlashTimer);
    const flashUntil = Math.min(...[...providerObservations.values()].map(row => row.updatedUntil).filter(time => time > Date.now()));
    if (Number.isFinite(flashUntil)) providerFlashTimer = setTimeout(renderProvidersList, flashUntil - Date.now() + 5);
    const count = currentProviders.length;
    providersPanelCount.textContent = count > 0 ? msg("popup.countItems", { count }) : "";
    const headerBusy = providersRefreshing || [...providerRefreshOperations].some(operation => operation.isCurrent());
    btnProvidersRefreshAll.disabled = !activeInstance || !currentProviders.some(provider => providerRefreshState(provider) === "idle");
    btnProvidersRefreshAll.textContent = msg("popup.updateAll");
    btnProvidersRefreshAll.classList.toggle("testing", headerBusy);
    setProviderRefreshIndicator(headerBusy);

    if (count === 0) {
      providersList.replaceChildren(
        el(
          "div",
          { className: "providers-empty" },
          msg("popup.noResourcesConfiguredPolicy"),
        ),
      );
      return;
    }

    providersList.replaceChildren();
    currentProviders.forEach((provider) => {
      const rowUpdating = providerRefreshState(provider) !== "idle";
      const displayStatus = resolveProviderDisplayStatus(provider);
      const statusClass = `provider-status status-${displayStatus}`;
      const typeLabel = providerTypeLabel(provider.type);
      const statusLabel = providerStatusLabel(displayStatus);
      const taskItem = providerRefreshTask?.providerResults?.find(item => item.providerId === provider.id);
      const refreshError = (taskItem?.status === "failed" && statusError(taskItem)) || provider.last_refresh_error || "";
      const safeSource = safeProviderSource(provider);
      const sourceTitle = [
        safeSource,
        provider.group ? msg("popup.groupGroup", { group: provider.group }) : null,
        msg("popup.sourceValue", { value: provider.source_kind || "unknown" }),
        msg("popup.availabilityValue", { value: provider.availability || "unknown" }),
        msg("popup.freshnessValue", { value: provider.freshness || "unknown" }),
        msg("popup.intervalValue", { value: formatProviderInterval(provider.update_interval_seconds) }),
        msg("popup.updatedValue2", { value: formatProviderAbsoluteTime(provider.last_updated_unix) }),
      ]
        .filter(Boolean)
        .join("\n");

      const updateBtn = el(
        "button",
        {
          type: "button",
          className: "btn-provider-row-update",
          disabled: !activeInstance || rowUpdating,
          title: provider.source_kind === "local" ? msg("popup.reloadLocalResource") : msg("popup.downloadApplyResource"),
          onClick: (e) => {
            e.stopPropagation();
            void runProviderRefresh(provider.id);
          },
        },
        rowUpdating ? "…" : provider.source_kind === "local" ? msg("popup.reload") : msg("common.update"),
      );

      const metaParts = [];
      metaParts.push(
        provider.source_kind === "remote"
          ? msg("popup.remote")
          : provider.source_kind === "local"
            ? msg("popup.local")
            : provider.source_kind || msg("common.unknown"),
      );
      metaParts.push(formatProviderInterval(provider.update_interval_seconds));

      const row = el(
        "div",
        {
          className: `provider-row ${rowUpdating ? "busy" : ""}`,
          title: sourceTitle,
          dataset: { providerId: provider.id },
        },
        el(
          "div",
          { className: "provider-row-main" },
          el(
            "div",
            { className: "provider-row-top" },
            el("span", { className: "provider-type" }, typeLabel),
            el(
              "span",
              {
                className: statusClass,
                title: refreshError,
              },
              statusLabel,
            ),
            updateBtn,
          ),
          el(
            "div",
            {
              className: "provider-source",
            },
            providerDisplayName(provider),
          ),
          provider.group && safeSource
            ? el("div", { className: "provider-origin", title: safeSource }, safeSource)
            : null,
          refreshError
            ? el(
                "div",
                { className: "provider-row-error", title: refreshError },
                summarizeProviderRefreshError(refreshError),
              )
            : null,
          el(
            "div",
            { className: "provider-row-meta" },
            el(
              "span",
              {
                className: "provider-updated",
                title: formatProviderAbsoluteTime(provider.last_updated_unix),
              },
              formatProviderRelativeTime(provider.last_updated_unix),
            ),
            el("span", { className: "provider-meta-sep" }, "·"),
            el("span", { className: "provider-meta-extra" }, metaParts.join(" · ")),
          ),
        ),
      );
      providersList.appendChild(row);
    });
  }

  async function runProviderRefresh(providerId) {
    const scope = captureInstanceRequest();
    if (!scope.instance) return;
    const operation = {
      isCurrent: () => scope.isCurrent() && providerRefreshOperations.has(operation),
    };
    providerRefreshOperations.add(operation);
    providerTaskRead = null;
    const providerIds = providerId ? [providerId] : currentProviders.map((provider) => provider.id);
    providerRefreshTask = {
      id: "starting",
      instanceId: scope.instance.id,
      providerId: providerId || null,
      status: "running",
    };

    setProviderRefreshIndicator(true);
    clearProvidersPanelNotice();
    renderProvidersList();
    scheduleProviderRefreshPoll();

    try {
      const response = await chrome.runtime.sendMessage({
        type: "START_PROVIDER_REFRESH",
        instanceId: scope.instance.id,
        providerId: providerId || null,
        providerIds,
      });
      if (!operation.isCurrent()) return;
      if (!response?.ok || !response.task) {
        throw new Error(requestErrorText(response) || msg("popup.unableStartResourceUpdate"));
      }
      providerRefreshTask = response.task;

      handledProviderTaskState = "";
      clearProvidersPanelNotice();
      renderProvidersList();
      await loadProvidersList(false);
      scheduleProviderRefreshPoll();
    } catch (err) {
      if (!operation.isCurrent()) return;
      providerRefreshTask = null;

      setProviderRefreshIndicator(false);
      showProvidersPanelNotice(
        msg("popup.unableStartUpdateError", { error: requestErrorText(err) || msg("common.unknownError") }),
        "error",
      );
      renderProvidersList();
    } finally {
      providerRefreshOperations.delete(operation);
    }
    if (scope.isCurrent() && providerRefreshTask === null) {
      await syncProviderRefreshTask({ announce: true });
    }
  }

  function handleGroupTestTask(task) {
    const previous = groupTestTaskVersions.get(groupTestTaskKey(task));
    if (!acceptGroupTestTask(task)) return;
    const metadata = activeGroupTests.get(task.id) || {
      groupName: task.group,
      targetMember: task.requested_member || task.member || null,
      completedMembers: new Set(),
    };
    metadata.completedMembers = new Set((task.results || []).filter((result) => isDirectGroupProbeResult(task.group, result)).map((result) => result.member));
    activeGroupTests.set(task.id, metadata);
    if (Array.isArray(task.results) && task.results.length > 0) {
      recordProbeResults(leafProbeResults, task.group, task.results, task.created_at_unix_ms || Date.now());
    }
    updateAllLatencyBadgesDOM();
    if (terminalGroupTestStatuses.has(task.status)) {
      finishGroupTestTask(task.id);
      if (task.status === "failed" && previous?.status !== "failed") {
        const reason = statusError(task);
        if (reason) showToast(reason, "error");
      }
    }
    if (groupTaskHealthChanged(previous, task) || probeSnapshotsDirty) void refreshProbeSnapshots();
  }

  function finishGroupTestTask(taskId) {
    const metadata = activeGroupTests.get(taskId);
    activeGroupTests.delete(taskId);
    if (metadata) {
      const stillTestingGroup = Array.from(activeGroupTests.values()).some(
        (task) => task.groupName === metadata.groupName,
      );
      if (!stillTestingGroup) {
        const button = document.querySelector(
          `.btn-test-group[data-group="${CSS.escape(metadata.groupName)}"]`,
        );
        if (button) button.classList.remove("testing");
      }
    }
    updateAllLatencyBadgesDOM();
  }

  function refreshProbeSnapshots() {
    probeSnapshotsDirty = true;
    if (probeSnapshotRefresh?.isCurrent()) return probeSnapshotRefresh.promise;
    const scope = captureInstanceRequest();
    const epoch = groupTestEpoch;
    const refresh = {
      isCurrent: () => scope.isCurrent() && groupTestEpoch === epoch && probeSnapshotRefresh === refresh,
    };
    probeSnapshotRefresh = refresh;
    refresh.promise = (async () => {
      while (refresh.isCurrent() && probeSnapshotsDirty) {
        probeSnapshotsDirty = false;
        try {
          await refreshGroupsSelectionState("");
        } catch {
          // Preserve last-good health and retry on the next task-state notification.
          if (refresh.isCurrent()) probeSnapshotsDirty = true;
          break;
        }
      }
    })().finally(() => {
      if (probeSnapshotRefresh === refresh) probeSnapshotRefresh = null;
    });
    return refresh.promise;
  }

  function captureGroupTestRequest() {
    const scope = captureInstanceRequest();
    const epoch = groupTestEpoch;
    return { instance: scope.instance, isCurrent: () => scope.isCurrent() && groupTestEpoch === epoch };
  }

  async function restoreRecentGroupTests() {
    const scope = captureGroupTestRequest();
    if (!scope.instance) return;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "GET_GROUP_TEST_STATE",
        instanceId: scope.instance.id,
      });
      if (!scope.isCurrent()) return;
      if (!response?.ok) throw new Error(response?.error || "Unable to restore group tests");
      applyGroupTestState(response.tasks);
    } catch (error) {
      if (!scope.isCurrent()) return;
      console.warn(`Unable to restore group tests: ${error.message}`);
    }
  }

  function applyGroupTestState(tasks) {
    const previousEntries = new Map(activeGroupTests);
    const previousActiveIds = new Set(previousEntries.keys());
    activeGroupTests.clear();
    let taskSettled = false;
    let healthChanged = false;

    const ordered = Array.isArray(tasks)
      ? tasks.slice().sort((left, right) => left.id - right.id)
      : [];
    for (const task of ordered) {
      const previous = groupTestTaskVersions.get(groupTestTaskKey(task));
      if (!acceptGroupTestTask(task)) continue;
      healthChanged ||= groupTaskHealthChanged(previous, task);
      recordProbeResults(leafProbeResults, task.group, task.results, task.created_at_unix_ms || Date.now());
      if (terminalGroupTestStatuses.has(task.status)) {
        if (previousActiveIds.has(task.id)) taskSettled = true;
        continue;
      }
      activeGroupTests.set(task.id, {
        groupName: task.group,
        targetMember:
          task.requested_member || task.member || previousEntries.get(task.id)?.targetMember || null,
        completedMembers: new Set((task.results || []).filter((result) => isDirectGroupProbeResult(task.group, result)).map((result) => result.member)),
      });
    }
    syncGroupTestButtons();
    updateAllLatencyBadgesDOM();
    if (taskSettled || healthChanged || probeSnapshotsDirty) void refreshProbeSnapshots();
  }

  function syncGroupTestButtons() {
    groupsContainer.querySelectorAll(".btn-test-group").forEach((button) => {
      const submitting = Array.from(submittingGroupTests.values()).some(
        (operation) => operation.groupName === button.dataset.group && operation.isCurrent(),
      );
      const testing = Array.from(activeGroupTests.values()).some(
        (task) => task.groupName === button.dataset.group,
      );
      const cancelling = Boolean(cancellingGroupTests.get(button.dataset.group)?.isCurrent());
      button.classList.toggle("testing", testing || submitting);
      button.classList.toggle("cancelling", cancelling);
      button.disabled = cancelling || submitting || (groupBatch.reserved.includes(button.dataset.group) && !testing);
      button.title = cancelling ? msg("popup.cancellingGroupTest") : testing ? msg("popup.cancelGroupTest") : msg("popup.testGroupLatency");
      button.setAttribute("aria-label", button.title);
      const label = button.querySelector(".group-test-action-label");
      if (label) label.textContent = cancelling ? msg("popup.cancelling") : msg("popup.cancel");
    });
  }

  function resetGroupTestTracking() {
    groupBatch.reset();
    groupTestEpoch += 1;
    probeSnapshotRefresh = null;
    probeSnapshotsDirty = false;
    activeGroupTests.clear();
    cancellingGroupTests.clear();
    submittingGroupTests.clear();
    groupTestTaskVersions.clear();
    syncGroupTestButtons();
    updateAllLatencyBadgesDOM();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "GROUP_TEST_STATE_CHANGED" || message.instanceId !== activeInstance?.id) {
      return;
    }
    applyGroupTestState(message.tasks);
  });

  btnToggleHidden.addEventListener("click", async () => {
    hiddenGroupsMode = nextHiddenGroupsMode(hiddenGroupsMode);
    await StorageManager.setHiddenGroupsMode(hiddenGroupsMode);
    updateHiddenToggleUI();
    renderGroups(currentGroupsData);
  });

  btnExpandAll.addEventListener("click", () => {
    void setAllGroupsExpanded(true);
  });

  btnCollapseAll.addEventListener("click", () => {
    void setAllGroupsExpanded(false);
  });

  function isFilterBarOpen() {
    return !filterBar.hidden;
  }

  function updateFilterButtonUI() {
    const open = isFilterBarOpen();
    btnFilter.classList.toggle("active", open || groupFilterText.length > 0);
    btnFilter.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function setFilterBarOpen(open) {
    filterBar.hidden = !open;
    updateFilterButtonUI();
    if (open) groupFilterInput.focus();
  }

  btnFilter.addEventListener("click", () => {
    setFilterBarOpen(!isFilterBarOpen());
  });

  groupFilterInput.addEventListener("input", () => {
    groupFilterText = groupFilterInput.value.trim().toLowerCase();
    filterBar.classList.toggle("has-value", groupFilterText.length > 0);
    updateFilterButtonUI();
    if (filterRenderTimer !== null) clearTimeout(filterRenderTimer);
    filterRenderTimer = setTimeout(() => {
      filterRenderTimer = null;
      renderGroups(currentGroupsData);
    }, 120);
  });

  btnFilterClear.addEventListener("click", () => {
    groupFilterInput.value = "";
    groupFilterText = "";
    filterBar.classList.remove("has-value");
    updateFilterButtonUI();
    renderGroups(currentGroupsData);
    groupFilterInput.focus();
  });

  function cancelGroupFilter() {
    if (filterRenderTimer !== null) {
      clearTimeout(filterRenderTimer);
      filterRenderTimer = null;
    }
    groupFilterInput.value = "";
    groupFilterText = "";
    filterBar.classList.remove("has-value");
    updateFilterButtonUI();
    renderGroups(currentGroupsData);
    setFilterBarOpen(false);
  }

  groupFilterInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancelGroupFilter();
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const editing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target?.isContentEditable;
    if (event.key === "/" && !editing && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      setFilterBarOpen(true);
      return;
    }
    if (event.key !== "Escape") return;
    if (isFilterBarOpen()) {
      event.preventDefault();
      cancelGroupFilter();
    } else if (currentQuickPanel()) {
      setQuickPanel(null);
    } else if (!providersPanel.hidden) {
      setProvidersPanelOpen(false);
    } else if (!modulesPanel.hidden) {
      setModulesPanelOpen(false);
    }
  });

  function updateHiddenToggleUI() {
    const label = hiddenGroupsModeLabel(hiddenGroupsMode);
    btnToggleHidden.classList.toggle("active", hiddenGroupsMode === "show");
    btnToggleHidden.classList.toggle("smart", hiddenGroupsMode === "smart");
    btnToggleHidden.title = label.title;
    btnToggleHidden.setAttribute("aria-label", label.aria);
    btnToggleHidden.dataset.mode = hiddenGroupsMode;
    const icon =
      hiddenGroupsMode === "show"
        ? createEyeIcon(14)
        : hiddenGroupsMode === "smart"
          ? createSparklesIcon(14)
          : createEyeOffIcon(14);
    btnToggleHidden.replaceChildren(icon);
  }

  /**
   * Expand or collapse every visible group card.
   * When mode is 'remember', persist the resulting states.
   */
  async function setAllGroupsExpanded(expanded) {
    const cards = groupsContainer.querySelectorAll(".group-card");
    if (cards.length === 0) return;

    const nextStates = { ...groupExpandStates };
    cards.forEach((card) => {
      card.classList.toggle("expanded", expanded);
      if (card.dataset.group) {
        nextStates[card.dataset.group] = expanded;
        runtimeExpansion.set(card.dataset.group, expanded);
      }
    });

    groupExpandStates = nextStates;
    if (groupExpandMode === "remember") {
      await StorageManager.setGroupExpandStates(nextStates);
    }
  }

  async function persistGroupExpandState(groupName, expanded) {
    if (!groupName) return;
    runtimeExpansion.set(groupName, Boolean(expanded));
    groupExpandStates = {
      ...groupExpandStates,
      [groupName]: Boolean(expanded),
    };
    if (groupExpandMode === "remember") {
      await StorageManager.setGroupExpandState(groupName, expanded);
    }
  }

  function resolveInitialExpand(group, idx) {
    if (runtimeExpansion.has(group.name)) {
      return Boolean(runtimeExpansion.get(group.name));
    }
    if (groupExpandMode === "expand-all") return true;
    if (groupExpandMode === "collapse-all") return false;
    if (groupExpandMode === "remember") {
      if (Object.prototype.hasOwnProperty.call(groupExpandStates, group.name)) {
        return Boolean(groupExpandStates[group.name]);
      }
      // Unknown groups fall back to smart defaults until the user toggles them.
      return idx < 2 || group.kind === "select";
    }
    // smart
    return idx < 2 || group.kind === "select";
  }

  // Populate Instance Selector
  function renderInstanceSelector() {
    instanceSelect.replaceChildren();
    if (instances.length === 0) {
      const opt = el("option", { value: "" }, msg("popup.noAvailableInstances"));
      instanceSelect.appendChild(opt);
    } else {
      instances.forEach((inst) => {
        const opt = el("option", { value: inst.id }, inst.name);
        if (activeInstance && inst.id === activeInstance.id) {
          opt.selected = true;
        }
        instanceSelect.appendChild(opt);
      });
    }
    updateQuickSummaries();
  }
  renderInstanceSelector();

  // Proxy toggle state
  const isProxyEnabled = await StorageManager.isProxyModeEnabled();
  toggleProxy.checked = isProxyEnabled;
  void refreshProxyControlState();

  toggleProxy.addEventListener("change", async (e) => {
    if (!activeInstance) {
      toggleProxy.checked = false;
      showToast(msg("popup.configureActivateSpikeInstance"), "error");
      return;
    }
    const enabled = e.target.checked;
    toggleProxy.disabled = true;
    proxyToggleWrapper.classList.add("busy");
    try {
      await StorageManager.setProxyModeEnabled(enabled);
      const response = await chrome.runtime.sendMessage({
        type: "UPDATE_PROXY_SETTING",
      });
      if (!response || !response.ok) {
        throw new Error(response?.error || msg("popup.unableUpdateBrowserProxy"));
      }
      toggleProxy.checked = await StorageManager.isProxyModeEnabled();
      if (response.superseded) await refreshProxyControlState();
      else renderProxyControlState(response, toggleProxy.checked);
    } catch (err) {
      toggleProxy.checked = await StorageManager.isProxyModeEnabled();
      setProxyControlDot("blocked", msg("popup.proxyControlFailedError", { error: requestErrorText(err) }));
    } finally {
      toggleProxy.disabled = false;
      proxyToggleWrapper.classList.remove("busy");
    }
  });

  // Instance selector change handler
  instanceSelect.addEventListener("change", async (e) => {
    // Invalidate instance-owned requests before permission or storage awaits.
    const generation = ++instanceGeneration;
    currentSiteOperation = null;
    btnCurrentSiteCheck.disabled = false;
    currentSiteHost.textContent = msg("popup.notChecked");
    currentSiteHost.title = "";
    currentSiteResult.textContent = msg("popup.compareActiveTabS");
    profileSwitchOperation = null;
    btnProfileSwitch.disabled = true;
    profileInventoryFailed = true;
    setQuickPanel(null);
    const selectedId = e.target.value;
    const targetInst = instances.find((i) => i.id === selectedId);
    if (!targetInst) {
      renderInstanceSelector();
      void loadDashboard();
      return;
    }
    try {
      const granted = await ensureHostPermission(targetInst.baseUrl);
      if (generation !== instanceGeneration) return;
      if (!granted) {
        renderInstanceSelector();
        showToast(msg("popup.hostPermissionNotGranted"), "error");
        void loadDashboard();
        return;
      }
      const write = instanceSelectionWrite.then(() => {
        if (generation === instanceGeneration) {
          return StorageManager.setActiveInstanceId(selectedId);
        }
      });
      instanceSelectionWrite = write.catch(() => {});
      await write;
      if (generation !== instanceGeneration) return;
    } catch (error) {
      if (generation !== instanceGeneration) return;
      renderInstanceSelector();
      showToast(requestErrorText(error) || msg("common.unknownError"), "error");
      void loadDashboard();
      return;
    }
    resetGroupTestTracking();
    leafProbeResults.clear();
    runtimeExpansion.clear();
    selectingGroups.clear();
    groupFilterText = "";
    groupFilterInput.value = "";
    filterBar.classList.remove("has-value");
    setFilterBarOpen(false);
    if (offlineRetryTimer !== null) {
      clearTimeout(offlineRetryTimer);
      offlineRetryTimer = null;
    }
    activeInstance = targetInst;
    resetModuleTracking();
    providerListRead = null;
    providerTaskRead = null;
    providerObservations = new Map();
    providerRefreshTask = null;
    handledProviderTaskState = "";
    if (providerRefreshPollTimer !== null) {
      clearTimeout(providerRefreshPollTimer);
      providerRefreshPollTimer = null;
    }
    currentProviders = [];
    providersRefreshing = false;
    currentOutbound = null;
    currentOutboundPolicies = [];
    currentGroupsData = [];
    currentProfileStem = "";
    profileName.textContent = "-";
    profileName.title = "";
    badgeGroups.textContent = msg("popup.groups");
    badgeNodes.textContent = msg("popup.nodes");
    badgeRules.textContent = msg("popup.rules");
    profileSelect.replaceChildren();
    managedBadge.hidden = true;
    renderTraffic(null);
    badgeDnsDelay.textContent = "DNS: —";
    badgeDnsDelay.title = "";
    proxyListeners.replaceChildren(el("span", { className: "proxy-listener-empty" }, "-"));
    setProviderRefreshIndicator(false);
    renderOutboundMode(null, [], msg("popup.switchingInstance"));
    chrome.runtime.sendMessage({ type: "UPDATE_PROXY_SETTING" });
    void loadDashboard();
    if (isProvidersPanelOpen()) {
      clearProvidersPanelNotice();
      await Promise.all([loadProvidersList(), syncProviderRefreshTask({ announce: true })]);
    } else {
      void syncProviderRefreshTask();
    }
  });

  btnRefresh.addEventListener("click", () => {
    if (isProvidersPanelOpen()) {
      void Promise.all([loadProvidersList(), syncProviderRefreshTask({ announce: true })]);
    } else {
      loadDashboard();
    }
  });

  btnCurrentSiteToggle.addEventListener("click", () => {
    currentSitePanel.hidden = !currentSitePanel.hidden;
    btnCurrentSiteToggle.setAttribute("aria-expanded", String(!currentSitePanel.hidden));
    if (!currentSitePanel.hidden) btnCurrentSiteCheck.click();
  });

  btnCurrentSiteCheck.addEventListener("click", async () => {
    const scope = captureInstanceRequest();
    if (currentSiteOperation?.isCurrent()) return;
    if (!scope.instance) {
      currentSiteResult.textContent = msg("popup.configureConnectSpikeInstance");
      return;
    }
    currentSiteOperation = scope;
    btnCurrentSiteCheck.disabled = true;
    currentSiteHost.textContent = msg("popup.notChecked");
    currentSiteHost.title = "";
    currentSiteResult.textContent = msg("popup.inspectingActiveTab");
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!scope.isCurrent()) return;
      const target = activeTabTarget(tab);
      if (!target) {
        currentSiteHost.textContent = msg("popup.unavailable2");
        currentSiteResult.textContent = msg("popup.activePageNotInspectable");
        return;
      }
      currentSiteHost.textContent = target.host;
      currentSiteHost.title = target.host;
      const [route, connections] = await Promise.all([
        SpikeApiClient.explainRoute(scope.instance, target),
        SpikeApiClient.getConnections(scope.instance),
      ]);
      if (!scope.isCurrent()) return;
      const summary = summarizeCurrentSite(target, route, connections);
      currentSiteResult.replaceChildren(
        el("span", {}, summary.resolutionError ? msg("popup.expectedResolutionFailed") : msg("popup.expected")),
        el("strong", {}, summary.expectedPolicy),
        el("span", {}, ` ${msg("popup.ruleRule", { rule: summary.rule })}`),
        ...(summary.resolutionError
          ? [el("br"), el("span", { className: "current-site-warning" }, summary.resolutionError)]
          : []),
        el("br"),
        el("span", {}, msg("popup.existingConnections")),
        el("strong", {}, summary.actualPolicy),
        el("span", {}, ` ${msg("popup.connectioncountConnections", { connectionCount: summary.connectionCount })}`),
        ...(summary.reused
          ? [
              el("br"),
              el(
                "span",
                { className: "current-site-warning" },
                msg("popup.existingConnectionsMayPredate"),
              ),
            ]
          : []),
      );
    } catch (error) {
      if (!scope.isCurrent()) return;
      currentSiteResult.textContent = msg("popup.inspectionFailedError", { error: requestErrorText(error) || msg("common.unknownError") });
    } finally {
      if (currentSiteOperation === scope) {
        currentSiteOperation = null;
        if (scope.isCurrent()) btnCurrentSiteCheck.disabled = false;
      }
    }
  });

  btnRefreshProviders.addEventListener("click", async () => {
    if (isProvidersPanelOpen()) {
      setProvidersPanelOpen(false);
      return;
    }
    await openProvidersPanel();
  });

  btnProvidersClose.addEventListener("click", () => {
    setProvidersPanelOpen(false);
  });

  btnProvidersRefreshAll.addEventListener("click", async () => {
    await runProviderRefresh();
  });

  function setModulesPanelOpen(open) {
    if (open) setQuickPanel(null);
    modulesPanel.hidden = !open;
    btnModules.setAttribute("aria-expanded", open ? "true" : "false");
    providersPanel.hidden = true;
    btnRefreshProviders.classList.remove("active");
    btnRefreshProviders.setAttribute("aria-expanded", "false");
    appContainer?.classList.toggle("dock-view", open);
    if (open) {
      moduleBusy = true;
      updateModuleControls();
      void Promise.all([loadModulesList(), syncModuleUpdate()]);
    }
  }

  btnModules.addEventListener("click", () => {
    setModulesPanelOpen(modulesPanel.hidden);
  });

  btnModulesClose.addEventListener("click", () => {
    setModulesPanelOpen(false);
  });

  moduleInstallForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runModuleUpdate({
      name: moduleNameInput.value.trim(),
      url: moduleUrlInput.value.trim(),
    });
  });

  btnQuickInstance.addEventListener("click", () => setQuickPanel("instance"));
  btnQuickOutbound.addEventListener("click", () => setQuickPanel("outbound"));
  btnQuickProfile.addEventListener("click", () => setQuickPanel("profile"));
  document.querySelectorAll("[data-quick-close]").forEach((button) => {
    button.addEventListener("click", () => setQuickPanel(null));
  });

  btnProfileSwitch.addEventListener("click", () => {
    void switchActiveProfile();
  });
  btnProfileRetry.addEventListener("click", () => {
    if (activeInstance) void refreshProfileControls({ profile: currentProfileStem }, captureInstanceRequest());
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "PROXY_HEALTH_CHANGED") {
      void refreshProxyControlState();
      return;
    }
    if (message.instanceId !== activeInstance?.id) return;
    if (message.type === "MODULE_UPDATE_CHANGED") {
      // Notifications invalidate the projection; never apply an old task payload directly.
      void syncModuleUpdate();
    }
  });

  btnOptions.addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL("options.html"));
    }
  });

  async function openEmbeddedUi() {
    if (!activeInstance) {
      showToast(msg("popup.configureActivateSpikeInstance"), "error");
      return;
    }
    const url = SpikeApiClient.dashboardUrl(activeInstance);
    if (!url) {
      showToast(msg("popup.currentInstanceNoControl"), "error");
      return;
    }
    try {
      const existing = chrome.tabs?.query ? await chrome.tabs.query({ url: `${url}*` }) : [];
      const tab = existing.find((item) => item.id != null);
      if (tab) {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId != null && chrome.windows?.update) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return;
      }
      if (chrome.tabs?.create) {
        await chrome.tabs.create({ url });
      }
    } catch (err) {
      showToast(msg("popup.unableOpenDashboardError", { error: requestErrorText(err) || msg("common.unknownError") }), "error");
    }
  }

  btnEmbeddedUi.addEventListener("click", () => {
    void openEmbeddedUi();
  });

  outboundPolicySelect.addEventListener("change", () => {
    renderOutboundMode(currentOutbound, currentOutboundPolicies, msg("popup.coreDoesNotExpose"));
  });

  outboundModeButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      await switchOutboundMode(button.dataset.mode);
    });
  });

  async function switchOutboundMode(mode) {
    const scope = captureInstanceRequest();
    if (!scope.instance || outboundOperation?.isCurrent() || !OUTBOUND_MODES.includes(mode)) return;
    const policy =
      outboundPolicySelect.value ||
      currentOutbound?.global_policy ||
      currentOutboundPolicies[0] ||
      "";
    if (mode === "global" && !policy) {
      outboundModeState.textContent = msg("popup.selectGlobalPolicy");
      return;
    }
    outboundOperation = scope;
    renderOutboundMode(currentOutbound, currentOutboundPolicies, msg("popup.coreDoesNotExpose"));
    let errorMessage = "";
    try {
      const outbound = await SpikeApiClient.setOutbound(
        scope.instance,
        mode,
        mode === "global" ? policy : undefined,
      );
      if (!scope.isCurrent()) return;
      renderOutboundMode(
        outbound,
        outboundPolicyNames(
          { policies: currentOutboundPolicies.map((name) => ({ name })) },
          currentGroupsData,
          outbound?.global_policy,
        ),
      );
    } catch (err) {
      if (!scope.isCurrent()) return;
      errorMessage = msg("popup.switchFailedError", { error: requestErrorText(err) || msg("common.unknownError") });
    } finally {
      if (outboundOperation === scope) {
        outboundOperation = null;
        if (scope.isCurrent()) {
          renderOutboundMode(currentOutbound, currentOutboundPolicies, msg("popup.coreDoesNotExpose"));
          if (errorMessage) outboundModeState.textContent = errorMessage;
        }
      }
    }
  }

  function captureInstanceRequest() {
    const instance = activeInstance;
    const generation = instanceGeneration;
    return {
      instance,
      isCurrent: () => instance === activeInstance && generation === instanceGeneration,
    };
  }

  // Coalesce one instance's refreshes without blocking a newer instance.
  function loadDashboard({ force = false } = {}) {
    if (!force && dashboardLoad?.pending && dashboardLoad.isCurrent()) return dashboardLoad.promise;
    const scope = captureInstanceRequest();
    const load = {
      instance: scope.instance,
      pending: true,
      isCurrent: () => scope.isCurrent() && dashboardLoad === load,
    };
    dashboardLoad = load;
    load.promise = renderDashboard(load);
    return load.promise;
  }

  async function renderDashboard(load) {
    const instance = load.instance;
    delete groupsContainer.dataset.snapshot;
    if (offlineRetryTimer !== null) {
      clearTimeout(offlineRetryTimer);
      offlineRetryTimer = null;
    }

    if (!instance) {
      load.pending = false;
      btnRefresh.classList.remove("testing");
      setStatus("offline", msg("popup.noInstanceConfigured"));
      profileName.textContent = "-";
      profileName.title = "";
      managedBadge.hidden = true;
      badgeGroups.textContent = msg("popup.groups");
      badgeNodes.textContent = msg("popup.nodes");
      badgeRules.textContent = msg("popup.rules");
      badgeDnsDelay.textContent = "DNS: —";
      currentProfileStem = "";
      profileInventoryInstance = null;
      profileInventoryFailed = true;
      profileListError.hidden = true;
      profileSelect.replaceChildren(el("option", { value: "" }, "—"));
      renderTraffic(null);
      publishTrafficSample(null, "no instance");
      proxyListeners.replaceChildren(el("span", { className: "proxy-listener-empty" }, "-"));
      renderOutboundMode(null, [], msg("popup.noInstanceConfigured"));
      renderNoInstanceGuidance();
      return;
    }

    btnRefresh.classList.add("testing");
    setStatus("testing", msg("popup.connecting2"));

    const loadingNode = el(
      "div",
      { className: "loading-placeholder" },
      el("div", { className: "spinner" }),
      el("span", {}, msg("popup.loadingSpikePolicyGroups")),
    );
    groupsContainer.replaceChildren(loadingNode);

    let cachedGroupsRendered = false;
    const cachedReadSequence = groupReadSequence;
    try {
      const snapshot = await StorageManager.getPopupGroupSnapshot(instance.id);
      if (!load.isCurrent()) return;
      if (snapshot?.groups?.length && cachedReadSequence === groupReadSequence) {
        currentGroupsData = snapshot.groups;
        ingestPersistedMemberInfo(leafProbeResults, currentGroupsData);
        renderGroups(currentGroupsData);
        groupsContainer.dataset.snapshot = "cached";
        cachedGroupsRendered = true;
      }
    } catch (error) {
      if (!load.isCurrent()) return;
      console.warn(`Unable to restore popup group snapshot: ${error.message}`);
    }

    try {
      const sequence = ++groupReadSequence;
      const [status, groupsData, outbound, policies] = await Promise.all([
        SpikeApiClient.getStatus(instance),
        SpikeApiClient.getGroups(instance),
        optionalApiRequest("outbound mode", () => SpikeApiClient.getOutbound(instance)),
        optionalApiRequest("policy inventory", () => SpikeApiClient.getPolicies(instance)),
      ]);
      if (!load.isCurrent()) return;

      setStatus("online", msg("common.connected"));
      profileName.textContent = status.profile || "Default";
      profileName.title = status.profile || "";
      currentProfileStem = SpikeApiClient.profileStem(status.profile || "");
      badgeGroups.textContent = msg("popup.groupsValue", { value: status.groups || groupsData.groups?.length || 0 });
      badgeNodes.textContent = msg("popup.nodesValue", { value: status.leaves || 0 });
      badgeRules.textContent = msg("popup.rulesValue", { value: status.rules || 0 });
      renderProxyListeners(status);
      void refreshTraffic();
      void refreshProfileControls(status, load);
      void refreshDnsDelay(load);

      if (sequence === groupReadSequence) {
        currentGroupsData = groupsData.groups || [];
        groupBatch.observeRevision(groupsData.revision);
      }
      delete groupsContainer.dataset.snapshot;
      void StorageManager.setPopupGroupSnapshot(instance.id, currentGroupsData, load.isCurrent).catch(
        (error) => {
          if (!load.isCurrent()) return;
          console.warn(`Unable to persist popup group snapshot: ${error.message}`);
        },
      );
      renderOutboundMode(
        outbound,
        outboundPolicyNames(policies, currentGroupsData, outbound?.global_policy),
        msg("popup.coreDoesNotExpose"),
      );

      // Ingest persisted probe results from all group member_info fields
      ingestPersistedMemberInfo(leafProbeResults, currentGroupsData);

      renderGroups(currentGroupsData);
      void restoreRecentGroupTests();
    } catch (err) {
      if (!load.isCurrent()) return;
      setStatus("offline", msg("popup.notConnected"));
      profileName.textContent = "-";
      profileName.title = "";
      managedBadge.hidden = true;
      badgeGroups.textContent = msg("popup.groups");
      badgeNodes.textContent = msg("popup.nodes");
      badgeRules.textContent = msg("popup.rules");
      badgeDnsDelay.textContent = "DNS: —";
      currentProfileStem = "";
      profileSelect.replaceChildren(el("option", { value: "" }, "—"));
      renderTraffic(null);
      publishTrafficSample(null, err.message || "unreachable");
      proxyListeners.replaceChildren(el("span", { className: "proxy-listener-empty" }, "-"));
      renderOutboundMode(null, [], msg("popup.availableAfterConnecting"));

      if (cachedGroupsRendered) {
        setStatus("offline", msg("popup.offlineCached"));
        popupInteractions.announce(msg("popup.liveConnectionUnavailableShowing"));
        scheduleOfflineRetry();
        return;
      }

      const retryBtn = el(
        "button",
        { id: "btn-retry", className: "icon-btn", style: { marginTop: "6px" } },
        msg("popup.retryConnection"),
      );
      retryBtn.addEventListener("click", () => loadDashboard());

      const errorNode = el(
        "div",
        { className: "empty-state" },
        el("p", {}, msg("popup.unableConnectSpikeInstance")),
        el(
          "p",
          { style: { fontSize: "11px", color: "var(--text-dim)" } },
          requestErrorText(err) || msg("common.unknownError"),
        ),
        retryBtn,
      );
      groupsContainer.replaceChildren(errorNode);
      scheduleOfflineRetry();
    } finally {
      load.pending = false;
      if (load.isCurrent()) btnRefresh.classList.remove("testing");
    }
  }

  function renderNoInstanceGuidance() {
    const iconSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    iconSvg.setAttribute("viewBox", "0 0 24 24");
    iconSvg.setAttribute("width", "26");
    iconSvg.setAttribute("height", "26");
    iconSvg.setAttribute("stroke", "currentColor");
    iconSvg.setAttribute("stroke-width", "2");
    iconSvg.setAttribute("fill", "none");

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "3");
    iconSvg.appendChild(circle);

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z",
    );
    iconSvg.appendChild(path);

    const iconWrapper = el("div", { className: "onboarding-icon" }, iconSvg);

    const configBtn = el(
      "button",
      { type: "button", id: "btn-onboarding-config", className: "btn-onboarding-action" },
      msg("popup.configureInstance"),
    );
    configBtn.addEventListener("click", () => {
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      } else {
        window.open(chrome.runtime.getURL("options.html"));
      }
    });

    const onboardingNode = el(
      "div",
      { className: "empty-state onboarding-state" },
      iconWrapper,
      el("h3", { className: "onboarding-title" }, msg("popup.welcomeSpikedeck")),
      el(
        "p",
        { className: "onboarding-desc" },
        msg("popup.addSpikeInstanceControl"),
      ),
      configBtn,
    );

    groupsContainer.replaceChildren(onboardingNode);
  }

  function scheduleOfflineRetry(delayMs = 8000) {
    if (offlineRetryTimer !== null) return;
    offlineRetryTimer = setTimeout(() => {
      offlineRetryTimer = null;
      void loadDashboard();
    }, delayMs);
  }

  function renderTraffic(traffic) {
    if (!traffic) {
      trafficDown.textContent = "↓ —";
      trafficUp.textContent = "↑ —";
      trafficDown.removeAttribute("title");
      trafficUp.removeAttribute("title");
      trafficTotal.textContent = "";
      trafficTotal.removeAttribute("title");
      return;
    }
    trafficDown.textContent = `↓${formatCompactByteCount(traffic.download_bytes_per_second)}/s`;
    trafficUp.textContent = `↑${formatCompactByteCount(traffic.upload_bytes_per_second)}/s`;
    trafficDown.title = `↓ ${formatRate(traffic.download_bytes_per_second)}`;
    trafficUp.title = `↑ ${formatRate(traffic.upload_bytes_per_second)}`;
    trafficTotal.textContent = `${formatCompactByteCount(traffic.download_bytes_total)}/${formatCompactByteCount(traffic.upload_bytes_total)}`;
    trafficTotal.title = `↓ ${formatByteCount(traffic.download_bytes_total)} · ↑ ${formatByteCount(traffic.upload_bytes_total)}`;
  }

  function publishTrafficSample(traffic, error) {
    const payload = {
      type: "TRAFFIC_SAMPLE",
      traffic: traffic || null,
      error: error || null,
    };
    try {
      trafficPort.postMessage(payload);
    } catch {
      chrome.runtime.sendMessage(payload);
    }
  }

  async function refreshTraffic() {
    const scope = captureInstanceRequest();
    if (!scope.instance) return;
    try {
      const metrics = await SpikeApiClient.getMetrics(scope.instance);
      if (!scope.isCurrent()) return;
      renderTraffic(metrics?.traffic);
      publishTrafficSample(metrics?.traffic);
    } catch (error) {
      if (!scope.isCurrent()) return;
      renderTraffic(null);
      publishTrafficSample(null, error.message || "unreachable");
    }
  }

  function renderProxyListeners(status) {
    const listeners = proxyListenerSummary(proxyListenersFromStatus(status, activeInstance));
    if (listeners.length === 0) {
      proxyListeners.replaceChildren(
        el("span", { className: "proxy-listener-empty" }, msg("popup.noHttpSocks5Mixed")),
      );
      return;
    }
    proxyListeners.replaceChildren(
      ...listeners.map((listener) =>
        el(
          "span",
          { className: "proxy-listener" },
          el("span", { className: "proxy-listener-kind" }, listener.label),
          el("span", { className: "proxy-listener-address" }, listener.address),
        ),
      ),
    );
  }

  async function refreshProxyControlState() {
    const enabled = await StorageManager.isProxyModeEnabled();
    try {
      const state = await chrome.runtime.sendMessage({
        type: "GET_PROXY_SETTING_STATE",
      });
      if (!state || !state.ok) throw new Error(state?.error || msg("popup.unableReadChromeProxy"));
      renderProxyControlState(state, enabled);
    } catch (err) {
      setProxyControlDot("blocked", msg("popup.proxyStatusUnknownValue", { value: requestErrorText(err) }));
    }
  }

  function setProxyControlDot(kind, message) {
    proxyControlState.className = kind ? `proxy-control-dot ${kind}` : "proxy-control-dot";
    proxyControlState.title = message;
    proxyControlState.setAttribute("aria-label", message);
  }

  function renderProxyControlState(state, enabled) {
    if (enabled && state.releasedForUnhealthy) {
      setProxyControlDot("blocked", msg("popup.spikeUnreachableProxyControl"));
      return;
    }
    if (enabled && state.controlledBySpikeDeck) {
      setProxyControlDot("owned", msg("popup.spikedeckManagingBrowserProxy"));
      return;
    }
    if (enabled && state.levelOfControl === "controlled_by_other_extensions") {
      setProxyControlDot("blocked", msg("popup.anotherExtensionCurrentlyControls"));
      return;
    }
    setProxyControlDot("", msg("popup.notManagedOtherProxy"));
  }

  function groupTestTaskKey(task) {
    return `${task.task_namespace || "legacy"}:${task.id}`;
  }

  function groupTaskHealthChanged(previous, task) {
    return Number(task.completed || 0) > Number(previous?.completed || 0) ||
      (terminalGroupTestStatuses.has(task.status) && (!previous || previous.status !== task.status));
  }

  function acceptGroupTestTask(task) {
    const key = groupTestTaskKey(task);
    const previous = groupTestTaskVersions.get(key);
    if (previous) {
      const previousSequence = Number(previous.update_sequence || 0);
      const nextSequence = Number(task.update_sequence || 0);
      if (previousSequence || nextSequence) {
        if (nextSequence < previousSequence) return false;
      } else if (
        (terminalGroupTestStatuses.has(previous.status) &&
          !terminalGroupTestStatuses.has(task.status)) ||
        Number(task.completed || 0) < Number(previous.completed || 0)
      ) {
        return false;
      }
    }
    groupTestTaskVersions.set(key, task);
    return true;
  }

  /** Replace current health, including absent samples, without replaying old tasks. */
  function setStatus(state, text) {
    statusDot.className = `status-dot ${state}`;
    statusText.textContent = text;
  }

  async function refreshProfileControls(status, load) {
    const stem = SpikeApiClient.profileStem(status?.profile || "");
    const read = ++profileInventoryRead;
    const isCurrent = () => load.isCurrent() && read === profileInventoryRead;
    if (profileInventoryInstance !== load.instance) {
      profileSelect.replaceChildren(el("option", { value: stem }, stem || "—"));
      managedBadge.hidden = true;
    } else if (profileInventoryStem !== stem) managedBadge.hidden = true;
    profileInventoryInstance = load.instance;
    profileInventoryStem = stem;
    profileInventoryFailed = false;
    profileListError.hidden = true;
    btnProfileRetry.disabled = true;
    profileSelect.disabled = true;
    btnProfileSwitch.disabled = true;
    try {
      const [list, current] = await Promise.all([
        SpikeApiClient.getProfiles(load.instance),
        SpikeApiClient.getCurrentProfile(load.instance),
      ]);
      if (!isCurrent()) return;
      if (!Array.isArray(list?.profiles)) throw new Error("Invalid profile inventory");
      const names = list.profiles;
      profileSelect.replaceChildren(
        ...(names.length ? names : [stem || ""]).map((name) =>
          el("option", { value: name }, name),
        ),
      );
      profileSelect.value = names.includes(stem)
        ? stem
        : names[0] || "";
      updateQuickSummaries();
      const managed = SpikeApiClient.parseManagedProfile(current?.profile || "");
      if (managed) {
        const parts = ["Managed"];
        if (managed.intervalSeconds) parts.push(`${managed.intervalSeconds}s`);
        if (managed.strict === true) parts.push("strict");
        managedBadge.textContent = parts.join(" · ");
        managedBadge.hidden = false;
      } else {
        managedBadge.hidden = true;
      }
      profileSelect.disabled = names.length === 0;
    } catch {
      if (!isCurrent()) return;
      profileInventoryFailed = true;
      profileListError.hidden = false;
      profileSelect.disabled = true;
    } finally {
      if (isCurrent()) {
        btnProfileRetry.disabled = false;
        btnProfileSwitch.disabled = !!profileSwitchOperation || profileInventoryFailed || profileSelect.disabled;
      }
    }
  }

  async function switchActiveProfile() {
    const name = profileSelect.value;
    if (!activeInstance || profileSwitchOperation || profileInventoryFailed || profileSelect.disabled || !name || name === currentProfileStem) return;
    const instance = activeInstance;
    const generation = instanceGeneration;
    const operation = {};
    profileSwitchOperation = operation;
    const isCurrent = () =>
      profileSwitchOperation === operation &&
      instanceGeneration === generation &&
      activeInstance === instance;
    btnProfileSwitch.disabled = true;
    try {
      const checked = await SpikeApiClient.checkProfile(instance, name);
      if (!isCurrent()) return;
      if (checked?.error) throw new Error(checked.error);
      const switched = await SpikeApiClient.switchProfile(instance, name);
      if (!isCurrent()) return;
      if (switched?.error) throw new Error(switched.error);
      await loadDashboard({ force: true });
      if (!isCurrent()) return;
      setQuickPanel(null);
      showToast(msg("popup.switchedName", { name }), "success");
    } catch (error) {
      if (!isCurrent()) return;
      showToast(msg("popup.failedSwitchProfileError", { error: requestErrorText(error) || msg("common.unknownError") }), "error");
      profileSelect.value = currentProfileStem || "";
    } finally {
      if (isCurrent()) {
        profileSwitchOperation = null;
        btnProfileSwitch.disabled = profileInventoryFailed || profileSelect.disabled;
      }
    }
  }

  async function refreshDnsDelay(load) {
    try {
      const result = await SpikeApiClient.measureDnsDelay(load.instance);
      if (!load.isCurrent()) return;
      if (result?.error) {
        badgeDnsDelay.textContent = "DNS: err";
        badgeDnsDelay.title = requestErrorText(result);
        return;
      }
      badgeDnsDelay.textContent = `DNS: ${result?.delay ?? "—"} ms`;
      badgeDnsDelay.title = "";
    } catch (error) {
      if (!load.isCurrent()) return;
      badgeDnsDelay.textContent = "DNS: —";
      badgeDnsDelay.title = requestErrorText(error) || "";
    }
  }

  async function loadModulesList() {
    const scope = captureInstanceRequest();
    const read = ++moduleListRead;
    if (!scope) {
      currentModules = [];
      modulesPanelCount.textContent = "";
      modulesList.replaceChildren(el("div", { className: "providers-empty" }, msg("popup.noSpikeInstanceConfigured")));
      return;
    }
    modulesList.replaceChildren(el("div", { className: "providers-empty" }, msg("popup.loadingModules")));
    try {
      const data = await SpikeApiClient.getModules(scope.instance);
      if (!scope.isCurrent() || read !== moduleListRead) return;
      currentModules = Array.isArray(data.modules) ? data.modules : [];
      modulesPanelCount.textContent = `${currentModules.length}`;
      renderModulesList();
      if (data.error && !moduleBusy) showModulesNotice(data.error, "error");
    } catch (error) {
      if (!scope.isCurrent() || read !== moduleListRead) return;
      currentModules = [];
      modulesList.replaceChildren(
        el("div", { className: "providers-empty error" }, requestErrorText(error) || msg("popup.loadFailed")),
      );
    }
  }

  function renderModulesList() {
    if (!currentModules.length) {
      modulesList.replaceChildren(el("div", { className: "providers-empty" }, msg("popup.noInstalledModules")));
      return;
    }
    modulesList.replaceChildren(
      ...currentModules.map((module) => {
        const row = el(
          "div",
          { className: "provider-row" },
          el("div", { className: "provider-source" }, module.name),
          el("div", { className: "provider-origin" }, module.url || module.source || ""),
          el(
            "div",
            { className: "provider-row-meta" },
            el("span", {}, module.enabled ? msg("popup.enabled") : msg("popup.disabled")),
          ),
        );
        const toggle = el(
          "button",
          { className: "btn-provider-action", type: "button", disabled: moduleBusy },
          module.enabled ? msg("popup.disable") : msg("popup.enable"),
        );
        toggle.addEventListener("click", () => {
          void runModuleUpdate({ [module.name]: !module.enabled });
        });
        const uninstall = el(
          "button",
          { className: "btn-provider-action", type: "button", disabled: moduleBusy },
          msg("popup.uninstall"),
        );
        uninstall.addEventListener("click", () => {
          if (uninstall.dataset.armed) {
            void runModuleUpdate({ uninstall: module.name });
            return;
          }
          uninstall.dataset.armed = "true";
          uninstall.textContent = msg("popup.confirmUninstall");
          setTimeout(() => {
            delete uninstall.dataset.armed;
            uninstall.textContent = msg("popup.uninstall");
          }, 2500);
        });
        row.append(toggle, uninstall);
        return row;
      }),
    );
  }

  // The hub's module row is true only while the "updating" notice is shown.
  function showModulesNotice(message, state) {
    popupInteractions.setTaskRunning("modules", false);
    modulesPanelNotice.hidden = false;
    modulesPanelNotice.className = `providers-panel-notice ${state || ""}`;
    modulesPanelNotice.textContent = message;
  }

  function showModulesUpdating() {
    showModulesNotice(msg("popup.updatingModules"), "");
    popupInteractions.setTaskRunning("modules", true);
  }

  function hideModulesNotice() {
    popupInteractions.setTaskRunning("modules", false);
    modulesPanelNotice.hidden = true;
  }

  async function runModuleUpdate(body) {
    const scope = captureInstanceRequest();
    if (!scope || moduleBusy) return false;
    const epoch = ++moduleEpoch;
    moduleBusy = true;
    updateModuleControls();
    showModulesUpdating();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "START_MODULE_UPDATE",
        instanceId: scope.instance.id,
        body,
      });
      if (!scope.isCurrent() || epoch !== moduleEpoch) return false;
      if (!response?.ok) throw new Error(requestErrorText(response) || msg("popup.moduleUpdateFailed"));
      if (body.url && response.task) moduleInstallPending = { ...body, id: response.task.id, taskNamespace: response.task.taskNamespace };
      applyModuleState({ task: response.task });
      return response.task?.status === "succeeded";
    } catch (error) {
      if (!scope.isCurrent() || epoch !== moduleEpoch) return false;
      showModulesNotice(requestErrorText(error) || msg("popup.moduleUpdateFailed"), "error");
      return false;
    } finally {
      if (scope.isCurrent() && epoch === moduleEpoch) void syncModuleUpdate();
    }
  }

  function updateModuleControls() {
    moduleInstallForm.querySelector('button[type="submit"]').disabled = moduleBusy;
    modulesList.querySelectorAll("button").forEach((button) => { button.disabled = moduleBusy; });
    btnModules.classList.toggle("testing", moduleBusy);
    moduleTaskDismiss.hidden = !moduleCanDismiss;
  }

  function resetModuleTracking() {
    moduleEpoch += 1;
    moduleListRead += 1;
    moduleTask = null;
    moduleSequence = 0;
    moduleCanDismiss = false;
    moduleBusy = true;
    moduleInstallPending = null;
    currentModules = [];
    modulesPanelCount.textContent = "";
    hideModulesNotice();
    moduleTaskActions.hidden = true;
    delete moduleTaskDismiss.dataset.armed;
    moduleTaskDismiss.textContent = msg("popup.clearUnknownResult");
    if (modulePollTimer !== null) clearTimeout(modulePollTimer);
    modulePollTimer = null;
    moduleRetryDelay = 1000;
    renderModulesList();
    updateModuleControls();
    void syncModuleUpdate();
  }

  function scheduleModulePoll(delay = 1000) {
    if (modulePollTimer !== null) return;
    const scope = captureInstanceRequest();
    modulePollTimer = setTimeout(() => {
      modulePollTimer = null;
      if (scope?.isCurrent()) void syncModuleUpdate();
    }, delay);
  }

  function syncModuleUpdate() {
    const scope = captureInstanceRequest();
    if (!scope) { moduleBusy = false; updateModuleControls(); return Promise.resolve(); }
    const epoch = moduleEpoch;
    if (moduleSync?.pending && moduleSync.epoch === epoch && moduleSync.scope.isCurrent()) return moduleSync.promise;
    const load = { scope, epoch, pending: true };
    moduleSync = load;
    load.promise = (async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: "GET_MODULE_UPDATE", instanceId: scope.instance.id });
        if (!scope.isCurrent() || epoch !== moduleEpoch || moduleSync !== load) return;
        if (!response?.ok) throw new Error(response?.error || msg("common.moduleTaskQueryFailed"));
        applyModuleState(response);
        if (response.error) throw new Error(response.error);
        moduleRetryDelay = 1000;
      } catch {
        if (!scope.isCurrent() || epoch !== moduleEpoch || moduleSync !== load) return;
        moduleBusy = true;
        moduleCanDismiss = false;
        moduleTaskActions.hidden = false;
        showModulesNotice(msg("common.moduleTaskQueryFailed"), "error");
        updateModuleControls();
        scheduleModulePoll(moduleRetryDelay);
        moduleRetryDelay = Math.min(moduleRetryDelay * 2, 30000);
      } finally { load.pending = false; }
    })();
    return load.promise;
  }

  function applyModuleState(state) {
    const task = state.task;
    if (task && (task.instanceId !== activeInstance?.id || Number(task.sequence) < moduleSequence)) return;
    const previous = moduleTask;
    moduleTask = task || null;
    if (task) moduleSequence = Number(task.sequence) || 0;
    moduleCanDismiss = Boolean(state.canDismiss);
    moduleBusy = Boolean(state.error) || ["submitting", "running", "unknown"].includes(task?.status);
    moduleTaskActions.hidden = !moduleBusy;
    if (previous?.id !== task?.id || previous?.sequence !== task?.sequence || task?.status !== "unknown") {
      delete moduleTaskDismiss.dataset.armed;
      moduleTaskDismiss.textContent = msg("popup.clearUnknownResult");
    }
    updateModuleControls();
    if (!task) { hideModulesNotice(); return; }
    if (["submitting", "running"].includes(task.status)) {
      showModulesUpdating();
      if (!state.error) scheduleModulePoll();
      return;
    }
    if (task.status === "unknown") {
      showModulesNotice(task.error || msg("popup.moduleUpdateOutcomeUnknown"), "error");
      if (previous?.id !== task.id || previous?.status !== task.status) void loadModulesList();
      if (!state.error) scheduleModulePoll(5000);
      return;
    }
    if (task.status !== "succeeded") {
      showModulesNotice(statusError(task), "error");
    } else {
      showModulesNotice(msg("popup.modulesUpdated"), "");
      if (moduleInstallPending?.id === task.id && moduleInstallPending.taskNamespace === task.taskNamespace) {
        if (moduleNameInput.value.trim() === moduleInstallPending.name && moduleUrlInput.value.trim() === moduleInstallPending.url) {
          moduleNameInput.value = "";
          moduleUrlInput.value = "";
        }
        moduleInstallPending = null;
      }
    }
    if (previous?.id !== task.id || previous?.status !== task.status) {
      void loadModulesList();
      if (task.status === "succeeded") void loadDashboard({ force: true });
    }
  }

  moduleTaskCheck.addEventListener("click", () => { void Promise.all([syncModuleUpdate(), loadModulesList()]); });
  moduleTaskDismiss.addEventListener("click", async () => {
    const scope = captureInstanceRequest();
    const task = moduleTask;
    if (!scope || !moduleCanDismiss || task?.status !== "unknown") return;
    if (moduleTaskDismiss.dataset.armed !== task.id) {
      moduleTaskDismiss.dataset.armed = task.id;
      moduleTaskDismiss.textContent = msg("popup.confirmClear");
      showModulesNotice(msg("popup.clearingOnlyUnlocksActions"), "error");
      return;
    }
    const epoch = ++moduleEpoch;
    moduleCanDismiss = false;
    updateModuleControls();
    try {
      const response = await chrome.runtime.sendMessage({ type: "DISMISS_UNKNOWN_MODULE_UPDATE", instanceId: scope.instance.id, taskId: task.id, taskSequence: task.sequence });
      if (!scope.isCurrent() || epoch !== moduleEpoch) return;
      if (!response?.ok) throw new Error(response?.error || msg("popup.moduleTaskStateChanged"));
    } catch (error) {
      if (scope.isCurrent() && epoch === moduleEpoch) showModulesNotice(requestErrorText(error), "error");
    } finally {
      if (scope.isCurrent() && epoch === moduleEpoch) void syncModuleUpdate();
    }
  });

  function resolveMemberLatency(groupName, memberName) {
    return leafProbeResults.get(probeResultKey(groupName, memberName)) || null;
  }

  function selectedSummaryChildren(memberName) {
    const { leading, trailing } = splitSelectedSummary(memberName);
    if (!trailing) return [leading];
    return [
      el("span", { className: "current-selected-leading" }, leading),
      el("span", { className: "current-selected-trailing" }, trailing),
    ];
  }

  function displayedPolicyGroups(groups) {
    const normalizedFilter = groupFilterText.toLowerCase();
    const visibleGroups = visiblePolicyGroups(groups, hiddenGroupsMode);
    return normalizedFilter
      ? visibleGroups.filter(
          (g) =>
            g.name.toLowerCase().includes(normalizedFilter) ||
            (g.members || []).some((member) => member.toLowerCase().includes(normalizedFilter)),
        )
      : visibleGroups;
  }

  function renderedGroupNames() {
    return Array.from(groupsContainer.children)
      .filter((child) => child.classList.contains("group-card"))
      .map((card) => card.dataset.group);
  }

  // Render Policy Groups
  function renderGroups(groups) {
    groupBatch.render();
    const normalizedFilter = groupFilterText.toLowerCase();
    const filteredGroups = displayedPolicyGroups(groups);

    if (filteredGroups.length === 0) {
      groupsContainer.replaceChildren(
        el(
          "div",
          { className: "empty-state" },
          normalizedFilter ? msg("popup.noMatchesTryAnother") : msg("popup.instanceNoPolicyGroups"),
        ),
      );
      return;
    }

    groupsContainer.replaceChildren();

    filteredGroups.forEach((group, idx) => {
      const isExpand = normalizedFilter ? true : resolveInitialExpand(group, idx);

      const isOverridden = Boolean(group.override_member);
      const currentSelected =
        group.override_member || group.selected || (group.members && group.members[0]) || "-";

      // Chevron Icon SVG
      const svgIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svgIcon.setAttribute("class", "expand-icon");
      svgIcon.setAttribute("viewBox", "0 0 24 24");
      svgIcon.setAttribute("fill", "none");
      svgIcon.setAttribute("stroke", "currentColor");
      svgIcon.setAttribute("stroke-width", "2");
      const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      polyline.setAttribute("points", "9 18 15 12 9 6");
      svgIcon.appendChild(polyline);

      const testBtn = el(
        "button",
        {
          className: "btn-test-group",
          title: msg("popup.testGroupLatency"),
          dataset: { group: group.name },
          onClick: async (e) => {
            e.stopPropagation();
            const testing = Array.from(activeGroupTests.values()).some(
              (task) => task.groupName === group.name,
            );
            if (testing) {
              await cancelGroupTests(group.name);
            } else {
              await runTestGroup(group.name);
            }
          },
        },
        createFlashIcon(13),
        el("span", { className: "group-test-action-label" }, msg("popup.cancel")),
      );

      const selectedSummaryEl = el(
        "span",
        {
          className: `current-selected${isOverridden ? " pinned" : ""}`,
          title: currentSelected,
          "aria-label": currentSelected,
        },
        ...selectedSummaryChildren(currentSelected),
      );

      const resumeAutoButton = el(
        "button",
        {
          className: "btn-resume-auto",
          title: msg("popup.resumeAutomaticSelection"),
          "aria-label": msg("popup.resumeAutomaticSelection"),
          hidden: !isOverridden,
          onClick: async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await resumeAutomaticSelection(group.name);
          },
          onKeyDown: (event) => event.stopPropagation(),
        },
        el("span", { className: "pin-icon", "aria-hidden": "true" }),
      );

      const hiddenBadge = group.hidden
        ? el(
            "span",
            {
              className: "hidden-kind-badge",
              title: msg("popup.hiddenGroup"),
              "aria-label": msg("popup.hiddenGroup"),
            },
            createEyeOffIcon(11),
          )
        : null;

      const groupType = formatMemberType(group.kind || "select");
      const groupNameEl = el(
        "span",
        {
          className: "group-name",
          title: groupType,
          "aria-label": `${group.name}, ${groupType}`,
        },
        group.name,
      );
      const groupTitleEl = el(
        "div",
        { className: "group-title-wrapper" },
        svgIcon,
        groupNameEl,
        hiddenBadge,
      );

      const headerEl = el(
        "div",
        { className: "group-header" },
        groupTitleEl,
        el(
          "div",
          { className: "group-summary" },
          selectedSummaryEl,
          resumeAutoButton,
          testBtn,
        ),
      );

      // Members List
      const membersContainer = el("div", {
        className: "group-members",
      });

      const memberInfoMap = new Map();
      if (Array.isArray(group.member_info)) {
        group.member_info.forEach((info) => {
          if (info && info.name) memberInfoMap.set(info.name, info);
        });
      }

      const groupNameMatches = group.name.toLowerCase().includes(normalizedFilter);

      (group.members || []).forEach((member) => {
        if (
          normalizedFilter &&
          !groupNameMatches &&
          !member.toLowerCase().includes(normalizedFilter)
        )
          return;
        const isSelected = member === currentSelected;
        const isPinnedMember = isOverridden && member === group.override_member;
        const memberAction = groupMemberAction(group, member);
        const memberInfo = memberInfoMap.get(member);
        const subGroupTarget = currentGroupsData.find((g) => g.name === member);

        // Resolve latency for leaf node or sub-group
        const latencyInfo = resolveMemberLatency(group.name, member);

        const checkMark = el(
          "span",
          { className: `check-mark${isPinnedMember ? " pinned" : ""}` },
          isPinnedMember
            ? el("span", { className: "pin-icon", "aria-hidden": "true" })
            : isSelected
              ? "✓"
              : "",
        );
        const memberNameEl = el("span", { className: "member-name" }, member);

        // Type tag badge (product casing; nested groups use group kind)
        const typeLabel = subGroupTarget
          ? formatMemberType(subGroupTarget.kind || "select")
          : memberTypeLabel(memberInfo);

        const typeTag = typeLabel
          ? el("span", { className: "member-type-tag", title: typeLabel }, typeLabel)
          : null;

        const latencyBadge = el("span", {
          className: "latency-badge",
          onClick: async (e) => {
            e.stopPropagation();
            await runTestGroup(group.name, member);
          },
        });
        applyLatencyBadge(latencyBadge, latencyInfo, { member });

        const avoidance = groupMemberAvoidance(group, memberInfo);
        const avoidToggle = avoidance
          ? el(
              "button",
              {
                type: "button",
                className: `avoid-toggle${avoidance.avoided ? " avoided" : ""}`,
                title: avoidance.avoided ? msg("popup.stopAvoidingAutomaticGroups") : msg("popup.avoidAutomaticGroups"),
                "aria-pressed": String(avoidance.avoided),
                onClick: async (e) => {
                  e.stopPropagation();
                  await toggleAvoidance(
                    group.name,
                    member,
                    !e.currentTarget.classList.contains("avoided"),
                  );
                },
                onKeydown: (e) => e.stopPropagation(),
              },
              avoidance.avoided ? msg("popup.avoided") : msg("popup.avoid"),
            )
          : null;

        // On automatic groups, re-clicking the pinned member clears the override.
        const activateMember = async (event) => {
          const currentGroup = currentGroupsData.find((candidate) => candidate.name === group.name);
          const action = groupMemberAction(currentGroup, member);
          if (action === "none") return;
          if (shouldCollapseGroupAfterSelection(collapseGroupAfterSelection, event)) {
            groupCard.classList.remove("expanded");
            headerEl.setAttribute("aria-expanded", "false");
            void persistGroupExpandState(group.name, false);
          }
          if (action === "auto") {
            await resumeAutomaticSelection(group.name);
            return;
          }
          if (action === "select") await selectMember(group.name, member);
        };

        const memberItem = el(
          "div",
          {
            className: `member-item ${isSelected ? "selected" : ""}${isPinnedMember ? " pinned" : ""}`,
            dataset: { group: group.name, member: member },
            title: isPinnedMember ? msg("popup.clickAgainResumeAutomatic") : undefined,
            "aria-label": isPinnedMember ? msg("popup.resumeAutomaticSelection") : msg("popup.selectMember", { member }),
            "aria-pressed": isSelected || isPinnedMember,
            tabindex: memberAction !== "none" ? "0" : undefined,
            role: memberAction !== "none" ? "button" : undefined,
            onClick: activateMember,
          },
          el("div", { className: "member-left" }, checkMark, memberNameEl, typeTag),
          el("div", { className: "member-right" }, avoidToggle, latencyBadge),
        );
        attachKeyboardActivate(memberItem, activateMember);

        membersContainer.appendChild(memberItem);
      });

      const groupCard = el(
        "div",
        {
          className: `group-card ${isExpand ? "expanded" : ""}${isOverridden ? " overridden" : ""}${selectingGroups.get(group.name)?.isCurrent() ? " selection-busy" : ""}`,
          dataset: { group: group.name },
        },
        headerEl,
        membersContainer,
      );

      headerEl.setAttribute("tabindex", "0");
      headerEl.setAttribute("role", "button");
      headerEl.setAttribute("aria-expanded", String(isExpand));

      const toggleExpand = () => {
        groupCard.classList.toggle("expanded");
        const nowExpanded = groupCard.classList.contains("expanded");
        headerEl.setAttribute("aria-expanded", String(nowExpanded));
        void persistGroupExpandState(group.name, nowExpanded);
      };

      headerEl.addEventListener("click", (e) => {
        if (e.target.closest(".btn-test-group, .btn-resume-auto")) return;
        toggleExpand();
      });

      attachKeyboardActivate(headerEl, toggleExpand);

      groupsContainer.appendChild(groupCard);
    });
    syncGroupTestButtons();
  }

  /** Re-fetch groups and patch existing cards when the visible group set is stable. */
  async function refreshGroupsSelectionState(groupName = null) {
    const scope = captureInstanceRequest();
    const sequence = ++groupReadSequence;
    const previousVisible = renderedGroupNames();
    const groupsData = await SpikeApiClient.getGroups(scope.instance);
    if (!scope.isCurrent() || sequence !== groupReadSequence) return false;
    currentGroupsData = groupsData.groups || [];
    groupBatch.observeRevision(groupsData.revision);
    ingestPersistedMemberInfo(leafProbeResults, currentGroupsData);
    const nextVisible = displayedPolicyGroups(currentGroupsData).map(
      (group) => group.name,
    );
    const visibleGroupsStable =
      previousVisible.length === nextVisible.length &&
      previousVisible.every((name, index) => name === nextVisible[index]);
    if (groupName != null && visibleGroupsStable) {
      document.querySelectorAll(".group-card").forEach((groupCard) => {
        const group = currentGroupsData.find((candidate) => candidate.name === groupCard.dataset.group);
        if (group) paintSelection(groupCard, group);
      });
    } else {
      renderGroups(currentGroupsData);
    }
    updateAllLatencyBadgesDOM();
    return true;
  }

  function paintSelection(groupCard, group) {
    if (!groupCard || !group) return;
    const memberName =
      group.override_member || group.selected || (group.members && group.members[0]) || "-";
    const isOverridden = Boolean(group.override_member);
    const memberInfoMap = new Map();
    if (Array.isArray(group.member_info)) {
      group.member_info.forEach((info) => {
        if (info && info.name) memberInfoMap.set(info.name, info);
      });
    }
    groupCard.classList.toggle("overridden", isOverridden);
    groupCard.querySelectorAll(".member-item").forEach((item) => {
      const isTarget = item.dataset.member === memberName;
      const isPinned = item.dataset.member === group.override_member;
      const memberAction = groupMemberAction(group, item.dataset.member);
      item.classList.toggle("selected", isTarget);
      item.classList.toggle("pinned", isPinned);
      item.title = isPinned ? msg("popup.clickAgainResumeAutomatic") : "";
      item.setAttribute("aria-label", isPinned ? msg("popup.resumeAutomaticSelection") : msg("popup.selectMember", { member: item.dataset.member }));
      if (memberAction === "none") {
        item.removeAttribute("role");
        item.removeAttribute("tabindex");
        item.removeAttribute("aria-pressed");
      } else {
        item.setAttribute("role", "button");
        item.setAttribute("tabindex", "0");
        item.setAttribute("aria-pressed", String(isTarget || isPinned));
      }
      const check = item.querySelector(".check-mark");
      if (check) {
        check.classList.toggle("pinned", isPinned);
        check.replaceChildren(
          isPinned
            ? el("span", { className: "pin-icon", "aria-hidden": "true" })
            : document.createTextNode(isTarget ? "✓" : ""),
        );
      }
      const avoidToggle = item.querySelector(".avoid-toggle");
      if (avoidToggle) {
        const avoidance = groupMemberAvoidance(group, memberInfoMap.get(item.dataset.member));
        const isAvoided = Boolean(avoidance?.avoided);
        avoidToggle.classList.toggle("avoided", isAvoided);
        avoidToggle.title = isAvoided
          ? msg("popup.stopAvoidingAutomaticGroups")
          : msg("popup.avoidAutomaticGroups");
        avoidToggle.setAttribute("aria-pressed", String(isAvoided));
        avoidToggle.textContent = isAvoided ? msg("popup.avoided") : msg("popup.avoid");
      }
    });
    const selectedSummary = groupCard.querySelector(".current-selected");
    if (selectedSummary) {
      selectedSummary.replaceChildren(...selectedSummaryChildren(memberName));
      selectedSummary.title = memberName;
      selectedSummary.setAttribute("aria-label", memberName);
      selectedSummary.classList.toggle("pinned", isOverridden);
    }
    const resumeButton = groupCard.querySelector(".btn-resume-auto");
    if (resumeButton) resumeButton.hidden = !isOverridden;
  }

  function finishGroupSelection(groupName, scope, groupCard) {
    if (selectingGroups.get(groupName) !== scope) return;
    selectingGroups.delete(groupName);
    groupCard?.classList.remove("selection-busy");
    if (scope.isCurrent()) {
      document
        .querySelector(`.group-card[data-group="${CSS.escape(groupName)}"]`)
        ?.classList.remove("selection-busy");
    }
  }

  async function toggleAvoidance(groupName, memberName, avoid) {
    const scope = captureInstanceRequest();
    if (!scope.instance) return;
    try {
      await SpikeApiClient.setPolicyAvoidance(scope.instance, memberName, avoid);
      if (!scope.isCurrent()) return;
      await refreshGroupsSelectionState(null);
    } catch (err) {
      if (!scope.isCurrent()) return;
      showToast(msg("popup.failedUpdateAvoidanceError", { error: requestErrorText(err) || err }), "error");
    }
  }

  async function selectMember(groupName, memberName) {
    const scope = captureInstanceRequest();
    if (!scope.instance || selectingGroups.get(groupName)?.isCurrent()) return;
    selectingGroups.set(groupName, scope);

    const groupCard = document.querySelector(`.group-card[data-group="${CSS.escape(groupName)}"]`);
    const group = currentGroupsData.find((g) => g.name === groupName);
    const optimisticGroup = group
      ? {
          ...group,
          selected: memberName,
          override_member: isAutomaticGroupKind(group.kind) ? memberName : group.override_member,
        }
      : null;
    groupCard?.classList.add("selection-busy");
    paintSelection(groupCard, optimisticGroup);

    try {
      const selection = await SpikeApiClient.selectGroupMember(
        scope.instance,
        groupName,
        memberName,
        disconnectAffectedConnectionsOnSelection,
      );
      if (!scope.isCurrent()) return;

      if (group) {
        group.selected = selection?.member || memberName;
        if (isAutomaticGroupKind(group.kind)) {
          group.override_member = selection?.member || memberName;
          group.selection_basis = "manual_override";
        }
        paintSelection(groupCard, group);
      }

      try {
        await refreshGroupsSelectionState(groupName);
      } catch {
        if (!scope.isCurrent()) return;
        updateAllLatencyBadgesDOM();
      }
    } catch (err) {
      if (!scope.isCurrent()) return;
      showToast(msg("popup.failedSwitchNodeError", { error: requestErrorText(err) || err }), "error");
      try {
        await refreshGroupsSelectionState(groupName);
      } catch {
        if (!scope.isCurrent()) return;
        const group = currentGroupsData.find((g) => g.name === groupName);
        paintSelection(groupCard, group);
      }
    } finally {
      finishGroupSelection(groupName, scope, groupCard);
    }
  }

  /** Clear pin/override and resume url-test / fallback / smart automatic selection. */
  async function resumeAutomaticSelection(groupName) {
    const scope = captureInstanceRequest();
    if (!scope.instance || selectingGroups.get(groupName)?.isCurrent()) return;
    selectingGroups.set(groupName, scope);
    const groupCard = document.querySelector(`.group-card[data-group="${CSS.escape(groupName)}"]`);
    groupCard?.classList.add("selection-busy");
    try {
      const selection = await SpikeApiClient.clearGroupSelection(
        scope.instance,
        groupName,
        disconnectAffectedConnectionsOnSelection,
      );
      if (!scope.isCurrent()) return;
      const group = currentGroupsData.find((candidate) => candidate.name === groupName);
      if (group) {
        group.override_member = null;
        group.selected = selection?.member || group.selected;
        group.selection_basis = null;
        paintSelection(groupCard, group);
      }
      try {
        await refreshGroupsSelectionState(groupName);
      } catch (err) {
        if (!scope.isCurrent()) return;
        updateAllLatencyBadgesDOM();
        showToast(msg("popup.automaticSelectionResumedStatus"));
        console.warn(`Cleared override but failed to refresh groups: ${err.message}`);
      }
    } catch (err) {
      if (!scope.isCurrent()) return;
      showToast(msg("popup.failedResumeAutomaticSelection", { error: requestErrorText(err) || err }), "error");
    } finally {
      finishGroupSelection(groupName, scope, groupCard);
    }
  }

  // Latency Testing with visual feedback
  async function cancelGroupTests(groupName) {
    const scope = captureGroupTestRequest();
    if (!scope.instance || cancellingGroupTests.get(groupName)?.isCurrent()) return;
    const taskIds = Array.from(activeGroupTests.entries())
      .filter(([, task]) => task.groupName === groupName)
      .map(([taskId]) => taskId);
    if (taskIds.length === 0) return;

    cancellingGroupTests.set(groupName, scope);
    syncGroupTestButtons();
    try {
      for (const taskId of taskIds) {
        const result = await chrome.runtime.sendMessage({
          type: "CANCEL_GROUP_TEST",
          instanceId: scope.instance.id,
          taskId,
        });
        if (!scope.isCurrent()) return;
        if (!result?.ok) throw new Error(requestErrorText(result) || "Unable to cancel group test");
        applyGroupTestState(result.tasks);
      }
      showToast(msg("popup.testCancellationRequested"), "success");
    } catch (err) {
      if (!scope.isCurrent()) return;
      showToast(msg("popup.failedCancelTestError", { error: requestErrorText(err) || err }), "error");
      await restoreRecentGroupTests();
    } finally {
      if (cancellingGroupTests.get(groupName) === scope) {
        cancellingGroupTests.delete(groupName);
        if (scope.isCurrent()) syncGroupTestButtons();
      }
    }
  }

  async function runTestGroup(groupName, targetMember = null) {
    if (groupBatch.reserved.includes(groupName)) return;
    const scope = { ...captureGroupTestRequest(), groupName };
    const operationKey = `${groupName}\0${targetMember || "*"}`;
    if (!scope.instance || submittingGroupTests.get(operationKey)?.isCurrent() || cancellingGroupTests.get(groupName)?.isCurrent()) return;
    const duplicate = Array.from(activeGroupTests.values()).some(
      (task) => task.groupName === groupName && (task.targetMember || null) === targetMember,
    );
    if (duplicate) return;
    if (!targetMember && Array.from(activeGroupTests.values()).some((task) => task.groupName === groupName)) return;
    submittingGroupTests.set(operationKey, scope);
    syncGroupTestButtons();

    // Update target badges to "Testing..." spinner status immediately
    setGroupBadgesTesting(groupName, targetMember);

    try {
      const result = await chrome.runtime.sendMessage({
        type: "START_GROUP_TEST",
        instanceId: scope.instance.id,
        groupName,
        memberName: targetMember,
      });
      if (!scope.isCurrent()) return;
      if (!result?.ok) throw new Error(requestErrorText(result) || "Unable to start group test");
      if (result.mode === "async") {
        activeGroupTests.set(result.task.id, {
          groupName,
          targetMember,
          completedMembers: new Set(),
        });
        handleGroupTestTask(result.task);
      } else {
        recordProbeResults(leafProbeResults, groupName, result.results);
        updateAllLatencyBadgesDOM();
        await refreshProbeSnapshots();
      }
    } catch (err) {
      if (!scope.isCurrent()) return;
      console.error(`Group test failed: ${err.message}`);
      showToast(msg("popup.unableStartTestError", { error: requestErrorText(err) || err }), "error");
      updateAllLatencyBadgesDOM();
    } finally {
      if (submittingGroupTests.get(operationKey) === scope) {
        submittingGroupTests.delete(operationKey);
        if (scope.isCurrent()) syncGroupTestButtons();
      }
    }
  }

  function setGroupBadgesTesting(groupName, targetMember = null) {
    const groupCard = document.querySelector(`.group-card[data-group="${CSS.escape(groupName)}"]`);
    if (!groupCard) return;

    const badges = groupCard.querySelectorAll(".latency-badge");
    badges.forEach((badge) => {
      const parentItem = badge.closest(".member-item");
      const member = parentItem ? parentItem.dataset.member : null;
      if (!targetMember || member === targetMember) {
        badge.className = "latency-badge lat-testing";
        badge.replaceChildren(el("span", { className: "mini-spinner" }));
      }
    });
  }

  /** Update latency badges across all visible groups and members in DOM */
  function memberProbeIsPending(groupName, memberName, latencyInfo) {
    return Array.from(activeGroupTests.values()).some((task) => {
      if (task.groupName !== groupName) return false;
      if (task.targetMember && task.targetMember !== memberName) return false;
      if (task.completedMembers.has(memberName)) return false;
      return !latencyInfo?.sourceMember || !task.completedMembers.has(latencyInfo.sourceMember);
    });
  }

  function updateAllLatencyBadgesDOM() {
    groupsContainer.querySelectorAll(".member-item").forEach((memberItem) => {
      const groupName = memberItem.dataset.group;
      const member = memberItem.dataset.member;
      const badgeEl = memberItem.querySelector(".latency-badge");
      if (!groupName || !member || !badgeEl) return;

      const latData = resolveMemberLatency(groupName, member);
      const pending = memberProbeIsPending(groupName, member, latData);
      // Avoid rebuilding spinner DOM every poll tick while still testing.
      if (
        pending &&
        badgeEl.classList.contains("lat-testing") &&
        badgeEl.querySelector(".mini-spinner")
      ) {
        return;
      }
      applyLatencyBadge(badgeEl, latData, { member, pending });
    });
  }

  /**
   * Paint a member latency badge: spinner / result text / empty (hover flash).
   */
  function applyLatencyBadge(badgeEl, latInfo, { member = "", pending = false } = {}) {
    if (pending) {
      badgeEl.className = "latency-badge lat-testing";
      badgeEl.title = msg("popup.testing");
      badgeEl.replaceChildren(el("span", { className: "mini-spinner" }));
      return;
    }

    const subGroupTarget = currentGroupsData.find((g) => g.name === member);
    const udpSummary =
      latInfo?.udpOk === true
        ? ` · UDP ${typeof latInfo.udpMs === "number" ? `${latInfo.udpMs}ms` : "ok"}`
        : latInfo?.udpOk === false
          ? ` · UDP ${coreError(latInfo.udp_error_code, undefined, latInfo.udpErr) || msg("common.failed")}`
          : "";
    if (hasLatencyResult(latInfo) && !latInfo.ok) {
      // Failure reason only in native tooltip; badge shows a red "F".
      badgeEl.title = `${coreError(latInfo.error_code, undefined, latInfo.err) || msg("popup.timeout")}${udpSummary}`;
    } else if (subGroupTarget) {
      const subSel = subGroupTarget.override_member || subGroupTarget.selected;
      badgeEl.title = subSel
        ? msg("popup.subgroupTarget", { member, target: subSel })
        : msg("popup.subgroup", { member });
    } else if (hasLatencyResult(latInfo) && latInfo.at) {
      badgeEl.title = msg("popup.testedAt", { time: new Date(latInfo.at).toLocaleTimeString(), udp: udpSummary });
    } else {
      badgeEl.title = msg("popup.testNode");
    }

    if (!hasLatencyResult(latInfo)) {
      badgeEl.className = "latency-badge lat-empty";
      if (!badgeEl.querySelector(".flash-icon")) {
        badgeEl.replaceChildren(createFlashIcon(13));
      }
      return;
    }

    badgeEl.className = `latency-badge ${getLatencyClass(latInfo)}`;
    badgeEl.textContent = formatLatencyText(latInfo);
  }

  function getLatencyClass(latInfo) {
    if (!latInfo) return "lat-empty";
    if (!latInfo.ok) return "lat-error";
    if (typeof latInfo.ms !== "number") return "lat-error";
    if (latInfo.ms < 120) return "lat-fast";
    if (latInfo.ms < 300) return "lat-medium";
    return "lat-slow";
  }

  function formatLatencyText(latInfo) {
    if (!hasLatencyResult(latInfo)) return "";
    if (!latInfo.ok) return "F";
    if (typeof latInfo.ms === "number") return `${latInfo.ms}ms`;
    return "";
  }

  function applyEventAction(hash) {
    switch (hash) {
      case '#event-providers':
        void openProvidersPanel().catch(() => showToast(msg("popup.unableOpenExternalResources"), 'error'));
        return true;
      case '#event-config':
        setQuickPanel('profile'); quickPanelProfile.scrollIntoView({ block: 'start' }); return true;
      case '#event-groups':
        groupsContainer.scrollIntoView({ block: 'start' }); return true;
      case '#event-overview': window.scrollTo(0, 0); return true;
      default: return false;
    }
  }

  // Initial load
  void syncModuleUpdate();
  void syncProviderRefreshTask();
  void loadDashboard()
    .catch((error) => console.warn(`Unable to load dashboard: ${error.message}`))
    .then(() => applyEventAction(window.location?.hash));
  void refreshTraffic();
  trafficTimer = setInterval(() => {
    void refreshTraffic();
  }, 1000);
  window.addEventListener("pagehide", () => {
    moduleEpoch += 1;
    moduleListRead += 1;
    if (modulePollTimer !== null) clearTimeout(modulePollTimer);
    if (trafficTimer !== null) clearInterval(trafficTimer);
    try {
      trafficPort.disconnect();
    } catch {
      // Popup teardown.
    }
  });
});
