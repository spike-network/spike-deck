import { StorageManager } from './lib/storage.js';
import { SpikeApiClient } from './lib/spike-client.js';

/**
 * Offscreen document for SpikeDeck.
 * Maintains sub-minute timers:
 * 1. Spike proxy health check (default 5s, runs continuously regardless of window visibility).
 * 2. Traffic rate badge update (default 1s, background only samples when Chrome window is visible).
 * 3. Runtime log SSE with bounded reconnect backoff and sequence resume.
 */

const DEFAULT_HEALTH_CHECK_INTERVAL_SEC = 5;
const DEFAULT_TRAFFIC_REFRESH_INTERVAL_SEC = 1;

let healthIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_SEC * 1000;
let trafficIntervalMs = DEFAULT_TRAFFIC_REFRESH_INTERVAL_SEC * 1000;

let healthTimer = null;
let trafficTimer = null;
let logAbort = null;
let logGeneration = 0;
let logRetryTimer = null;
let logRetryMs = 1000;
let logAfter = 0;
let logInstanceId = null;
let logGapDetected = false;

function publishLogState(status) {
  chrome.runtime.sendMessage({
    type: 'SPIKE_LOG_STREAM_STATE',
    instanceId: logInstanceId,
    status,
    after: logAfter
  }).catch(() => {});
}

function publishLogEntry(entry) {
  chrome.runtime.sendMessage({
    type: 'SPIKE_LOG_STREAM_ENTRY',
    instanceId: logInstanceId,
    entry
  }).catch(() => {});
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
  if (!instance) {
    logInstanceId = null;
    logAfter = 0;
    publishLogState('idle');
    return;
  }
  if (instance.id !== logInstanceId) {
    logInstanceId = instance.id;
    logAfter = 0;
  }

  const controller = new AbortController();
  logAbort = controller;
  logGapDetected = false;
  publishLogState('connecting');
  try {
    await SpikeApiClient.streamLogs(instance, {
      after: logAfter,
      signal: controller.signal,
      onOpen: () => {
        logRetryMs = 1000;
        publishLogState('live');
      },
      onMessage: (message) => {
        if (message.event === 'gap') {
          logGapDetected = true;
          controller.abort();
          return;
        }
        if (message.event !== 'log' || !message.data || typeof message.data !== 'object') return;
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

function restartLogStreamSoon() {
  const generation = ++logGeneration;
  logAbort?.abort();
  clearLogRetry();
  logRetryTimer = setTimeout(() => void startLogStream(generation), 100);
}

function sendHealthTick() {
  chrome.runtime.sendMessage({ type: 'SPIKE_HEALTH_TICK' }).catch(() => {});
}

function sendTrafficTick() {
  chrome.runtime.sendMessage({ type: 'SPIKE_TRAFFIC_TICK' }).catch(() => {});
}

function restartTimers() {
  if (healthTimer) clearInterval(healthTimer);
  if (trafficTimer) clearInterval(trafficTimer);

  healthTimer = setInterval(sendHealthTick, healthIntervalMs);
  trafficTimer = setInterval(sendTrafficTick, trafficIntervalMs);
}

async function loadConfigAndStart() {
  try {
    const data = await chrome.storage.local.get(['healthCheckInterval', 'trafficRefreshInterval']);
    const hSec = Number(data.healthCheckInterval);
    const tSec = Number(data.trafficRefreshInterval);
    healthIntervalMs = Math.max(1, (Number.isFinite(hSec) && hSec > 0 ? hSec : DEFAULT_HEALTH_CHECK_INTERVAL_SEC)) * 1000;
    trafficIntervalMs = Math.max(1, (Number.isFinite(tSec) && tSec > 0 ? tSec : DEFAULT_TRAFFIC_REFRESH_INTERVAL_SEC)) * 1000;
  } catch {
    healthIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_SEC * 1000;
    trafficIntervalMs = DEFAULT_TRAFFIC_REFRESH_INTERVAL_SEC * 1000;
  }

  sendHealthTick();
  sendTrafficTick();
  restartTimers();
  restartLogStreamSoon();
}

// React when preferences change in storage
if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let changed = false;
    if (changes.healthCheckInterval) {
      const hSec = Number(changes.healthCheckInterval.newValue);
      healthIntervalMs = Math.max(1, (Number.isFinite(hSec) && hSec > 0 ? hSec : DEFAULT_HEALTH_CHECK_INTERVAL_SEC)) * 1000;
      changed = true;
    }
    if (changes.trafficRefreshInterval) {
      const tSec = Number(changes.trafficRefreshInterval.newValue);
      trafficIntervalMs = Math.max(1, (Number.isFinite(tSec) && tSec > 0 ? tSec : DEFAULT_TRAFFIC_REFRESH_INTERVAL_SEC)) * 1000;
      changed = true;
    }
    if (changed) {
      restartTimers();
    }
    if (changes.instances || changes.activeInstanceId) restartLogStreamSoon();
  });
}

// Listen for direct restart or configuration requests
if (chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'RESTART_OFFSCREEN_TIMERS') {
      void loadConfigAndStart();
    }
    if (message?.type === 'RESTART_LOG_STREAM') restartLogStreamSoon();
  });
}

void loadConfigAndStart();
