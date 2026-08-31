import { SpikeApiClient } from './lib/spike-client.js';
import { StorageManager } from './lib/storage.js';
import { initializeI18n, t } from './lib/i18n.js';
import { filterRuntimeLogs, formatRuntimeLogs } from './lib/runtime-logs.js';
import { formatConnectionTrace } from './lib/connection-trace.js';

await initializeI18n();

let instance = null;
let logEntries = [];
let eventEntries = [];

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
  [
    row.id,
    row.peer,
    `${row.host || '—'}:${row.port || '—'}`,
    row.policy,
    formatConnectionTrace(row.decision_trace),
    row.kind
  ]
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
    ? makeTable(['ID', 'Peer', 'Target', 'Policy', 'Decision', 'Kind', 'Status', 'Action'], rows)
    : text('p', '暂无连接'));
}

async function loadSessionPools() {
  const data = await SpikeApiClient.getMetrics(instance);
  const pools = Array.isArray(data.session_pools) ? data.session_pools : [];
  const rows = pools.map((pool) => {
    const tr = document.createElement('tr');
    [
      pool.name,
      `${pool.keys}/${pool.max_keys} keys · ${pool.sessions} sessions · ${pool.max_sessions_per_key}/key`,
      pool.active ?? '—',
      `${pool.reuses_total} / ${pool.misses_total}`,
      `${pool.created_total} / ${pool.rebuilds_total} / ${pool.evictions_total}`,
      pool.last_failure ? `${pool.failures_total} · ${pool.last_failure}` : pool.failures_total
    ].forEach((value) => tr.append(text('td', value, undefined, true)));
    return tr;
  });
  byId('session-pools').replaceChildren(rows.length
    ? makeTable(['池', '占用', '活跃', '复用 / 未命中', '创建 / 重建 / 淘汰', '失败'], rows)
    : text('p', '暂无会话池指标'));
}

async function loadLogs() {
  const data = await SpikeApiClient.getLogs(instance, 200);
  const entries = Array.isArray(data.entries) ? data.entries : [];
  mergeLogEntries(entries);
}

function eventRow(entry) {
  const tr = document.createElement('tr');
  tr.className = `event-severity-${entry.severity || 'info'}`;
  [
    new Date(entry.occurred_at_unix_ms || 0).toLocaleString(),
    entry.severity || 'info',
    entry.category || 'runtime',
    entry.summary || entry.kind,
    entry.kind,
    entry.action?.label || '—'
  ].forEach((value) => tr.append(text('td', value, undefined, true)));
  return tr;
}

async function loadEvents() {
  const data = await SpikeApiClient.getEvents(instance, 500);
  eventEntries = (data.events || []).filter((entry) => entry.kind !== 'log').reverse();
  renderEvents();
}

function renderEvents() {
  const keyword = (byId('events-filter').value || '').trim().toLowerCase();
  const severity = byId('events-severity').value;
  const filtered = eventEntries.filter((entry) => {
    if (severity !== 'all' && entry.severity !== severity) return false;
    return !keyword || [entry.category, entry.kind, entry.summary].join(' ').toLowerCase().includes(keyword);
  });
  byId('events-filter-count').textContent = `${filtered.length} / ${eventEntries.length}`;
  byId('events').replaceChildren(filtered.length
    ? makeTable(['Time', 'Severity', 'Category', 'Event', 'Kind', 'Action'], filtered.map(eventRow))
    : text('p', '暂无匹配事件'));
}

function mergeLogEntries(entries) {
  const bySequence = new Map(logEntries.map((entry) => [Number(entry.sequence), entry]));
  for (const entry of entries) {
    const sequence = Number(entry?.sequence);
    if (Number.isSafeInteger(sequence)) bySequence.set(sequence, entry);
  }
  logEntries = Array.from(bySequence.values())
    .sort((left, right) => Number(left.sequence) - Number(right.sequence))
    .slice(-200);
  renderLogs();
}

function renderLogs() {
  const input = byId('logs-filter');
  const keyword = input?.value || '';
  const filtered = filterRuntimeLogs(logEntries, keyword);
  byId('logs-output').textContent = filtered.length
    ? formatRuntimeLogs(filtered)
    : logEntries.length
      ? t('无匹配日志')
      : t('暂无运行日志');
  byId('logs-filter-count').textContent = `${filtered.length} / ${logEntries.length}`;
  byId('logs-filter-clear').disabled = !keyword;
}

function setLogStreamState(status) {
  const labels = {
    connecting: '实时日志连接中…',
    live: '实时日志已连接',
    retrying: '实时日志重连中…',
    idle: '等待活动实例'
  };
  const node = byId('logs-stream-state');
  node.textContent = t(labels[status] || labels.connecting);
  node.dataset.state = status || 'connecting';
}

chrome.runtime.onMessage.addListener((message) => {
  if (!instance || message?.instanceId !== instance.id) return;
  if (message.type === 'SPIKE_LOG_STREAM_ENTRY') mergeLogEntries([message.entry]);
  if (message.type === 'SPIKE_LOG_STREAM_STATE') setLogStreamState(message.status);
});

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
    loadSessionPools(),
    loadLogs(),
    loadEvents(),
    loadDnsCache(),
    loadScripts()
  ]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) handleError(failed.reason);
}

byId('refresh-all').addEventListener('click', loadAll);
byId('logs-refresh').addEventListener('click', () => loadLogs().catch(handleError));
byId('events-refresh').addEventListener('click', () => loadEvents().catch(handleError));
byId('events-filter').addEventListener('input', renderEvents);
byId('events-severity').addEventListener('change', renderEvents);
byId('logs-filter').addEventListener('input', renderLogs);
byId('logs-filter-clear').addEventListener('click', () => {
  const input = byId('logs-filter');
  input.value = '';
  renderLogs();
  input.focus();
});
byId('reload-preview').addEventListener('click', async () => {
  try {
    output('reload-preview-output', await SpikeApiClient.previewReload(instance));
  } catch (error) { handleError(error); }
});
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
  const stream = await chrome.runtime.sendMessage({ type: 'ENSURE_LOG_STREAM' });
  if (!stream?.ok) throw new Error(stream?.error || '无法启动实时日志');
  await loadAll();
} catch (error) {
  handleError(error);
  byId('instance-label').textContent = '活动实例不可用';
}
