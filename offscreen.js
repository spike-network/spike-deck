/** Ticks while the user wants Chrome proxy takeover. chrome.alarms cannot fire faster than 30s. */
const HEALTH_TICK_MS = 3000;

function tick() {
  chrome.runtime.sendMessage({ type: 'SPIKE_HEALTH_TICK' }).catch(() => {});
}

tick();
setInterval(tick, HEALTH_TICK_MS);
