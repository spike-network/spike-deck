/**
 * Offscreen document for SpikeDeck.
 * Maintains sub-minute timers:
 * 1. Spike proxy health check (default 5s, runs continuously regardless of window visibility).
 * 2. Traffic rate badge update (default 1s, background only samples when Chrome window is visible).
 */

const DEFAULT_HEALTH_CHECK_INTERVAL_SEC = 5;
const DEFAULT_TRAFFIC_REFRESH_INTERVAL_SEC = 1;

let healthIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_SEC * 1000;
let trafficIntervalMs = DEFAULT_TRAFFIC_REFRESH_INTERVAL_SEC * 1000;

let healthTimer = null;
let trafficTimer = null;

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
  });
}

// Listen for direct restart or configuration requests
if (chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'RESTART_OFFSCREEN_TIMERS') {
      void loadConfigAndStart();
    }
  });
}

void loadConfigAndStart();
