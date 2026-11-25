import { SpikeApiClient } from './lib/spike-client.js';
import { confirmAction } from './lib/confirm-dialog.js';
import { StorageManager } from './lib/storage.js';
import { initializeI18n, msg, onLanguageChange } from './lib/i18n.js';
import {
  filterRuntimeLogs,
  formatRuntimeLogs,
  sortRuntimeLogs
} from './lib/runtime-logs.js';
import { formatConnectionTrace, connectionDetailFields, connectionMethod } from './lib/connection-trace.js';
import { routeContext } from './lib/route-context.js';
import { chronological, downloadJournal } from './lib/journal-export.js';
import { PanelObservation } from './lib/panels.js';
import { ThroughputSession } from './lib/throughput.js';
import { policyProbeRequest } from './lib/policy-probe.js';
import { coreError, requestErrorText, statusError } from './lib/core-error.js';
import { isRejectPolicy } from './lib/group-selection.js';
import { ConnectionMirror } from './lib/connection-mirror.js';
import { reloadView, reloadStatusView } from './lib/reload-view.js';

await initializeI18n();
// Text built in script is not re-translated in place; reload so every label is rendered again.
onLanguageChange(() => window.location.reload());

let instance = null;
let logEntries = [];
let eventEntries = [];
let eventNamespace = '';
let clearedLogSequence = 0;
let clearedEventSequence = 0;
let frozenLogs = null;
let frozenEvents = null;
let logRead = null;
let readinessSequence = 0;
let connectionsSequence = 0;
let connectionSnapshot = { live: [], recent: [] };
// Incremental connection list, used only when Core advertises features.refresh_model.
let connectionMirror = null;
let connectionsIncremental = null;
const openConnectionDetails = new Set();
let connectionDisclosures = new Map();
let probePolicies = [];
let probeNamespace = '';
let probeBusy = false;
let probeGeneration = 0;
let probeLive = true;
let probeCatalogRead = 0;
let probeCatalogDeferred = false;
let reloadLive = true;
let reloadBusy = false;
let reloadUnconfirmed = false;
let reloadNamespace = '';
let reloadGeneration = 0;

function adoptEventNamespace(namespace) {
  if (!namespace || namespace === eventNamespace) return;
  const previous = eventNamespace;
  if (eventNamespace || logEntries.length || eventEntries.length || frozenLogs?.length || frozenEvents?.length || clearedLogSequence || clearedEventSequence) {
    frozenLogs = null; frozenEvents = null;
  }
  eventNamespace = namespace;
  if ((reloadNamespace && reloadNamespace !== namespace) || (reloadBusy && previous)) {
    reloadGeneration++;
    reloadBusy = false;
    reloadUnconfirmed = false;
    reloadNamespace = '';
    byId('reload-preview-output').textContent = '';
    byId('reload-result-output').textContent = '';
    byId('reload-operation-status').textContent = '';
    byId('reload-operation-error').textContent = msg("tools.runtimeChangedCheckCurrent");
    updateReloadControls();
  }
  if (probeNamespace && probeNamespace !== namespace) {
    probeNamespace = ''; probeGeneration++; probeBusy = false; probeCatalogDeferred = false;
    byId('policy-probe-start').disabled = true;
    byId('policy-probe-policies').disabled = byId('policy-probe-url').disabled = false;
    byId('policy-probe-results').replaceChildren();
    byId('policy-probe-error').textContent = msg("tools.runtimeIdentityUnavailableReload");
  } else if (probeNamespace === namespace && !probeBusy) {
    byId('policy-probe-start').disabled = false;
    byId('policy-probe-error').textContent = '';
  }
  panels.runtime(namespace);
  clearedLogSequence = 0;
  clearedEventSequence = 0;
  logEntries = [];
  eventEntries = [];
  renderLogs();
  renderEvents();
}

const byId = (id) => document.getElementById(id);
async function transferRequest(method, ...args) {
  let namespace = null;
  const options = args.pop();
  const value = await SpikeApiClient[method](instance, ...args, { ...options, onRuntime: value => { namespace = value; } });
  return { value, namespace };
}
const transfer = new ThroughputSession({
  list: () => transferRequest('getThroughputTests', {}),
  start: (body, runtimeNamespace) => transferRequest('startThroughputTest', body, { runtimeNamespace }),
  get: (id, runtimeNamespace) => transferRequest('getThroughputTest', id, { runtimeNamespace }),
  cancel: (id, runtimeNamespace) => transferRequest('cancelThroughputTest', id, { runtimeNamespace })
}, renderTransfer);
const panels = new PanelObservation({
  read: onRuntime => SpikeApiClient.getPanels(instance, { onRuntime }),
  refresh: (name, onRuntime) => SpikeApiClient.refreshPanel(instance, name, { onRuntime, runtimeNamespace: panels.namespace })
}, renderPanels);
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

function transferBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = Math.max(0, Number(bytes) || 0), index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[index]}`;
}

const TRANSFER_LABEL_KEYS = { queued: 'tools.transferQueued', running: 'tools.transferRunning', completed: 'tools.transferCompleted', failed: 'tools.failed', cancelled: 'tools.transferCancelled', download: 'tools.transferDownload', upload: 'tools.transferUpload' };
function transferLabel(value) { const key = Object.hasOwn(TRANSFER_LABEL_KEYS, value) ? TRANSFER_LABEL_KEYS[value] : null; return key ? msg(key) : String(value); }

function renderTransfer() {
  const busy = transfer.busy || transfer.reading;
  byId('throughput-start').disabled = busy || !transfer.namespace;
  byId('throughput-direction').disabled = byId('throughput-policy').disabled = busy;
  byId('throughput-cancel').disabled = !transfer.busy || transfer.uncertain || transfer.cancelling || transfer.starting && transfer.cancelRequested;
  byId('throughput-reload').disabled = transfer.reading || transfer.starting || transfer.cancelling;
  const rows = [];
  if (transfer.starting) rows.push(text('p', transfer.cancelRequested ? msg("tools.cancellationWillSentWhen") : msg("tools.startingThroughputTest")));
  if (transfer.error || transfer.uncertain) {
    const error = text('p', transfer.detail || transfer.error || msg("tools.startResultUnconfirmedCheck"), undefined, !!transfer.detail); error.role = 'alert'; rows.push(error);
  }
  if (transfer.uncertain) {
    const dismiss = text('button', msg("tools.forgetUnconfirmedStart"));
    dismiss.addEventListener('click', async () => { if (await confirmAction(msg("tools.forgetUnconfirmedStart"), msg("tools.forgetUnconfirmedStartDoes"))) transfer.dismissUnconfirmed(); }); rows.push(dismiss);
  }
  if (transfer.task) {
    const task = transfer.task;
    rows.push(text('p', `${transferLabel(task.status)} · ${transferLabel(task.direction)} · ${transferBytes(task.bytes_per_second)}/s · ${transferBytes(task.bytes)} / ${transferBytes(task.byte_limit)}`));
    rows.push(text('p', task.policy, undefined, true));
    const progress = document.createElement('progress'); progress.max = Math.max(1, task.byte_limit); progress.value = Math.min(task.bytes, task.byte_limit);
    progress.setAttribute('aria-label', msg("tools.transferredBytes")); rows.push(progress);
    if (task.status === 'failed') rows.push(text('p', statusError(task) || msg("tools.throughputTestFailedCheck"), undefined, true));
    if (task.cancel_requested && ['queued', 'running'].includes(task.status)) rows.push(text('p', msg("tools.cancellationRequested")));
    const check = text('button', msg("tools.checkTaskStatus")); check.disabled = transfer.polling || transfer.starting || transfer.cancelling;
    check.addEventListener('click', () => transfer.check()); rows.push(check);
    const stop = text('button', msg("tools.stopObserving")); stop.disabled = transfer.starting || transfer.cancelling;
    stop.addEventListener('click', async () => { if (await confirmAction(msg("tools.stopObserving"), msg("tools.stopObservingTaskMay"))) transfer.stopObserving(); }); rows.push(stop);
  }
  if (transfer.reading) rows.push(text('p', msg("tools.readingThroughputTasks")));
  byId('throughput-result').replaceChildren(...rows);
  const history = transfer.tasks.map(task => {
    const row = document.createElement('tr');
    row.append(text('td', new Date(task.created_at_unix_ms).toLocaleString()), text('td', task.policy, undefined, true),
      text('td', transferLabel(task.direction)), text('td', transferLabel(task.status)), text('td', `${transferBytes(task.bytes)} · ${transferBytes(task.bytes_per_second)}/s`));
    const action = text('td', ''); const observe = text('button', msg("common.observe"));
    observe.setAttribute('aria-label', `${msg("tools.observeThroughputTask")} ${task.id}`);
    observe.disabled = transfer.reading || transfer.starting || transfer.cancelling || !transfer.namespace;
    observe.addEventListener('click', () => transfer.observe(task)); action.append(observe); row.append(action); return row;
  });
  byId('throughput-history').replaceChildren(history.length ? makeTable([msg("common.time"), msg("common.policy"), msg("tools.direction"), msg("common.status2"), msg("tools.transfer"), msg("common.action")], history) : text('p', transfer.reading ? msg("tools.readingThroughputTasks") : msg("tools.noRecentThroughputTests")));
}

async function loadTransferPolicies() {
  if (probeBusy) { probeCatalogDeferred = true; return; }
  const read = ++probeCatalogRead;
  try {
    let namespace = '';
    const result = await SpikeApiClient.getPolicies(instance, { onRuntime: value => { namespace = value || ''; } });
    if (!probeLive || read !== probeCatalogRead) return;
    if (probeBusy) { probeCatalogDeferred = true; return; }
    const usable = namespace && (!eventNamespace || namespace === eventNamespace);
    const selected = byId('throughput-policy').value || 'DIRECT';
    probePolicies = [...new Set(['DIRECT', ...(result.policies || []).filter(item => !isRejectPolicy(item.name)).map(item => item.name)])];
    probeNamespace = namespace; probeGeneration++;
    const previouslySelected = new Set(Array.from(byId('policy-probe-policies').selectedOptions || [], option => option.value));
    byId('policy-probe-policies').replaceChildren(...probePolicies.map(name => {
      const option = text('option', name, undefined, true); option.value = name; option.selected = previouslySelected.has(name); return option;
    }));
    byId('policy-probe-results').replaceChildren();
    byId('policy-probe-error').textContent = usable ? '' : msg("tools.runtimeIdentityUnavailableReload");
    byId('policy-probe-start').disabled = !usable;
    const names = [...new Set([...probePolicies, selected])];
    byId('throughput-policy').replaceChildren(...names.map(name => {
      const capability = result.policies?.find(item => item.name === name)?.test_capabilities;
      const reason = capability?.throughput === false
        ? coreError(capability.unsupported_code, undefined, capability.unsupported_reason) : '';
      const option = text('option', reason ? name + ' — ' + reason : name, undefined, true);
      option.value = name;
      return option;
    }));
    byId('throughput-policy').value = selected;
    byId('throughput-policy-error').textContent = '';
  } catch {
    if (!probeLive || read !== probeCatalogRead) return;
    if (probeBusy) { probeCatalogDeferred = true; return; }
    byId('throughput-policy-error').textContent = msg("tools.unableLoadThroughputPolicies");
    byId('policy-probe-error').textContent = msg("tools.unableLoadProbePolicies");
    byId('policy-probe-start').disabled = true;
  }
}

async function runPolicyProbe(event) {
  event.preventDefault();
  if (!probeLive || probeBusy || !probeNamespace || (eventNamespace && probeNamespace !== eventNamespace)) return;
  let body;
  try { body = policyProbeRequest(Array.from(byId('policy-probe-policies').selectedOptions || [], option => option.value), byId('policy-probe-url').value, probePolicies); }
  catch (error) { byId('policy-probe-error').textContent = error.message; return; }
  const generation = ++probeGeneration, namespace = probeNamespace;
  probeBusy = true; byId('policy-probe-start').disabled = true;
  byId('policy-probe-policies').disabled = byId('policy-probe-url').disabled = true;
  byId('policy-probe-error').textContent = ''; byId('policy-probe-results').replaceChildren(text('p', msg("tools.probingPolicies")));
  try {
    let received;
    const result = await SpikeApiClient.probePolicies(instance, body, { runtimeNamespace: namespace, onRuntime: value => { received = value; } });
    if (!probeLive || generation !== probeGeneration) return;
    if (received !== namespace || !Array.isArray(result.results) || result.error) {
      if (received === namespace && result.code) throw Object.assign(new Error(result.error), result);
      throw new Error();
    }
    const rows = body.policy_names.map(name => {
      const value = result.results.find(row => row.policy === name);
      const row = document.createElement('tr');
      row.append(text('td', name, undefined, true), text('td', !value ? msg("tools.noResult") : value.ok ? msg("tools.ok") :
        [msg("tools.failed"), value.error_code && statusError(value)].filter(Boolean).join(' · '), undefined, true),
        text('td', value?.ok && Number.isFinite(value.latency_ms) ? `${value.latency_ms} ms` : '—'));
      return row;
    });
    byId('policy-probe-results').replaceChildren(makeTable([msg("common.policy"), msg("common.status2"), msg("common.latency")], rows));
  } catch (error) {
    if (!probeLive || generation !== probeGeneration) return;
    byId('policy-probe-results').replaceChildren();
    byId('policy-probe-error').textContent = (error?.code && requestErrorText(error)) || msg("tools.policyProbeFailedCheck");
  } finally {
    if (probeLive && generation === probeGeneration) {
      probeBusy = false; byId('policy-probe-start').disabled = !probeNamespace;
      byId('policy-probe-policies').disabled = byId('policy-probe-url').disabled = false;
      if (probeCatalogDeferred) { probeCatalogDeferred = false; void loadTransferPolicies(); }
    }
  }
}

function renderPanels() {
  byId('panels-refresh').disabled = panels.loading || panels.pending.size > 0;
  const cards = [];
  if (panels.loading) cards.push(text('p', msg("tools.loadingPanels")));
  if (panels.error) { const error = text('p', msg("tools.unableLoadPanelsRetry")); error.role = 'alert'; cards.push(error); }
  if (panels.loaded && !panels.loading && !panels.panels.length) cards.push(text('p', msg("tools.noPanelsConfigured")));
  for (const panel of panels.panels) {
    const card = document.createElement('article'); card.className = 'information-panel';
    card.dataset.style = ['good', 'alert', 'error'].includes(panel.style) ? panel.style : 'info';
    const heading = document.createElement('div'); heading.className = 'panel-head';
    const icons = { wifi: '◉', network: '⇄', globe: '◎', server: '▤', cloud: '☁', clock: '◷', power: '⏻', shield: '◇' };
    const icon = text('span', Object.hasOwn(icons, panel.icon) ? icons[panel.icon] : 'ⓘ', undefined, true);
    icon.setAttribute('aria-hidden', 'true');
    if (/^#?(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(panel.icon_color || '')) icon.style.color = '#' + panel.icon_color.replace(/^#/, '');
    heading.append(icon);
    heading.append(text('h3', panel.title, undefined, true));
    if (panel.script_name != null) {
      const button = text('button', msg("common.refresh"));
      button.setAttribute('aria-label', `${msg("tools.refreshPanel")} ${panel.name}`);
      button.disabled = panels.loading || panels.pending.has(panel.name) || panel.refreshing;
      button.addEventListener('click', () => panels.refresh(panel.name));
      heading.append(button);
    }
    card.append(heading, text('pre', panel.content, 'information-panel-content', true));
    if (panels.errors.has(panel.name) || panel.error) {
      const error = text('p', msg("tools.panelRefreshFailedPrevious")); error.role = 'alert'; card.append(error);
    }
    if (panels.pending.has(panel.name) || panel.refreshing) card.append(text('p', msg("tools.refreshing")));
    else if (panel.last_updated_at_unix != null) card.append(text('small', `${msg("common.lastUpdated")} ${new Date(panel.last_updated_at_unix * 1000).toLocaleString()}`));
    cards.push(card);
  }
  byId('panels').replaceChildren(...cards);
}

function connectionRow(row, live) {
  const tr = document.createElement('tr');
  [
    row.id,
    row.peer,
    `${row.host || '—'}:${row.port || '—'}`,
    row.policy,
    formatConnectionTrace(row.decision_trace),
    connectionMethod(row),
    row.kind
  ]
    .forEach((value, index) => {
      const cell = text('td', index === 4 ? '' : value, undefined, index !== 4);
      if (index === 4) {
        cell.append(text('span', value, undefined, true));
        const details = document.createElement('details');
        details.open = openConnectionDetails.has(row.id);
        connectionDisclosures.set(row.id, details);
        details.append(text('summary', msg("common.details")));
        const fields = document.createElement('dl');
        for (const field of connectionDetailFields(row, live)) {
          fields.append(text('dt', field.label), text('dd', field.value, 'connection-detail-value', true));
        }
        details.append(fields);
        cell.append(details);
      }
      tr.append(cell);
    });
  tr.append(text('td', row.ok === false ? statusError(row) || msg("common.failed") : live ? msg("common.live") : msg("common.finished"), undefined, true));
  const action = document.createElement('td');
  if (live) {
    const button = text('button', msg("tools.kill"));
    button.addEventListener('click', async () => {
      const targetInstance = instance;
      if (!(await confirmAction(msg("tools.terminateConnection"), msg("tools.terminateConnectionId", { id: row.id })))) return;
      if (instance !== targetInstance) return;
      await SpikeApiClient.killConnection(targetInstance, row.id);
      await loadConnections();
    });
    action.append(button);
  } else action.textContent = '—';
  tr.append(action);
  return tr;
}

async function useIncrementalConnections(target) {
  if (connectionsIncremental !== null) return connectionsIncremental;
  try {
    const flag = (await SpikeApiClient.getApiInfo(target))?.features?.refresh_model;
    connectionsIncremental = Number.isInteger(flag) && flag >= 1;
    if (connectionsIncremental) connectionMirror ??= new ConnectionMirror();
  } catch (error) {
    if (error?.status === 404 || error?.status === 405) connectionsIncremental = false;
    return false;
  }
  return connectionsIncremental;
}

async function loadConnections() {
  const target = instance;
  const sequence = ++connectionsSequence;
  const incremental = await useIncrementalConnections(target);
  if (instance !== target || sequence !== connectionsSequence) return;
  if (incremental) {
    try {
      let changes = await SpikeApiClient.getConnectionsChanges(target, connectionMirror.cursor);
      if (instance !== target || sequence !== connectionsSequence) return;
      // A refresh that changed no record keeps the rendered table, and its
      // open details, as they are.
      let changed = connectionMirror.apply(changes);
      let resynced = false;
      if (changed === null) {
        connectionMirror.reset();
        changes = await SpikeApiClient.getConnectionsChanges(target, '');
        if (instance !== target || sequence !== connectionsSequence) return;
        changed = connectionMirror.apply(changes);
        if (changed === null) throw new Error('Incomplete connections snapshot');
        resynced = true;
      }
      if (!changed && !resynced && connectionSnapshot.sequence !== undefined) return;
      connectionSnapshot = connectionMirror.snapshot();
      renderConnections();
      return;
    } catch (error) {
      // The cursor may belong to a failed read; start from a full copy next time.
      if (instance === target && sequence === connectionsSequence) connectionMirror.reset();
      throw error;
    }
  }
  const data = await SpikeApiClient.getConnections(target);
  if (instance !== target || sequence !== connectionsSequence) return;
  connectionSnapshot = { live: data.live || [], recent: data.recent || [] };
  renderConnections();
}

const CONNECTIONS_FALLBACK_POLL_MS = 30000;
let stopConnections = () => {};
let pageGone = false;

// Core announces connection changes; the page fetches the change feed when a
// newer revision arrives, plus a slow poll in case an announcement is missed.
// Older Core versions are not followed, as before.
async function followConnections() {
  const target = instance;
  if (!(await useIncrementalConnections(target))) return () => {};
  const controller = new AbortController();
  let running = false;
  let again = false;
  const refresh = async () => {
    if (document.hidden) return;
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        await loadConnections();
      } while (again && !controller.signal.aborted);
    } catch { /* the next announcement or poll retries */ }
    running = false;
  };
  const stream = async () => {
    let delay = 1000;
    while (!controller.signal.aborted && instance === target) {
      let first = true;
      try {
        await SpikeApiClient.streamRefresh(target, {
          signal: controller.signal,
          onOpen: () => { delay = 1000; },
          onMessage: (message) => {
            if (message.event !== 'refresh') return;
            const revision = Number(message.data?.connections);
            if (!Number.isSafeInteger(revision)) return;
            // Another Core process restarts revisions, so the first event of a
            // connection is always compared by inequality.
            if (first ? revision !== connectionMirror.revision : revision > connectionMirror.revision) void refresh();
            first = false;
          }
        });
      } catch { /* retried below */ }
      if (controller.signal.aborted) return;
      await new Promise((resolve) => window.setTimeout(resolve, delay));
      delay = Math.min(30000, delay * 2);
    }
  };
  const timer = window.setInterval(() => void refresh(), CONNECTIONS_FALLBACK_POLL_MS);
  const onVisible = () => void refresh();
  document.addEventListener('visibilitychange', onVisible);
  void stream();
  return () => {
    controller.abort();
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

function renderConnections() {
  for (const [id, details] of connectionDisclosures) {
    if (details.open) openConnectionDetails.add(id); else openConnectionDetails.delete(id);
  }
  const ids = new Set([...connectionSnapshot.live, ...connectionSnapshot.recent].map(row => row.id));
  for (const id of openConnectionDetails) if (!ids.has(id)) openConnectionDetails.delete(id);
  connectionDisclosures = new Map();
  const query = byId('connections-filter').value.trim().toLocaleLowerCase();
  const state = byId('connections-state').value || 'all';
  const matches = (row, live) => {
    if (state === 'live' && !live || state === 'recent' && live || state === 'failed' && (live || row.ok !== false)) return false;
    return !query || [row.id, row.host, row.port, row.peer, row.policy, connectionMethod(row), row.kind].join(' ').toLocaleLowerCase().includes(query);
  };
  const rows = [
    ...connectionSnapshot.live.filter(row => matches(row, true)).map(row => connectionRow(row, true)),
    ...connectionSnapshot.recent.filter(row => matches(row, false)).map(row => connectionRow(row, false))
  ];
  byId('connections-count').textContent = `${rows.length} / ${connectionSnapshot.live.length + connectionSnapshot.recent.length}`;
  byId('connections').replaceChildren(rows.length
    ? makeTable(['ID', msg("tools.peer"), msg("common.target"), msg("common.policy"), 'Decision', msg("tools.method"), msg("common.kind"), msg("common.status2"), msg("common.action")], rows)
    : text('p', connectionSnapshot.live.length + connectionSnapshot.recent.length ? msg("common.noMatchingConnections") : msg("tools.noConnections")));
}

async function loadReadiness() {
  const target = instance;
  const sequence = ++readinessSequence;
  byId('readiness-refresh').disabled = true;
  try {
    const report = await SpikeApiClient.getReadiness(target);
    if (instance !== target || sequence !== readinessSequence) return;
    const labels = { ready: msg("common.ready"), degraded: msg("tools.degraded"), not_ready: msg("tools.notReady") };
    const rows = report.checks.map(check => {
      const row = document.createElement('tr');
      row.append(text('td', check.name, undefined, true), text('td', labels[check.status]),
        text('td', check.reason, undefined, true), text('td', `${check.active ?? '—'} / ${check.expected ?? '—'}`));
      return row;
    });
    byId('readiness').replaceChildren(text('p', labels[report.status]),
      makeTable([msg("tools.check"), msg("common.status"), msg("tools.reason"), msg("tools.activeExpected")], rows));
  } catch (error) {
    if (instance !== target || sequence !== readinessSequence) return;
    const message = text('p', error?.status === 404 ? msg("tools.readinessChecksUnavailableRuntime") : msg("tools.unableReadReadinessChecks"));
    message.role = 'alert';
    byId('readiness').replaceChildren(message);
  } finally {
    if (instance === target && sequence === readinessSequence) byId('readiness-refresh').disabled = false;
  }
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
    ? makeTable([msg("tools.pool"), msg("tools.occupancy"), msg("tools.active"), msg("tools.reuseMiss"), msg("tools.createdRebuiltEvicted"), msg("common.failures")], rows)
    : text('p', msg("tools.noSessionPoolMetrics")));
}

function loadLogs() {
  if (logRead) return logRead;
  logRead = readLogs().finally(() => { logRead = null; });
  return logRead;
}

async function readLogs() {
  const namespace = eventNamespace;
  const data = await SpikeApiClient.getLogs(instance, 200);
  if (namespace !== eventNamespace && data.event_namespace !== eventNamespace) return;
  adoptEventNamespace(data.event_namespace);
  const entries = Array.isArray(data.entries) ? data.entries : [];
  mergeLogEntries(entries);
}

function eventDestination(target) {
  switch (target) {
    case 'overview': return { href: 'popup.html#event-overview', label: msg("tools.openOverview") };
    case 'groups': return { href: 'popup.html#event-groups', label: msg("tools.openGroups") };
    case 'providers': return { href: 'popup.html#event-providers', label: msg("common.openProviders") };
    case 'config': return { href: 'popup.html#event-config', label: msg("tools.openConfig") };
    case 'connections': return { href: '#connections', label: msg("tools.openConnections") };
    case 'diagnostics': return { href: '#route-form', label: msg("tools.openDiagnostics") };
    case 'events': return { href: '#events', label: msg("tools.openEvents") };
    case 'logs': return { href: '#logs-output', label: msg("tools.openLogs") };
    default: return null;
  }
}

function eventRow(entry) {
  const tr = document.createElement('tr');
  tr.className = `event-severity-${entry.severity || 'info'}`;
  [
    new Date(entry.occurred_at_unix_ms || 0).toLocaleString(),
    entry.severity || 'info',
    entry.category || 'runtime',
    entry.summary || entry.kind,
    entry.kind
  ].forEach((value) => tr.append(text('td', value, undefined, true)));
  const action = text('td', '');
  const destination = eventDestination(entry.action?.target);
  if (destination) {
    const link = text('a', destination.label);
    link.href = destination.href;
    if (!destination.href.startsWith('#')) { link.target = '_blank'; link.rel = 'noopener'; }
    action.append(link);
  } else action.append(text('span', entry.action?.label || '—', undefined, true));
  tr.append(action);
  return tr;
}

async function loadEvents() {
  const namespace = eventNamespace;
  const data = await SpikeApiClient.getEvents(instance, 500);
  if (namespace !== eventNamespace && data.event_namespace !== eventNamespace) return;
  adoptEventNamespace(data.event_namespace);
  eventEntries = (data.events || []).filter((entry) => entry.kind !== 'log' && entry.sequence > clearedEventSequence).reverse();
  if (frozenEvents === null) renderEvents();
}

function visibleEvents() {
  const keyword = (byId('events-filter').value || '').trim().toLowerCase();
  const severity = byId('events-severity').value || 'all';
  return chronological((frozenEvents ?? eventEntries).filter((entry) => {
    if (severity !== 'all' && entry.severity !== severity) return false;
    return !keyword || [entry.category, entry.kind, entry.summary].join(' ').toLowerCase().includes(keyword);
  }), byId('events-sort').value === 'asc');
}

function renderEvents() {
  const filtered = visibleEvents();
  const source = frozenEvents ?? eventEntries;
  byId('events-filter-count').textContent = `${filtered.length} / ${source.length}`;
  byId('events-pause').textContent = frozenEvents ? msg("tools.resumeObservation") : msg("tools.pauseObservation");
  byId('events-view-clear').disabled = !source.length;
  byId('events-export-jsonl').disabled = byId('events-export-text').disabled = !filtered.length;
  byId('events').replaceChildren(filtered.length
    ? makeTable([msg("common.time"), msg("tools.severity"), msg("tools.category"), msg("common.event"), msg("common.kind"), msg("common.action")], filtered.map(eventRow))
    : text('p', msg("tools.noMatchingEvents")));
}

function mergeLogEntries(entries) {
  const bySequence = new Map(logEntries.map((entry) => [Number(entry.sequence), entry]));
  for (const entry of entries) {
    if (entry?.event_namespace && entry.event_namespace !== eventNamespace) continue;
    const sequence = Number(entry?.sequence);
    if (Number.isSafeInteger(sequence) && sequence > clearedLogSequence) bySequence.set(sequence, entry);
  }
  logEntries = Array.from(bySequence.values())
    .sort((left, right) => Number(left.sequence) - Number(right.sequence))
    .slice(-200);
  if (frozenLogs === null) renderLogs();
}

function visibleLogs() {
  const includeKeyword = byId('logs-filter').value;
  const excludeKeyword = byId('logs-filter-exclude').value;
  const direction = byId('logs-sort').value;
  const filtered = filterRuntimeLogs(frozenLogs ?? logEntries, includeKeyword, excludeKeyword);
  return sortRuntimeLogs(filtered, direction);
}

function renderLogs() {
  const visibleEntries = visibleLogs();
  const source = frozenLogs ?? logEntries;
  byId('logs-output').textContent = visibleEntries.length
    ? formatRuntimeLogs(visibleEntries)
    : source.length
      ? msg("tools.noMatchingLogs")
      : msg("tools.noRuntimeLogs");
  byId('logs-filter-count').textContent = `${visibleEntries.length} / ${source.length}`;
  byId('logs-filter-clear').disabled = !byId('logs-filter').value && !byId('logs-filter-exclude').value;
  byId('logs-pause').textContent = frozenLogs ? msg("tools.resumeObservation") : msg("tools.pauseObservation");
  byId('logs-view-clear').disabled = !source.length;
  byId('logs-export-jsonl').disabled = byId('logs-export-text').disabled = !visibleEntries.length;
}

function setLogStreamState(status) {
  const labels = {
    connecting: msg("tools.connectingLiveLogs"),
    live: msg("tools.liveLogsConnected"),
    retrying: msg("tools.reconnectingLiveLogs"),
    gap: msg("tools.someLogHistoryExpired"),
    idle: msg("tools.waitingActiveInstance")
  };
  const node = byId('logs-stream-state');
  node.textContent = labels[status] || labels.connecting;
  node.dataset.state = status || 'connecting';
}

function handleLogStreamMessage(message) {
  if (!instance || message?.instanceId !== instance.id) return;
  if (message.type === 'SPIKE_LOG_STREAM_ENTRY') mergeLogEntries([message.entry]);
  if (message.type === 'SPIKE_LOG_STREAM_STATE') {
    adoptEventNamespace(message.eventNamespace);
    setLogStreamState(message.status);
  }
}

const LOG_STREAM_RETRY_MS = 3000;
let logStreamPort = null;
let logStreamTimer = null;
let logStreamRetired = false;

function retryLogStream() {
  setLogStreamState('retrying');
  if (logStreamTimer) window.clearTimeout(logStreamTimer);
  if (!logStreamRetired) logStreamTimer = window.setTimeout(connectLogStream, LOG_STREAM_RETRY_MS);
}

// The offscreen document streams logs only while this port is open. It
// answers a new port with the stream state; silence means the document was
// not ready to accept the port, so the page asks again.
function connectLogStream() {
  if (logStreamRetired) return;
  void chrome.runtime.sendMessage({ type: 'ENSURE_LOG_STREAM' }).then((stream) => {
    if (!stream?.ok || !chrome.runtime.connect) throw new Error('log stream unavailable');
    if (logStreamRetired) return;
    const port = chrome.runtime.connect({ name: 'spike-log-stream' });
    logStreamPort = port;
    let heard = false;
    const abandon = () => {
      if (logStreamPort !== port) return;
      logStreamPort = null;
      try { port.disconnect(); } catch { /* already closed */ }
      retryLogStream();
    };
    port.onMessage.addListener((message) => {
      heard = true;
      handleLogStreamMessage(message);
    });
    port.onDisconnect.addListener(abandon);
    window.setTimeout(() => { if (!heard) abandon(); }, LOG_STREAM_RETRY_MS);
  }).catch(retryLogStream);
}

function retireLogStream() {
  logStreamRetired = true;
  if (logStreamTimer) window.clearTimeout(logStreamTimer);
  try { logStreamPort?.disconnect(); } catch { /* already closed */ }
  logStreamPort = null;
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
    ? makeTable([msg("tools.domain"), msg("common.address"), msg("tools.expires")], rows)
    : text('p', msg("tools.dnsCacheEmpty")));
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
    const evaluate = text('button', msg("tools.evaluate"));
    evaluate.addEventListener('click', () => runScript({ name: script.name }).catch(handleError));
    action.append(evaluate);
    if (script.type === 'cron') {
      const cron = text('button', msg("tools.runCron"));
      cron.addEventListener('click', () => runScript({ script_name: script.name }, true).catch(handleError));
      action.append(' ', cron);
    }
    tr.append(action);
    return tr;
  });
  byId('scripts').replaceChildren(rows.length
    ? makeTable([msg("common.name"), msg("common.type"), msg("tools.scheduleEvent"), msg("common.action")], rows)
    : text('p', msg("tools.noConfiguredScripts")));
}

function handleError(error) {
  showNotice(requestErrorText(error) || String(error));
}

async function loadAll() {
  if (!instance) return;
  const results = await Promise.allSettled([
    loadReadiness(),
    loadConnections(),
    loadSessionPools(),
    loadLogs(),
    loadEvents(),
    loadDnsCache(),
    loadScripts(),
    panels.load(),
    transfer.load(),
    loadTransferPolicies()
  ]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) handleError(failed.reason);
}

byId('refresh-all').addEventListener('click', loadAll);
byId('panels-refresh').addEventListener('click', () => panels.load());
byId('throughput-form').addEventListener('submit', event => { event.preventDefault(); return transfer.start(byId('throughput-direction').value, byId('throughput-policy').value); });
byId('throughput-cancel').addEventListener('click', () => transfer.cancel());
byId('throughput-reload').addEventListener('click', () => transfer.load());
byId('policy-probe-form').addEventListener('submit', runPolicyProbe);
byId('readiness-refresh').addEventListener('click', loadReadiness);
byId('connections-filter').addEventListener('input', renderConnections);
byId('connections-state').addEventListener('change', renderConnections);
byId('logs-refresh').addEventListener('click', () => loadLogs().catch(handleError));
byId('events-refresh').addEventListener('click', () => loadEvents().catch(handleError));
byId('events-filter').addEventListener('input', renderEvents);
byId('events-severity').addEventListener('change', renderEvents);
byId('events-sort').addEventListener('change', renderEvents);
byId('logs-pause').addEventListener('click', () => { frozenLogs = frozenLogs ? null : logEntries.slice(); renderLogs(); });
byId('events-pause').addEventListener('click', () => { frozenEvents = frozenEvents ? null : eventEntries.slice(); renderEvents(); });
for (const [kind, visible] of [['logs', visibleLogs], ['events', visibleEvents]]) {
  for (const [format, json] of [['jsonl', true], ['text', false]]) {
    byId(`${kind}-export-${format}`).addEventListener('click', () => {
      try { downloadJournal(visible(), json, `spike-${kind}`); }
      catch { showNotice(msg("tools.unableExportSelectedRecords")); }
    });
  }
}
byId('events-view-clear').addEventListener('click', () => {
  clearedEventSequence = Math.max(clearedEventSequence, ...(frozenEvents ?? eventEntries).map(entry=>Number(entry.sequence)));
  eventEntries = eventEntries.filter(entry=>entry.sequence > clearedEventSequence);
  if (frozenEvents) frozenEvents = [];
  renderEvents();
});
byId('logs-filter').addEventListener('input', renderLogs);
byId('logs-filter-exclude').addEventListener('input', renderLogs);
byId('logs-sort').addEventListener('change', renderLogs);
byId('logs-filter-clear').addEventListener('click', () => {
  const input = byId('logs-filter');
  input.value = '';
  byId('logs-filter-exclude').value = '';
  renderLogs();
  input.focus();
});
byId('logs-view-clear').addEventListener('click', () => {
  clearedLogSequence = Math.max(clearedLogSequence, ...(frozenLogs ?? logEntries).map((entry) => Number(entry.sequence)));
  logEntries = logEntries.filter(entry=>entry.sequence > clearedLogSequence);
  if (frozenLogs) frozenLogs = [];
  renderLogs();
  showNotice(msg("tools.logsClearedCurrentView"));
});
function updateReloadControls() {
  const disabled = !instance || !reloadLive || reloadBusy;
  byId('reload-preview').disabled = disabled;
  byId('reload-apply').disabled = disabled || reloadUnconfirmed;
  byId('reload-check').disabled = disabled;
}

async function runReload(mode) {
  if (!instance || !reloadLive || reloadBusy || (mode === 'apply' && reloadUnconfirmed)) return;
  const target = instance, generation = ++reloadGeneration;
  const current = () => reloadLive && instance === target && reloadGeneration === generation;
  reloadBusy = true;
  if (mode === 'preview') byId('reload-preview-output').textContent = '';
  byId('reload-operation-error').textContent = '';
  byId('reload-operation-status').textContent = msg("tools.readingRuntimeStatus");
  updateReloadControls();
  try {
    let namespace = null;
    const before = await SpikeApiClient.getStatus(target, {onRuntime: value => { namespace = value; }});
    if (!current()) return;
    if (!namespace) throw new Error('Runtime identity unavailable');
    const status = reloadStatusView(before);
    reloadNamespace = namespace;
    if (mode === 'check') {
      output('reload-result-output', status);
      reloadUnconfirmed = false;
      byId('reload-operation-status').textContent = msg("tools.runtimeStatusCheckedRetry");
      return;
    }
    let received = null;
    const options = {runtimeNamespace: namespace, onRuntime: value => { received = value; }};
    if (mode === 'preview') {
      const result = await SpikeApiClient.previewReload(target, options);
      if (!current()) return;
      if (received !== namespace || result.current_revision !== before.revision) throw new Error('Preview context changed');
      output('reload-preview-output', reloadView(result, true));
      byId('reload-operation-status').textContent = msg("tools.previewOnlyNoConfiguration");
    } else {
      reloadUnconfirmed = true;
      const result = await SpikeApiClient.reloadRuntime(target, options);
      if (!current()) return;
      if (received !== namespace || result.revision < before.revision) throw new Error('Reload context changed');
      output('reload-result-output', reloadView(result, false));
      byId('reload-preview-output').textContent = '';
      reloadUnconfirmed = false;
      byId('reload-operation-status').textContent = result.restart_required?.length
        ? msg("tools.profileReloadedRestartRequired") : msg("tools.profileReloaded");
      void loadAll();
    }
  } catch (error) {
    if (current()) {
      byId('reload-operation-status').textContent = '';
      byId('reload-operation-error').textContent = reloadUnconfirmed
        ? msg("tools.reloadResultUnconfirmedCheck")
        : msg("tools.unableReadReloadInformation")
        + (error?.status ? '\n' + requestErrorText(error) : '');
    }
  } finally {
    if (current()) { reloadBusy = false; updateReloadControls(); }
  }
}

byId('reload-preview').addEventListener('click', () => runReload('preview'));
byId('reload-apply').addEventListener('click', () => runReload('apply'));
byId('reload-check').addEventListener('click', () => runReload('check'));
byId('dns-cache-refresh').addEventListener('click', () => loadDnsCache().catch(handleError));
byId('dns-flush').addEventListener('click', async () => {
  try {
    output('dns-output', await SpikeApiClient.flushDns(instance));
    await loadDnsCache();
  } catch (error) { handleError(error); }
});

byId('route-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const body = routeContext({host: byId('route-host').value, port: byId('route-port').value,
      protocol: byId('route-protocol').value, source_ip: byId('route-source').value,
      source_port: byId('route-source-port').value, in_port: byId('route-in-port').value,
      destination_ip: byId('route-destination').value, url: byId('route-url').value,
      user_agent: byId('route-user-agent').value, process_name: byId('route-process-name').value,
      process_path: byId('route-process-path').value, process_cgroup: byId('route-process-cgroup').value});
    output('route-output', await SpikeApiClient.explainRoute(instance, body));
  } catch (error) {
    if (error.field) showNotice(`${msg("tools.invalidRouteContextCheck")} ${error.field}`);
    else handleError(error);
  }
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
  if (!instance) throw new Error(msg("tools.addSelectInstanceSpikedeck"));
  updateReloadControls();
  byId('instance-label').textContent = `${instance.name} · ${instance.baseUrl}`;
  connectLogStream();
  const refreshLogs = () => {
    if (!document.hidden) void loadLogs().catch(() => setLogStreamState('retrying'));
  };
  const timer = window.setInterval(refreshLogs, 3000);
  document.addEventListener('visibilitychange', refreshLogs);
  window.addEventListener('pagehide', () => {
    pageGone = true;
    stopConnections();
    panels.retire();
    retireLogStream();
    transfer.dispose();
    probeLive = false; probeGeneration++;
    reloadLive = false; reloadGeneration++;
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', refreshLogs);
  }, { once: true });
  await loadAll();
  void followConnections().then((stop) => { stopConnections = stop; if (pageGone) stop(); });
} catch (error) {
  handleError(error);
  byId('instance-label').textContent = msg("tools.activeInstanceUnavailable");
}
