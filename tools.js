import { SpikeApiClient } from './lib/spike-client.js';
import { StorageManager } from './lib/storage.js';
import { initializeI18n, t } from './lib/i18n.js';
import { formatRuntimeLogs } from './lib/runtime-logs.js';

await initializeI18n();

let instance = null;

const byId = (id) => document.getElementById(id);
const text = (tag, value, className, userContent = false) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (userContent) node.dataset.i18nIgnore = '';
  node.textContent = value == null ? '—' : String(value);
  return node;
};

function showNotice(message) {
  const notice = byId('notice');
  notice.textContent = message;
  notice.classList.add('visible');
  window.setTimeout(() => notice.classList.remove('visible'), 2600);
}

function output(id, value) {
  byId(id).textContent = JSON.stringify(value, null, 2);
}

function makeTable(headers, rows) {
  const table = document.createElement('table');
  const head = document.createElement('tr');
  headers.forEach((header) => head.append(text('th', header)));
  table.append(head, ...rows);
  return table;
}

function connectionRow(row, live) {
  const tr = document.createElement('tr');
  [row.id, row.peer, `${row.host || '—'}:${row.port || '—'}`, row.policy, row.kind]
    .forEach((value) => tr.append(text('td', value, undefined, true)));
  tr.append(text('td', row.ok === false ? row.error || 'failed' : live ? 'live' : 'finished'));
  const action = document.createElement('td');
  if (live) {
    const button = text('button', 'Kill');
    button.addEventListener('click', async () => {
      if (!window.confirm(t(`Terminate connection #${row.id}?`))) return;
      await SpikeApiClient.killConnection(instance, row.id);
      await loadConnections();
    });
    action.append(button);
  } else action.textContent = '—';
  tr.append(action);
  return tr;
}

async function loadConnections() {
  const data = await SpikeApiClient.getConnections(instance);
  const rows = [
    ...(data.live || []).map((row) => connectionRow(row, true)),
    ...(data.recent || []).map((row) => connectionRow(row, false))
  ];
  byId('connections').replaceChildren(rows.length
    ? makeTable(['ID', 'Peer', 'Target', 'Policy', 'Kind', 'Status', 'Action'], rows)
    : text('p', '暂无连接'));
}

async function loadLogs() {
  const data = await SpikeApiClient.getLogs(instance, 200);
  const entries = Array.isArray(data.entries) ? data.entries : [];
  byId('logs-output').textContent = entries.length
    ? formatRuntimeLogs(entries)
    : t('暂无运行日志');
}

async function loadDnsCache() {
  const data = await SpikeApiClient.getDnsCache(instance);
  const rows = (data.dnsCache || []).map((entry) => {
    const tr = document.createElement('tr');
    [entry.domain, entry.address, entry.expires]
      .forEach((value) => tr.append(text('td', value, undefined, true)));
    return tr;
  });
  byId('dns-cache').replaceChildren(rows.length
    ? makeTable(['Domain', 'Address', 'Expires'], rows)
    : text('p', 'DNS cache 为空'));
}

async function runScript(body, cron = false) {
  const result = cron
    ? await SpikeApiClient.evaluateCronScript(instance, body.script_name)
    : await SpikeApiClient.evaluateScript(instance, body);
  output('script-output', result.result ?? result);
}

async function loadScripts() {
  const data = await SpikeApiClient.getScripts(instance);
  const rows = (data.scripts || []).map((script) => {
    const tr = document.createElement('tr');
    [script.name, script.type, script.cronexp || script.event_name || '—']
      .forEach((value) => tr.append(text('td', value, undefined, true)));
    const action = document.createElement('td');
    const evaluate = text('button', 'Evaluate');
    evaluate.addEventListener('click', () => runScript({ name: script.name }).catch(handleError));
    action.append(evaluate);
    if (script.type === 'cron') {
      const cron = text('button', 'Run cron');
      cron.addEventListener('click', () => runScript({ script_name: script.name }, true).catch(handleError));
      action.append(' ', cron);
    }
    tr.append(action);
    return tr;
  });
  byId('scripts').replaceChildren(rows.length
    ? makeTable(['Name', 'Type', 'Schedule / event', 'Action'], rows)
    : text('p', '没有已配置脚本'));
}

function handleError(error) {
  showNotice(error instanceof Error ? error.message : String(error));
}

async function loadAll() {
  if (!instance) return;
  const results = await Promise.allSettled([
    loadConnections(),
    loadLogs(),
    loadDnsCache(),
    loadScripts()
  ]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) handleError(failed.reason);
}

byId('refresh-all').addEventListener('click', loadAll);
byId('logs-refresh').addEventListener('click', () => loadLogs().catch(handleError));
byId('dns-cache-refresh').addEventListener('click', () => loadDnsCache().catch(handleError));
byId('dns-flush').addEventListener('click', async () => {
  try {
    output('dns-output', await SpikeApiClient.flushDns(instance));
    await loadDnsCache();
  } catch (error) { handleError(error); }
});

byId('route-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    host: byId('route-host').value.trim(),
    port: Number(byId('route-port').value),
    protocol: byId('route-protocol').value
  };
  const sourceIp = byId('route-source').value.trim();
  if (sourceIp) body.source_ip = sourceIp;
  try { output('route-output', await SpikeApiClient.explainRoute(instance, body)); }
  catch (error) { handleError(error); }
});

byId('dns-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    output('dns-output', await SpikeApiClient.queryDns(instance, {
      name: byId('dns-name').value.trim(),
      qtype: byId('dns-type').value,
      client: byId('dns-client').checked
    }));
  } catch (error) { handleError(error); }
});

byId('script-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await runScript({
      script_text: byId('script-text').value,
      mock_type: byId('script-mock').value
    });
  } catch (error) { handleError(error); }
});

try {
  await StorageManager.init();
  instance = await StorageManager.getActiveInstance();
  if (!instance) throw new Error('请先在 SpikeDeck 设置中添加并选择实例');
  byId('instance-label').textContent = `${instance.name} · ${instance.baseUrl}`;
  await loadAll();
} catch (error) {
  handleError(error);
  byId('instance-label').textContent = '活动实例不可用';
}
