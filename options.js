import { StorageManager } from './lib/storage.js';
import { SpikeApiClient } from './lib/spike-client.js';

document.addEventListener('DOMContentLoaded', async () => {
  await StorageManager.init();

  const instancesContainer = document.getElementById('instances-container');
  const btnAddInstance = document.getElementById('btn-add-instance');
  const instanceForm = document.getElementById('instance-form');
  const formTitle = document.getElementById('form-title');

  const instIdInput = document.getElementById('inst-id');
  const instNameInput = document.getElementById('inst-name');
  const instUrlInput = document.getElementById('inst-url');
  const instSecretInput = document.getElementById('inst-secret');
  const instHttpProxyInput = document.getElementById('inst-http-proxy');
  const instSocksProxyInput = document.getElementById('inst-socks-proxy');

  const btnTestConn = document.getElementById('btn-test-conn');
  const btnDeleteInst = document.getElementById('btn-delete-inst');
  const testResultEl = document.getElementById('test-result');

  let instances = [];
  let activeInstanceId = '';
  let editingId = null;
  let isCreating = false;

  async function loadData() {
    instances = await StorageManager.getInstances();
    const active = await StorageManager.getActiveInstance();
    activeInstanceId = active.id;

    renderInstancesList();
    if (!editingId && !isCreating && instances.length > 0) {
      selectInstanceForEdit(active.id);
    }
  }

  function renderInstancesList() {
    instancesContainer.replaceChildren();

    // Render existing instances
    instances.forEach((inst) => {
      const isActive = inst.id === activeInstanceId;
      const isEditing = !isCreating && inst.id === editingId;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'instance-name';
      nameSpan.textContent = inst.name;

      const urlSpan = document.createElement('span');
      urlSpan.className = 'instance-url';
      urlSpan.textContent = inst.baseUrl;

      const infoDiv = document.createElement('div');
      infoDiv.className = 'instance-info';
      infoDiv.appendChild(nameSpan);
      infoDiv.appendChild(urlSpan);

      const actionGroup = document.createElement('div');
      actionGroup.className = 'instance-actions';

      if (isActive) {
        const badge = document.createElement('span');
        badge.className = 'active-badge';
        badge.textContent = '当前激活';
        actionGroup.appendChild(badge);
      } else {
        const setBtn = document.createElement('button');
        setBtn.className = 'btn-set-active';
        setBtn.textContent = '设为激活';
        setBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await StorageManager.setActiveInstanceId(inst.id);
          activeInstanceId = inst.id;
          renderInstancesList();
          chrome.runtime.sendMessage({ type: 'UPDATE_PROXY_SETTING' });
        });
        actionGroup.appendChild(setBtn);
      }

      const card = document.createElement('div');
      card.className = `instance-card ${isEditing ? 'active' : ''}`;
      card.appendChild(infoDiv);
      card.appendChild(actionGroup);

      card.addEventListener('click', () => {
        isCreating = false;
        selectInstanceForEdit(inst.id);
      });

      instancesContainer.appendChild(card);
    });

    // Render new draft card when creating a new instance
    if (isCreating) {
      const draftName = instNameInput.value.trim() || '新 Spike 实例 (未保存)';
      const draftUrl = instUrlInput.value.trim() || 'http://127.0.0.1:9090';

      const draftNameSpan = document.createElement('span');
      draftNameSpan.className = 'instance-name';
      draftNameSpan.id = 'draft-card-name';
      draftNameSpan.textContent = draftName;

      const draftUrlSpan = document.createElement('span');
      draftUrlSpan.className = 'instance-url';
      draftUrlSpan.id = 'draft-card-url';
      draftUrlSpan.textContent = draftUrl;

      const draftInfoDiv = document.createElement('div');
      draftInfoDiv.className = 'instance-info';
      draftInfoDiv.appendChild(draftNameSpan);
      draftInfoDiv.appendChild(draftUrlSpan);

      const draftBadge = document.createElement('span');
      draftBadge.className = 'draft-badge';
      draftBadge.textContent = '新建中...';

      const draftCard = document.createElement('div');
      draftCard.className = 'instance-card active draft-card';
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
    instSecretInput.value = inst.secret || '';
    instHttpProxyInput.value = inst.httpProxy || '';
    instSocksProxyInput.value = inst.socksProxy || '';

    btnDeleteInst.style.display = instances.length > 1 ? 'inline-block' : 'none';
    hideTestResult();
    renderInstancesList();
  }

  btnAddInstance.addEventListener('click', () => {
    isCreating = true;
    editingId = null;
    formTitle.textContent = '添加新 Spike 实例';

    instIdInput.value = '';
    instNameInput.value = '';
    instUrlInput.value = 'http://127.0.0.1:9090';
    instSecretInput.value = '';
    instHttpProxyInput.value = '127.0.0.1:6152';
    instSocksProxyInput.value = '127.0.0.1:6153';

    btnDeleteInst.style.display = 'none';
    hideTestResult();
    renderInstancesList();
    instNameInput.focus();
  });

  // Real-time update draft card preview when typing name/URL
  instNameInput.addEventListener('input', () => {
    if (isCreating) {
      const el = document.getElementById('draft-card-name');
      if (el) el.textContent = instNameInput.value.trim() || '新 Spike 实例 (未保存)';
    }
  });

  instUrlInput.addEventListener('input', () => {
    if (isCreating) {
      const el = document.getElementById('draft-card-url');
      if (el) el.textContent = instUrlInput.value.trim() || 'http://127.0.0.1:9090';
    }
  });

  instanceForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const formData = {
      name: instNameInput.value.trim(),
      baseUrl: instUrlInput.value.trim(),
      secret: instSecretInput.value.trim(),
      httpProxy: instHttpProxyInput.value.trim(),
      socksProxy: instSocksProxyInput.value.trim()
    };

    if (isCreating) {
      const newInst = await StorageManager.addInstance(formData);
      isCreating = false;
      editingId = newInst.id;
    } else if (editingId) {
      await StorageManager.updateInstance(editingId, formData);
    }

    await loadData();
    showTestResult('success', '✅ 实例保存成功！');
    chrome.runtime.sendMessage({ type: 'UPDATE_PROXY_SETTING' });
  });

  btnDeleteInst.addEventListener('click', async () => {
    if (!editingId) return;
    if (confirm('确定要删除该 Spike 实例吗？')) {
      try {
        await StorageManager.deleteInstance(editingId);
        editingId = null;
        isCreating = false;
        await loadData();
        chrome.runtime.sendMessage({ type: 'UPDATE_PROXY_SETTING' });
      } catch (err) {
        alert(err.message);
      }
    }
  });

  btnTestConn.addEventListener('click', async () => {
    const tempInstance = {
      baseUrl: instUrlInput.value.trim(),
      secret: instSecretInput.value.trim()
    };

    showTestResult('info', '正在测试连接...');

    try {
      const status = await SpikeApiClient.getStatus(tempInstance);
      showTestResult('success', `✅ 连接成功！Profile: ${status.profile} (包含 ${status.groups} 个组, ${status.rules} 条规则)`);
    } catch (err) {
      showTestResult('error', `❌ 连接失败: ${err.message}`);
    }
  });

  function showTestResult(type, message) {
    testResultEl.className = `test-result ${type}`;
    testResultEl.textContent = message;
    testResultEl.style.display = 'block';
  }

  function hideTestResult() {
    testResultEl.style.display = 'none';
    testResultEl.className = 'test-result';
  }

  loadData();
});
