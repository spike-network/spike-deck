import { StorageManager } from './lib/storage.js';
import { SpikeApiClient } from './lib/spike-client.js';

/**
 * Offscreen document for SpikeDeck.
 * Maintains sub-minute timers:
 * 1. Spike proxy health check (default 5s) and
 * 2. traffic rate badge update (default 1s). The service worker decides
 *    when each runs and at what period (lib/background-timers.js) and sends
 *    the plan here; a paused timer sends nothing, so the worker can sleep.
 * 3. Runtime log SSE with bounded reconnect backoff and sequence resume. It
 *    runs only while a page holds a log stream port open.
 */

const LOG_STREAM_PORT = 'spike-log-stream';
const MIN_TIMER_MS = 1000;
const MAX_TIMER_MS = 300000;

let healthTimer = null;
let trafficTimer = null;
let healthPeriodMs = null;
let trafficPeriodMs = null;
let logAbort = null;
let logGeneration = 0;
let logRetryTimer = null;
let logRetryMs = 1000;
let logAfter = 0;
let logNamespace = '';
let logInstanceId = null;
let logGapDetected = false;
const logPorts = new Set();
let lastLogState = null;

function postToLogPort(port, message) {
  try {
    port.postMessage(message);
  } catch {
    logPorts.delete(port);
  }
}

function publishLogState(status, namespaceKnown = false) {
  lastLogState = {
    type: 'SPIKE_LOG_STREAM_STATE',
    instanceId: logInstanceId,
    status,
    after: logAfter,
    eventNamespace: namespaceKnown ? logNamespace : undefined
  };
  for (const port of logPorts) postToLogPort(port, lastLogState);
}

function publishLogEntry(entry) {
  const message = { type: 'SPIKE_LOG_STREAM_ENTRY', instanceId: logInstanceId, entry };
  for (const port of logPorts) postToLogPort(port, message);
}

function clearLogRetry() {
  if (logRetryTimer) clearTimeout(logRetryTimer);
  logRetryTimer = null;
}

function scheduleLogRetry(generation, delay = logRetryMs) {
  clearLogRetry();
  if (generation !== logGeneration) return;
  publishLogState('retrying');
  const jitter = Math.floor(delay * Math.random() * 0.2);
  logRetryTimer = setTimeout(() => void startLogStream(generation), delay + jitter);
  logRetryMs = Math.min(30000, Math.max(1000, delay * 2));
}

async function startLogStream(expectedGeneration = null) {
  const generation = expectedGeneration ?? ++logGeneration;
  if (generation !== logGeneration) return;
  clearLogRetry();
  logAbort?.abort();
  logAbort = null;

  let instance;
  try {
    await StorageManager.init();
    instance = await StorageManager.getActiveInstance();
  } catch {
    scheduleLogRetry(generation);
    return;
  }
  if (generation !== logGeneration) return;
  if (!instance) {
    logInstanceId = null;
    logAfter = 0;
    logNamespace = '';
    publishLogState('idle');
    return;
  }
  if (instance.id !== logInstanceId) {
    logInstanceId = instance.id;
    logAfter = 0;
    logNamespace = '';
  }

  const controller = new AbortController();
  logAbort = controller;
  logGapDetected = false;
  publishLogState('connecting');
  try {
    await SpikeApiClient.streamLogs(instance, {
      after: logAfter,
      namespace: logNamespace,
      signal: controller.signal,
      onOpen: () => {
        if (generation !== logGeneration) return;
        logRetryMs = 1000;
        publishLogState('live', false);
      },
      onMessage: (message) => {
        if (generation !== logGeneration || controller.signal.aborted) return;
        if (message.event === 'stream') {
          const namespace = message.data?.event_namespace;
          if (typeof namespace === 'string' && namespace) {
            if (namespace !== logNamespace || message.data.reset === true) logAfter = 0;
            logNamespace = namespace;
            publishLogState('live', true);
          }
          return;
        }
        if (message.event === 'gap') {
          if (message.data?.reason === 'history_evicted') {
            publishLogState('gap');
            return;
          }
          logGapDetected = true;
          controller.abort();
          return;
        }
        if (message.event !== 'log' || !message.data || typeof message.data !== 'object') return;
        if (message.data.event_namespace && message.data.event_namespace !== logNamespace) return;
        const sequence = Number(message.data.sequence);
        if (!Number.isSafeInteger(sequence) || sequence <= logAfter) return;
        logAfter = sequence;
        publishLogEntry(message.data);
      }
    });
  } catch (error) {
    if (generation !== logGeneration) return;
    if (controller.signal.aborted && !logGapDetected) return;
  }
  if (generation === logGeneration) {
    scheduleLogRetry(generation, logGapDetected ? 0 : logRetryMs);
  }
}

function stopLogStream() {
  logGeneration += 1;
  logAbort?.abort();
  logAbort = null;
  clearLogRetry();
  lastLogState = null;
}

function restartLogStreamSoon() {
  if (logPorts.size === 0) return;
  const generation = ++logGeneration;
  logAbort?.abort();
  clearLogRetry();
  logRetryTimer = setTimeout(() => void startLogStream(generation), 100);
}

// The sequence cursor survives a stop, so a page that reconnects resumes
// where the last one left off and reads older entries from the journal.
if (chrome.runtime?.onConnect?.addListener) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== LOG_STREAM_PORT) return;
    logPorts.add(port);
    port.onDisconnect.addListener(() => {
      logPorts.delete(port);
      if (logPorts.size === 0) stopLogStream();
    });
    if (logPorts.size === 1) restartLogStreamSoon();
    else if (lastLogState) postToLogPort(port, lastLogState);
  });
}

function sendHealthTick() {
  chrome.runtime.sendMessage({ type: 'SPIKE_HEALTH_TICK' }).catch(() => {});
}

function sendTrafficTick() {
  chrome.runtime.sendMessage({ type: 'SPIKE_TRAFFIC_TICK' }).catch(() => {});
}

function timerPeriod(value) {
  const ms = Number(value);
  if (value === null || !Number.isFinite(ms)) return null;
  return Math.max(MIN_TIMER_MS, Math.min(MAX_TIMER_MS, Math.round(ms)));
}

// Only a changed period restarts a timer, so repeated plans do not reset it.
function applyTimerPlan(plan) {
  const health = timerPeriod(plan?.health);
  const traffic = timerPeriod(plan?.traffic);
  if (health !== healthPeriodMs) {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = health ? setInterval(sendHealthTick, health) : null;
    healthPeriodMs = health;
  }
  if (traffic !== trafficPeriodMs) {
    if (trafficTimer) clearInterval(trafficTimer);
    trafficTimer = traffic ? setInterval(sendTrafficTick, traffic) : null;
    trafficPeriodMs = traffic;
  }
}

async function requestTimerPlan() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'SPIKE_TIMER_PLAN_REQUEST' });
    if (response?.ok && response.plan) applyTimerPlan(response.plan);
  } catch {
    // The worker re-sends the plan from its periodic alarm.
  }
}

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.instances || changes.activeInstanceId) restartLogStreamSoon();
  });
}

if (chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SPIKE_TIMER_PLAN') applyTimerPlan(message.plan);
    if (message?.type === 'RESTART_OFFSCREEN_TIMERS') void requestTimerPlan();
    if (message?.type === 'RESTART_LOG_STREAM') restartLogStreamSoon();
  });
}

void requestTimerPlan();
restartLogStreamSoon();
