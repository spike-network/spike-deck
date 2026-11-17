import { StorageManager } from "./lib/storage.js";
import { confirmAction } from "./lib/confirm-dialog.js";
import { initializeOptionsTabs } from "./lib/options-tabs.js";
import { SpikeApiClient } from "./lib/spike-client.js";
import { canSendSecret, ensureHostPermission } from "./lib/permissions.js";
import {
  proxyListenerSummary,
  proxyListenersFromStatus,
} from "./lib/proxy-listeners.js";
import { describePopupShortcut } from "./lib/shortcut-state.js";
import {
  applyMessages,
  getCurrentLanguage,
  initializeI18n,
  msg,
  setCurrentLanguage,
  setMessage,
  setPlainText,
} from "./lib/i18n.js";

document.addEventListener("DOMContentLoaded", async () => {
  initializeOptionsTabs(document, window);
  // Every string on this page is keyed, so no document observer is needed.
  await initializeI18n({ observe: false });
  await StorageManager.init();

  const instancesContainer = document.getElementById("instances-container");
  const btnAddInstance = document.getElementById("btn-add-instance");
  const instanceForm = document.getElementById("instance-form");
  const formTitle = document.getElementById("form-title");
  const prefLanguageSelect = document.getElementById("pref-language");

  const instIdInput = document.getElementById("inst-id");
  const instNameInput = document.getElementById("inst-name");
  const instUrlInput = document.getElementById("inst-url");
  const instSecretInput = document.getElementById("inst-secret");

  const btnTestConn = document.getElementById("btn-test-conn");
  const btnDeleteInst = document.getElementById("btn-delete-inst");
  const testResultEl = document.getElementById("test-result");

  const prefExpandModeSelect = document.getElementById("pref-expand-mode");
  const prefHiddenModeSelect = document.getElementById("pref-hidden-mode");
  const prefControlProxyCheckbox =
    document.getElementById("pref-control-proxy");
  const prefPopupShortcutCheckbox = document.getElementById(
    "pref-popup-shortcut",
  );
  const prefCollapseAfterSelectionCheckbox = document.getElementById(
    "pref-collapse-after-selection",
  );
  const prefDisconnectAffectedConnectionsCheckbox = document.getElementById(
    "pref-disconnect-affected-connections",
  );
  const prefHealthIntervalInput = document.getElementById(
    "pref-health-interval",
  );
  const prefTrafficIntervalInput = document.getElementById(
    "pref-traffic-interval",
  );
  const proxyPreferenceState = document.getElementById(
    "proxy-preference-state",
  );
  const popupShortcutState = document.getElementById("popup-shortcut-state");

  let instances = [];
  let activeInstanceId = "";
  let editingId = null;
  let isCreating = false;

  // Load preferences
  prefLanguageSelect.value = getCurrentLanguage();
  prefLanguageSelect.addEventListener("change", async (event) => {
    await setCurrentLanguage(event.target.value);
  });

  const currentExpandMode = await StorageManager.getGroupExpandMode();
  prefExpandModeSelect.value = currentExpandMode;

  const currentHiddenMode = await StorageManager.getHiddenGroupsMode();
  prefHiddenModeSelect.value = currentHiddenMode;

  const currentHealthInterval = await StorageManager.getHealthCheckInterval();
  if (prefHealthIntervalInput)
    prefHealthIntervalInput.value = currentHealthInterval;

  const currentTrafficInterval =
    await StorageManager.getTrafficRefreshInterval();
  if (prefTrafficIntervalInput)
    prefTrafficIntervalInput.value = currentTrafficInterval;

  const currentProxyMode = await StorageManager.isProxyModeEnabled();
  prefControlProxyCheckbox.checked = currentProxyMode;
  void refreshProxyPreferenceState();

  prefPopupShortcutCheckbox.checked =
    await StorageManager.isPopupShortcutEnabled();
  void refreshPopupShortcutState();

  prefCollapseAfterSelectionCheckbox.checked =
    await StorageManager.shouldCollapseGroupAfterSelection();
  prefDisconnectAffectedConnectionsCheckbox.checked =
    await StorageManager.shouldDisconnectAffectedConnectionsOnSelection();

  const profileExportText = document.getElementById("profile-export-text");
  const profileExportStatus = document.getElementById("profile-export-status");
  const btnLoadProfileExport = document.getElementById(
    "btn-load-profile-export",
  );
  const btnCopyProfileExport = document.getElementById(
    "btn-copy-profile-export",
  );

  btnLoadProfileExport.addEventListener("click", async () => {
    profileExportText.textContent = "";
    profileExportText.hidden = true;
    const active = await StorageManager.getActiveInstance();
    if (!active) {
      setMessage(profileExportStatus, "options.export.noInstance");
      return;
    }
    setMessage(profileExportStatus, "options.export.loading");
    try {
      const current = await SpikeApiClient.getCurrentProfile(active);
      profileExportText.textContent = current.profile || "";
      profileExportText.hidden = !current.profile;
      if (current.profile) setPlainText(profileExportStatus, "");
      else if (current.error) setPlainText(profileExportStatus, current.error);
      else setMessage(profileExportStatus, "options.export.empty");
    } catch (error) {
      if (error.message) setPlainText(profileExportStatus, error.message);
      else setMessage(profileExportStatus, "options.export.failed");
    }
  });

  btnCopyProfileExport.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(profileExportText.textContent || "");
      setMessage(btnCopyProfileExport, "options.export.copied");
      setTimeout(() => {
        setMessage(btnCopyProfileExport, "options.export.copy");
      }, 1500);
    } catch {
      profileExportText.setAttribute("data-i18n-title", "options.export.clipboardFailed");
      applyMessages(profileExportText);
    }
  });

  const btnToggleSecret = document.getElementById("btn-toggle-secret");
  btnToggleSecret.addEventListener("click", () => {
    const hidden = instSecretInput.type === "password";
    instSecretInput.type = hidden ? "text" : "password";
    setMessage(btnToggleSecret, hidden ? "options.form.secret.hide" : "options.form.secret.show");
  });

  prefExpandModeSelect.addEventListener("change", async (e) => {
    await StorageManager.setGroupExpandMode(e.target.value);
  });

  prefHiddenModeSelect.addEventListener("change", async (e) => {
    await StorageManager.setHiddenGroupsMode(e.target.value);
  });

  prefPopupShortcutCheckbox.addEventListener("change", async (e) => {
    await StorageManager.setPopupShortcutEnabled(e.target.checked);
    await refreshPopupShortcutState();
  });

  prefCollapseAfterSelectionCheckbox.addEventListener("change", async (e) => {
    await StorageManager.setCollapseGroupAfterSelection(e.target.checked);
  });

  prefDisconnectAffectedConnectionsCheckbox.addEventListener(
    "change",
    async (e) => {
      await StorageManager.setDisconnectAffectedConnectionsOnSelection(
        e.target.checked,
      );
    },
  );

  async function refreshPopupShortcutState() {
    try {
      const [enabled, commands] = await Promise.all([
        StorageManager.isPopupShortcutEnabled(),
        chrome.commands.getAll(),
      ]);
      const state = describePopupShortcut(enabled, commands);
      popupShortcutState.className = state.kind
        ? `proxy-preference-state ${state.kind}`
        : "proxy-preference-state";
      setMessage(popupShortcutState, state.key, state.params);
    } catch (error) {
      popupShortcutState.className = "proxy-preference-state error";
      setMessage(popupShortcutState, "options.shortcut.failed", { error: error.message });
    }
  }

  if (prefHealthIntervalInput) {
    prefHealthIntervalInput.addEventListener("change", async (e) => {
      const saved = await StorageManager.setHealthCheckInterval(e.target.value);
      prefHealthIntervalInput.value = saved;
    });
  }

  if (prefTrafficIntervalInput) {
    prefTrafficIntervalInput.addEventListener("change", async (e) => {
      const saved = await StorageManager.setTrafficRefreshInterval(
        e.target.value,
      );
      prefTrafficIntervalInput.value = saved;
    });
  }

  prefControlProxyCheckbox.addEventListener("change", async (e) => {
    const enabled = e.target.checked;
    prefControlProxyCheckbox.disabled = true;
    proxyPreferenceState.className = "proxy-preference-state";
    setMessage(proxyPreferenceState, enabled ? "options.proxy.applying" : "options.proxy.releasing");
    try {
      await StorageManager.setProxyModeEnabled(enabled);
      const response = await chrome.runtime.sendMessage({
        type: "UPDATE_PROXY_SETTING",
      });
      if (!response || !response.ok) {
        throw new Error(response?.error || msg("options.proxy.updateUnavailable"));
      }
      prefControlProxyCheckbox.checked = await StorageManager.isProxyModeEnabled();
      if (response.superseded) await refreshProxyPreferenceState();
      else renderProxyPreferenceState(response, prefControlProxyCheckbox.checked);
    } catch (err) {
      prefControlProxyCheckbox.checked = await StorageManager.isProxyModeEnabled();
      proxyPreferenceState.className = "proxy-preference-state error";
      setMessage(proxyPreferenceState, "options.proxy.updateFailed", { error: err.message });
    } finally {
      prefControlProxyCheckbox.disabled = false;
    }
  });

  async function loadData() {
    instances = await StorageManager.getInstances();
    const active = await StorageManager.getActiveInstance();
    activeInstanceId = active ? active.id : "";

    if (instances.length === 0) {
      isCreating = true;
      editingId = null;
      setMessage(formTitle, "options.form.addFirstTitle");
      instIdInput.value = "";
      instNameInput.value = "";
      instUrlInput.value = "http://127.0.0.1:9090";
      instSecretInput.value = "";
      btnDeleteInst.style.display = "none";
      renderInstancesList();
      return;
    }

    renderInstancesList();
    if (!editingId && !isCreating && active) {
      selectInstanceForEdit(active.id);
    }
  }

  function renderInstancesList() {
    instancesContainer.replaceChildren();

    if (instances.length === 0 && !isCreating) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "instances-empty";
      setMessage(emptyDiv, "options.instances.empty");
      instancesContainer.appendChild(emptyDiv);
      return;
    }

    // Render existing instances
    instances.forEach((inst) => {
      const isActive = inst.id === activeInstanceId;
      const isEditing = !isCreating && inst.id === editingId;

      const nameSpan = document.createElement("span");
      nameSpan.className = "instance-name";
      nameSpan.textContent = inst.name;

      const urlSpan = document.createElement("span");
      urlSpan.className = "instance-url";
      urlSpan.textContent = inst.baseUrl;

      const infoDiv = document.createElement("div");
      infoDiv.className = "instance-info";
      infoDiv.appendChild(nameSpan);
      infoDiv.appendChild(urlSpan);

      const actionGroup = document.createElement("div");
      actionGroup.className = "instance-actions";

      if (isActive) {
        const badge = document.createElement("span");
        badge.className = "active-badge";
        setMessage(badge, "options.instances.active");
        actionGroup.appendChild(badge);
      } else {
        const setBtn = document.createElement("button");
        setBtn.className = "btn-set-active";
        setMessage(setBtn, "options.instances.setActive");
        setBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const granted = await ensureHostPermission(inst.baseUrl);
          if (!granted) {
            showTestResult("error", "options.form.permissionActivate");
            return;
          }
          await StorageManager.setActiveInstanceId(inst.id);
          activeInstanceId = inst.id;
          renderInstancesList();
          chrome.runtime.sendMessage({ type: "UPDATE_PROXY_SETTING" });
        });
        actionGroup.appendChild(setBtn);
      }

      const card = document.createElement("div");
      card.className = `instance-card ${isEditing ? "active" : ""}`;
      card.appendChild(infoDiv);
      card.appendChild(actionGroup);
      card.setAttribute("tabindex", "0");
      card.setAttribute("role", "button");

      const openCard = () => {
        isCreating = false;
        selectInstanceForEdit(inst.id);
      };

      card.addEventListener("click", openCard);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openCard();
        }
      });

      instancesContainer.appendChild(card);
    });

    // Render new draft card when creating a new instance
    if (isCreating) {
      const draftUrl = instUrlInput.value.trim() || "http://127.0.0.1:9090";

      const draftNameSpan = document.createElement("span");
      draftNameSpan.className = "instance-name";
      draftNameSpan.id = "draft-card-name";
      renderDraftName(draftNameSpan);

      const draftUrlSpan = document.createElement("span");
      draftUrlSpan.className = "instance-url";
      draftUrlSpan.id = "draft-card-url";
      draftUrlSpan.textContent = draftUrl;

      const draftInfoDiv = document.createElement("div");
      draftInfoDiv.className = "instance-info";
      draftInfoDiv.appendChild(draftNameSpan);
      draftInfoDiv.appendChild(draftUrlSpan);

      const draftBadge = document.createElement("span");
      draftBadge.className = "draft-badge";
      setMessage(draftBadge, "options.instances.draftBadge");

      const draftCard = document.createElement("div");
      draftCard.className = "instance-card active draft-card";
      draftCard.appendChild(draftInfoDiv);
      draftCard.appendChild(draftBadge);

      instancesContainer.appendChild(draftCard);
    }
  }

  function selectInstanceForEdit(id) {
    const inst = instances.find((i) => i.id === id);
    if (!inst) return;

    isCreating = false;
    editingId = inst.id;
    setMessage(formTitle, "options.form.editTitleNamed", { name: inst.name });

    instIdInput.value = inst.id;
    instNameInput.value = inst.name;
    instUrlInput.value = inst.baseUrl;
    instSecretInput.value = inst.secret || "";

    btnDeleteInst.style.display =
      instances.length > 0 ? "inline-block" : "none";
    hideTestResult();
    renderInstancesList();
  }

  btnAddInstance.addEventListener("click", () => {
    isCreating = true;
    editingId = null;
    setMessage(formTitle, "options.form.addTitle");

    instIdInput.value = "";
    instNameInput.value = "";
    instUrlInput.value = "http://127.0.0.1:9090";
    instSecretInput.value = "";

    btnDeleteInst.style.display = "none";
    hideTestResult();
    renderInstancesList();
    instNameInput.focus();
  });

  // Real-time update draft card preview when typing name/URL
  instNameInput.addEventListener("input", () => {
    if (isCreating) {
      const el = document.getElementById("draft-card-name");
      if (el) renderDraftName(el);
    }
  });

  function renderDraftName(element) {
    const name = instNameInput.value.trim();
    if (name) setPlainText(element, name);
    else setMessage(element, "options.instances.draftName");
  }

  instUrlInput.addEventListener("input", () => {
    if (isCreating) {
      const el = document.getElementById("draft-card-url");
      if (el)
        el.textContent = instUrlInput.value.trim() || "http://127.0.0.1:9090";
    }
  });

  instanceForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const formData = {
      name: instNameInput.value.trim(),
      baseUrl: instUrlInput.value.trim(),
      secret: instSecretInput.value.trim(),
    };

    if (formData.secret && !canSendSecret(formData.baseUrl)) {
      showTestResult("error", "options.form.httpsRequired");
      return;
    }

    const granted = await ensureHostPermission(formData.baseUrl);
    if (!granted) {
      showTestResult("error", "options.form.permissionSave");
      return;
    }

    if (isCreating) {
      const newInst = await StorageManager.addInstance(formData);
      isCreating = false;
      editingId = newInst.id;
    } else if (editingId) {
      await StorageManager.updateInstance(editingId, formData);
    }

    await loadData();
    showTestResult("success", "options.form.saved");
    chrome.runtime.sendMessage({ type: "UPDATE_PROXY_SETTING" });
  });

  btnDeleteInst.addEventListener("click", async () => {
    if (!editingId) return;
    const targetId = editingId;
    if (await confirmAction(msg("options.form.delete"), msg("options.form.deleteConfirm"))) {
      if (editingId !== targetId) return;
      try {
        await StorageManager.deleteInstance(editingId);
        editingId = null;
        isCreating = false;
        await loadData();
        chrome.runtime.sendMessage({ type: "UPDATE_PROXY_SETTING" });
      } catch (err) {
        alert(err.message);
      }
    }
  });

  btnTestConn.addEventListener("click", async () => {
    const tempInstance = {
      baseUrl: instUrlInput.value.trim(),
      secret: instSecretInput.value.trim(),
    };

    showTestResult("info", "options.form.testing");

    try {
      const granted = await ensureHostPermission(tempInstance.baseUrl);
      if (!granted) {
        showTestResult("error", "options.form.permissionConnect");
        return;
      }
      const status = await SpikeApiClient.getStatus(tempInstance);
      const listeners = proxyListenerSummary(
        proxyListenersFromStatus(status, tempInstance),
      );
      const listenerSummary = listeners.length
        ? listeners.map((item) => `${item.label} ${item.address}`).join(", ")
        : msg("options.form.noListeners");
      showTestResult("success", "options.form.testOk", {
        profile: status.profile,
        groups: status.groups,
        rules: status.rules,
        listeners: listenerSummary,
      });
    } catch (err) {
      showTestResult("error", "options.form.testFailed", { error: err.message });
    }
  });

  function showTestResult(type, key, params) {
    testResultEl.className = `test-result ${type}`;
    setMessage(testResultEl, key, params);
    testResultEl.style.display = "block";
  }

  function hideTestResult() {
    testResultEl.style.display = "none";
    testResultEl.className = "test-result";
  }

  async function refreshProxyPreferenceState() {
    const enabled = await StorageManager.isProxyModeEnabled();
    try {
      const state = await chrome.runtime.sendMessage({
        type: "GET_PROXY_SETTING_STATE",
      });
      if (!state || !state.ok)
        throw new Error(state?.error || msg("options.proxy.stateUnavailable"));
      renderProxyPreferenceState(state, enabled);
    } catch (err) {
      proxyPreferenceState.className = "proxy-preference-state error";
      setMessage(proxyPreferenceState, "options.proxy.stateFailed", { error: err.message });
    }
  }

  function renderProxyPreferenceState(state, enabled) {
    if (enabled && state.releasedForUnhealthy) {
      proxyPreferenceState.className = "proxy-preference-state warning";
      setMessage(proxyPreferenceState, "options.proxy.released");
      return;
    }
    if (enabled && state.controlledBySpikeDeck) {
      proxyPreferenceState.className = "proxy-preference-state success";
      setMessage(proxyPreferenceState, "options.proxy.controlled");
      return;
    }
    if (enabled && state.levelOfControl === "controlled_by_other_extensions") {
      proxyPreferenceState.className = "proxy-preference-state warning";
      setMessage(proxyPreferenceState, "options.proxy.otherExtension");
      return;
    }
    proxyPreferenceState.className = "proxy-preference-state";
    setMessage(proxyPreferenceState, "options.proxy.notManaged");
  }

  loadData();
});
