import { messageMatches } from "./i18n.js";

const INTERACTION_STATE_KEY = "popupInteractionState";
const RESTORE_WINDOW_MS = 2500;
const UNDO_WINDOW_MS = 7000;

const COPYABLE_SELECTOR = [
  ".proxy-listener-value",
  ".proxy-listener-address",
  ".provider-origin",
  ".profile-value",
  ".error-message",
  ".provider-error",
  ".providers-panel-notice.error",
  ".providers-empty.error",
  "[data-copyable]",
].join(",");

export function nextNavigationIndex(index, key, length) {
  if (!Number.isInteger(length) || length <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowDown") return Math.min(Math.max(index, -1) + 1, length - 1);
  if (key === "ArrowUp") return Math.max(index <= 0 ? 0 : index - 1, 0);
  return index;
}

export function splitMatchSegments(text, query) {
  const source = String(text ?? "");
  const needle = String(query ?? "").trim();
  if (!needle) return [{ text: source, match: false }];

  const result = [];
  const lowerSource = source.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  let cursor = 0;
  while (cursor < source.length) {
    const index = lowerSource.indexOf(lowerNeedle, cursor);
    if (index < 0) {
      result.push({ text: source.slice(cursor), match: false });
      break;
    }
    if (index > cursor) {
      result.push({ text: source.slice(cursor, index), match: false });
    }
    result.push({ text: source.slice(index, index + needle.length), match: true });
    cursor = index + needle.length;
  }
  return result.length ? result : [{ text: source, match: false }];
}

function isElementVisible(element) {
  return Boolean(
    element &&
      !element.hidden &&
      element.style.display !== "none" &&
      element.getAttribute("aria-hidden") !== "true",
  );
}

function panelControls() {
  return Array.from(
    document.querySelectorAll(
      ".quick-tab[aria-controls], #btn-modules[aria-controls], #btn-refresh-providers[aria-controls]",
    ),
  )
    .map((control) => ({
      control,
      panel: document.getElementById(control.getAttribute("aria-controls")),
    }))
    .filter(({ panel }) => panel && panel.id !== "filter-bar");
}

function focusFirstPanelControl(panel) {
  const target = panel.querySelector(
    "input:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
  );
  target?.focus({ preventScroll: true });
}

function describeFocus(element) {
  if (!(element instanceof Element)) return null;
  if (element.id) return { id: element.id };
  const member = element.closest(".member-item");
  if (member) {
    return { group: member.dataset.group, member: member.dataset.member };
  }
  const group = element.closest(".group-card");
  if (group?.dataset.group) return { group: group.dataset.group };
  return null;
}

function findFocusTarget(descriptor) {
  if (!descriptor) return null;
  if (descriptor.id) return document.getElementById(descriptor.id);
  const cards = Array.from(document.querySelectorAll(".group-card"));
  const card = cards.find((candidate) => candidate.dataset.group === descriptor.group);
  if (!card) return null;
  if (!descriptor.member) return card.querySelector(".group-header");
  return Array.from(card.querySelectorAll(".member-item")).find(
    (candidate) => candidate.dataset.member === descriptor.member,
  );
}

function installGroupKeyboardNavigation() {
  document.addEventListener("keydown", (event) => {
    const current = event.target.closest?.(".group-header, .member-item");
    if (!current) return;
    const card = current.closest(".group-card");

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (current.classList.contains("member-item")) {
        card?.querySelector(".group-header")?.focus();
      } else if (current.getAttribute("aria-expanded") === "true") {
        current.click();
      }
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (current.classList.contains("group-header")) {
        if (current.getAttribute("aria-expanded") !== "true") current.click();
        requestAnimationFrame(() => {
          const firstMember = Array.from(card?.querySelectorAll(".member-item") || []).find(
            isElementVisible,
          );
          firstMember?.focus();
        });
      }
      return;
    }

    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const navigable = Array.from(
      document.querySelectorAll(".group-header, .member-item"),
    ).filter((element) => isElementVisible(element) && isElementVisible(element.closest(".group-card")));
    const index = navigable.indexOf(current);
    const next = nextNavigationIndex(index, event.key, navigable.length);
    if (next < 0 || next === index) return;
    event.preventDefault();
    navigable[next].focus({ preventScroll: true });
    navigable[next].scrollIntoView({ block: "nearest" });
  });
}

function installPanelFocusManagement() {
  let lastTrigger = null;
  for (const { control, panel } of panelControls()) {
    control.addEventListener("click", () => {
      lastTrigger = control;
      setTimeout(() => {
        if (isElementVisible(panel)) focusFirstPanelControl(panel);
      }, 0);
    });

    new MutationObserver(() => {
      if (isElementVisible(panel)) return;
      if (panel.contains(document.activeElement)) lastTrigger?.focus({ preventScroll: true });
    }).observe(panel, { attributes: true, attributeFilter: ["hidden", "class", "style"] });
  }
}

function installSearchFeedback(announce) {
  const input = document.getElementById("group-filter");
  const groups = document.getElementById("groups-container");
  const summary = document.getElementById("filter-summary");
  if (!input || !groups || !summary) return;

  let decoratedQuery = null;
  let scheduled = false;

  const clearHighlights = () => {
    for (const mark of groups.querySelectorAll("mark.search-highlight")) {
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
    }
    groups.normalize();
  };

  const update = () => {
    scheduled = false;
    const query = input.value.trim();
    if (query !== decoratedQuery) {
      clearHighlights();
      decoratedQuery = query;
      if (query) {
        for (const label of groups.querySelectorAll(".group-name, .member-name")) {
          const segments = splitMatchSegments(label.textContent, query);
          if (!segments.some((segment) => segment.match)) continue;
          label.replaceChildren(
            ...segments.map((segment) => {
              if (!segment.match) return document.createTextNode(segment.text);
              const mark = document.createElement("mark");
              mark.className = "search-highlight";
              mark.textContent = segment.text;
              return mark;
            }),
          );
        }
      }
    }

    if (!query) {
      summary.hidden = true;
      summary.textContent = "";
      return;
    }
    const visibleGroups = Array.from(groups.querySelectorAll(".group-card")).filter(isElementVisible);
    const visibleMembers = visibleGroups.flatMap((card) =>
      Array.from(card.querySelectorAll(".member-item")).filter(isElementVisible),
    );
    summary.textContent = `${visibleGroups.length} 个策略组 · ${visibleMembers.length} 个节点`;
    summary.hidden = false;
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(update);
  };
  input.addEventListener("input", schedule);
  input.addEventListener("search", schedule);
  new MutationObserver(schedule).observe(groups, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "style", "class"],
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") announce(summary.textContent || "没有匹配项");
  });
}

function installTaskHub(announce) {
  const hub = document.getElementById("runtime-task-hub");
  const list = document.getElementById("runtime-task-list");
  if (!hub || !list) return;
  let scheduled = false;

  const openPanel = (panelId) => {
    const pair = panelControls().find(({ panel }) => panel.id === panelId);
    pair?.control.click();
  };

  const render = () => {
    scheduled = false;
    const rows = [];
    const providerButton = document.querySelector(".btn-provider-refresh.testing, #btn-refresh-providers.testing");
    if (providerButton) {
      const row = document.createElement("div");
      row.className = "runtime-task-item";
      row.innerHTML = "<span>资源更新 · 运行中</span>";
      const view = document.createElement("button");
      view.type = "button";
      view.className = "btn-task-action";
      view.textContent = "查看";
      view.addEventListener("click", () => openPanel("providers-panel"));
      row.append(view);
      rows.push(row);
    }

    const moduleNotice = document.getElementById("modules-panel-notice");
    if (messageMatches(moduleNotice?.textContent, "正在更新模块…")) {
      const row = document.createElement("div");
      row.className = "runtime-task-item";
      row.innerHTML = "<span>模块更新 · 运行中</span>";
      const view = document.createElement("button");
      view.type = "button";
      view.className = "btn-task-action";
      view.textContent = "查看";
      view.addEventListener("click", () => openPanel("modules-panel"));
      row.append(view);
      rows.push(row);
    }

    list.replaceChildren(...rows);
    hub.hidden = rows.length === 0;
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(render);
  };
  new MutationObserver((records) => {
    if (records.every((record) => hub.contains(record.target))) return;
    schedule();
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "hidden"],
    characterData: true,
  });
  render();
}

function installOutboundWarning(announce) {
  const banner = document.getElementById("outbound-safety-banner");
  const label = document.getElementById("outbound-safety-label");
  const restore = document.getElementById("btn-restore-rule-mode");
  if (!banner || !label || !restore) return;

  const activeMode = () => {
    const active = document.querySelector(".btn-outbound-mode.active, .btn-outbound-mode[aria-pressed='true']");
    return active?.dataset.mode || active?.dataset.value || null;
  };
  const update = () => {
    const mode = activeMode();
    banner.hidden = !mode || mode === "rule";
    if (!banner.hidden) {
      label.textContent = mode === "direct" ? "当前为全部直连模式" : "当前为全局代理模式";
    }
  };
  restore.addEventListener("click", () => {
    const rule = Array.from(document.querySelectorAll(".btn-outbound-mode")).find(
      (button) => (button.dataset.mode || button.dataset.value) === "rule",
    );
    rule?.click();
    announce("正在恢复规则模式");
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest?.(".btn-outbound-mode")) setTimeout(update, 0);
  });
  new MutationObserver(update).observe(document.getElementById("outbound-mode-card") || document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "aria-pressed"],
  });
  update();
}

function installSelectionFeedback(announce) {
  const banner = document.getElementById("selection-impact-banner");
  const message = document.getElementById("selection-impact-message");
  const undo = document.getElementById("btn-undo-selection");
  if (!banner || !message || !undo) return;
  let undoTimer = null;
  let undoTarget = null;

  const hide = () => {
    clearTimeout(undoTimer);
    undoTimer = null;
    undoTarget = null;
    banner.hidden = true;
  };

  document.addEventListener("click", (event) => {
    const member = event.target.closest?.(".member-item");
    if (!member || event.target.closest("button")) return;
    const card = member.closest(".group-card");
    const currentName = card?.querySelector(".current-selected")?.textContent?.trim();
    const nextName = member.querySelector(".member-name")?.textContent?.trim() || member.dataset.member;
    if (!card || !currentName || !nextName || currentName === nextName) return;
    undoTarget = Array.from(card.querySelectorAll(".member-item")).find(
      (candidate) =>
        (candidate.dataset.member || candidate.querySelector(".member-name")?.textContent?.trim()) === currentName,
    );
    message.textContent = `已请求切换到 ${nextName}；仅影响新连接`;
    undo.hidden = !undoTarget;
    banner.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hide, UNDO_WINDOW_MS);
    announce(message.textContent);
  });

  undo.addEventListener("click", () => {
    if (!undoTarget?.isConnected) return hide();
    const name = undoTarget.querySelector(".member-name")?.textContent?.trim() || undoTarget.dataset.member;
    undoTarget.click();
    announce(`正在恢复到 ${name}`);
    hide();
  });
}

function installCopyAndOverflow(announce) {
  let scheduled = false;
  const decorate = () => {
    scheduled = false;
    for (const element of document.querySelectorAll(
      ".quick-tab-value, .current-selected, .member-name, .group-name",
    )) {
      if (element.scrollWidth > element.clientWidth && !element.title) {
        element.title = element.textContent.trim();
      }
    }
    for (const element of document.querySelectorAll(COPYABLE_SELECTOR)) {
      if (!element.textContent?.trim()) continue;
      element.classList.add("copyable-value");
      element.tabIndex = element.tabIndex < 0 ? 0 : element.tabIndex;
      element.setAttribute("role", "button");
      element.setAttribute("aria-label", `复制 ${element.textContent.trim()}`);
      if (!element.title) element.title = "点击复制";
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(decorate);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", schedule);
  schedule();

  const copy = async (element) => {
    const text = element.textContent?.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      announce("已复制");
    } catch {
      announce("复制失败，请手动选择文本");
    }
  };
  document.addEventListener("click", (event) => {
    const element = event.target.closest?.(COPYABLE_SELECTOR);
    if (element) void copy(element);
  });
  document.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    const element = event.target.closest?.(COPYABLE_SELECTOR);
    if (!element) return;
    event.preventDefault();
    void copy(element);
  });
}

function installPopupSessionPersistence(getInstanceId) {
  const session = globalThis.chrome?.storage?.session;
  if (!session) return;
  let restored = false;
  let pendingFocus = null;
  const startedAt = Date.now();

  void session.get([INTERACTION_STATE_KEY]).then((data) => {
    const state = data?.[INTERACTION_STATE_KEY];
    if (!state || state.instanceId !== getInstanceId()) return;
    const pair = panelControls().find(({ panel }) => panel.id === state.panelId);
    if (pair && !isElementVisible(pair.panel)) pair.control.click();
    requestAnimationFrame(() => window.scrollTo({ top: Number(state.scrollTop) || 0 }));
    pendingFocus = state.focus || null;
  }).catch(() => {});

  const restoreFocus = () => {
    if (restored || !pendingFocus || Date.now() - startedAt > RESTORE_WINDOW_MS) return;
    if (document.activeElement && ![document.body, document.documentElement].includes(document.activeElement)) {
      restored = true;
      return;
    }
    const target = findFocusTarget(pendingFocus);
    if (!target || !isElementVisible(target)) return;
    target.focus({ preventScroll: true });
    restored = true;
  };
  new MutationObserver(restoreFocus).observe(document.body, { childList: true, subtree: true });
  setTimeout(restoreFocus, 0);

  const persist = () => {
    const openPanel = panelControls().find(({ panel }) => isElementVisible(panel))?.panel?.id || null;
    void session.set({
      [INTERACTION_STATE_KEY]: {
        instanceId: getInstanceId(),
        panelId: openPanel,
        scrollTop: document.scrollingElement?.scrollTop || window.scrollY || 0,
        focus: describeFocus(document.activeElement),
      },
    }).catch(() => {});
  };
  window.addEventListener("pagehide", persist);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persist();
  });
}

export function installPopupInteractions({ getInstanceId }) {
  const announcer = document.getElementById("popup-announcer");
  const announce = (message) => {
    if (!announcer || !message) return;
    announcer.textContent = "";
    requestAnimationFrame(() => {
      announcer.textContent = message;
    });
  };

  installGroupKeyboardNavigation();
  installPanelFocusManagement();
  installSearchFeedback(announce);
  installTaskHub(announce);
  installOutboundWarning(announce);
  installSelectionFeedback(announce);
  installCopyAndOverflow(announce);
  installPopupSessionPersistence(getInstanceId);

  return { announce };
}
