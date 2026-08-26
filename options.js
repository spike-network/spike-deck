import { StorageManager } from "./lib/storage.js";
import { SpikeApiClient } from "./lib/spike-client.js";
import { ensureHostPermission } from "./lib/permissions.js";
import {
  proxyListenerSummary,
  proxyListenersFromStatus,
} from "./lib/proxy-listeners.js";

document.addEventListener("DOMContentLoaded", async () => {
  await StorageManager.init();

  const instancesContainer = document.getElementById("instances-container");
  const btnAddInstance = document.getElementById("btn-add-instance");
  const instanceForm = document.getElementById("instance-form");
  const formTitle = document.getElementById("form-title");

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
  const prefHealthIntervalInput = document.getElementById(
    "pref-health-interval",
  );
  const prefTrafficIntervalInput = document.getElementById(
    "pref-traffic-interval",
  );
  const proxyPreferenceState = document.getElementById(
    "proxy-preference-state",
  );

  let instances = [];
  let activeInstanceId = "";
  let editingId = null;
  let isCreating = false;

  // Load preferences
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

  const profileExportText = document.getElementById("profile-export-text");
  const btnLoadProfileExport = document.getElementById(
    "btn-load-profile-export",
  );
  const btnCopyProfileExport = document.getElementById(
    "btn-copy-profile-export",
  );

  btnLoadProfileExport.addEventListener("click", async () => {
    const active = await StorageManager.getActiveInstance();
    if (!active) {
      profileExportText.textContent = "未配置实例";
      return;
    }
    profileExportText.textContent = "正在加载…";
    try {
      const current = await SpikeApiClient.getCurrentProfile(active);
      profileExportText.textContent = current.profile || current.error || "空";
    } catch (error) {
      profileExportText.textContent = error.message || "加载失败";
    }
  });

  btnCopyProfileExport.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(profileExportText.textContent || "");
      const original = btnCopyProfileExport.textContent;
      btnCopyProfileExport.textContent = "已复制";
      setTimeout(() => {
        btnCopyProfileExport.textContent = original;
      }, 1500);
    } catch {
      profileExportText.title = "无法写入剪贴板";
    }
  });

  const btnToggleSecret = document.getElementById("btn-toggle-secret");
  btnToggleSecret.addEventListener("click", () => {
    const hidden = instSecretInput.type === "password";
    instSecretInput.type = hidden ? "text" : "password";
    btnToggleSecret.textContent = hidden ? "隐藏" : "显示";
  });

  prefExpandModeSelect.addEventListener("change", async (e) => {
    await StorageManager.setGroupExpandMode(e.target.value);
  });

  prefHiddenModeSelect.addEventListener("change", async (e) => {
    await StorageManager.setHiddenGroupsMode(e.target.value);
  });

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
    const previous = !enabled;
    prefControlProxyCheckbox.disabled = true;
    proxyPreferenceState.className = "proxy-preference-state";
    proxyPreferenceState.textContent = enabled
      ? "正在接管浏览器代理…"
      : "正在释放浏览器代理控制权…";
    try {
      await StorageManager.setProxyModeEnabled(enabled);
      const response = await chrome.runtime.sendMessage({
        type: "UPDATE_PROXY_SETTING",
      });
      if (!response || !response.ok) {
        throw new Error(response?.error || "无法更新浏览器代理设置");
      }
      renderProxyPreferenceState(response, enabled);
    } catch (err) {
      await StorageManager.setProxyModeEnabled(previous);
      prefControlProxyCheckbox.checked = previous;
      proxyPreferenceState.className = "proxy-preference-state error";
      proxyPreferenceState.textContent = `代理设置更新失败: ${err.message}`;
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
      formTitle.textContent = "添加 Spike 实例";
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
      emptyDiv.textContent = "暂无实例，请在右侧添加您的第一个 Spike 实例";
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
        badge.textContent = "当前激活";
        actionGroup.appendChild(badge);
      } else {
        const setBtn = document.createElement("button");
        setBtn.className = "btn-set-active";
        setBtn.textContent = "设为激活";
        setBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const granted = await ensureHostPermission(inst.baseUrl);
          if (!granted) {
            showTestResult("error", "❌ 未授予访问该地址的主机权限，无法激活");
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
      const draftName = instNameInput.value.trim() || "新 Spike 实例 (未保存)";
      const draftUrl = instUrlInput.value.trim() || "http://127.0.0.1:9090";

      const draftNameSpan = document.createElement("span");
      draftNameSpan.className = "instance-name";
      draftNameSpan.id = "draft-card-name";
      draftNameSpan.textContent = draftName;

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
      draftBadge.textContent = "新建中...";

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
    formTitle.textContent = `编辑实例: ${inst.name}`;

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
    formTitle.textContent = "添加新 Spike 实例";

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
      if (el)
        el.textContent = instNameInput.value.trim() || "新 Spike 实例 (未保存)";
    }
  });

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

    const granted = await ensureHostPermission(formData.baseUrl);
    if (!granted) {
      showTestResult("error", "❌ 未授予访问该地址的主机权限，无法保存实例");
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
    showTestResult("success", "✅ 实例保存成功！");
    chrome.runtime.sendMessage({ type: "UPDATE_PROXY_SETTING" });
  });

  btnDeleteInst.addEventListener("click", async () => {
    if (!editingId) return;
    if (confirm("确定要删除该 Spike 实例吗？")) {
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

    showTestResult("info", "正在测试连接...");

    try {
      const granted = await ensureHostPermission(tempInstance.baseUrl);
      if (!granted) {
        showTestResult("error", "❌ 未授予访问该地址的主机权限，无法连接");
        return;
      }
      const status = await SpikeApiClient.getStatus(tempInstance);
      const listeners = proxyListenerSummary(
        proxyListenersFromStatus(status, tempInstance),
      );
      const listenerSummary = listeners.length
        ? listeners.map((item) => `${item.label} ${item.address}`).join(", ")
        : "未暴露 listeners（请升级 Spike）";
      showTestResult(
        "success",
        `✅ 连接成功！Profile: ${status.profile} (组 ${status.groups}, 规则 ${status.rules}) · 代理监听: ${listenerSummary}`,
      );
    } catch (err) {
      showTestResult("error", `❌ 连接失败: ${err.message}`);
    }
  });

  function showTestResult(type, message) {
    testResultEl.className = `test-result ${type}`;
    testResultEl.textContent = message;
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
        throw new Error(state?.error || "无法读取 Chrome 代理状态");
      renderProxyPreferenceState(state, enabled);
    } catch (err) {
      proxyPreferenceState.className = "proxy-preference-state error";
      proxyPreferenceState.textContent = `无法读取代理控制状态: ${err.message}`;
    }
  }

  function renderProxyPreferenceState(state, enabled) {
    if (enabled && state.releasedForUnhealthy) {
      proxyPreferenceState.className = "proxy-preference-state warning";
      proxyPreferenceState.textContent =
        "Spike 不可达，已交回代理控制；恢复后将自动接管。";
      return;
    }
    if (enabled && state.controlledBySpikeDeck) {
      proxyPreferenceState.className = "proxy-preference-state success";
      proxyPreferenceState.textContent = "SpikeDeck 正在控制当前浏览器代理。";
      return;
    }
    if (enabled && state.levelOfControl === "controlled_by_other_extensions") {
      proxyPreferenceState.className = "proxy-preference-state warning";
      proxyPreferenceState.textContent = "当前代理设置由其他扩展控制。";
      return;
    }
    proxyPreferenceState.className = "proxy-preference-state";
    proxyPreferenceState.textContent =
      "SpikeDeck 未接管代理；其他代理扩展可正常工作。";
  }

  loadData();
});
