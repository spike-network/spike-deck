/**
 * Decides when the offscreen document's health and traffic-badge timers run.
 *
 * The configured intervals (default 5 s health, 1 s badge) are kept while the
 * timers have something to do. They pause when nobody can see the badge or
 * nothing needs protecting, and back off on a bounded schedule while Spike is
 * unreachable. Pure functions so the policy is testable without a browser.
 */

/** Seconds without input before chrome.idle reports "idle". */
export const IDLE_DETECTION_SECONDS = 120;
/** Consecutive failed probes tolerated at the configured interval. */
export const UNREACHABLE_GRACE_FAILURES = 3;
/** Longest delay between probes while Spike is unreachable. */
export const MAX_BACKOFF_MS = 30000;
/** Cap on the failure counter so the exponent stays small. */
export const MAX_COUNTED_FAILURES = 32;

/**
 * Delay before the next probe after `failures` consecutive failures. The first
 * few failures keep the configured interval so a brief restart is noticed
 * quickly; after that the delay doubles up to MAX_BACKOFF_MS. It never drops
 * below the configured interval, so a long user setting is not shortened.
 */
export function backoffDelay(baseMs, failures) {
  const base = Math.max(1000, Number(baseMs) || 1000);
  const count = Math.max(0, Math.min(MAX_COUNTED_FAILURES, Math.trunc(Number(failures) || 0)));
  if (count < UNREACHABLE_GRACE_FAILURES) return base;
  const doubled = base * 2 ** (count - UNREACHABLE_GRACE_FAILURES + 1);
  return Math.max(base, Math.min(MAX_BACKOFF_MS, doubled));
}

/**
 * @param {{
 *   idleState?: 'active'|'idle'|'locked',
 *   windowFocused?: boolean,
 *   watchingPorts?: number,
 *   proxyEnabled?: boolean,
 *   hasInstance?: boolean,
 *   healthIntervalMs?: number,
 *   trafficIntervalMs?: number,
 *   failures?: number
 * }} facts
 * @returns {{health: number|null, traffic: number|null, reasons: {health: string, traffic: string}}}
 *   A delay in milliseconds, or null when the timer is paused; `reasons`
 *   names why, for logs and tests.
 */
export function timerPlan(facts = {}) {
  const idleState = facts.idleState || 'active';
  const failures = facts.failures || 0;
  const backingOff = failures >= UNREACHABLE_GRACE_FAILURES;

  let health = null;
  let healthReason;
  // The health check exists to release and re-take the browser proxy. With
  // proxy mode off there is nothing to protect; while the screen is locked
  // nobody browses, and unlocking resumes it at once.
  if (!facts.proxyEnabled) healthReason = 'proxy-off';
  else if (idleState === 'locked') healthReason = 'locked';
  else {
    health = backoffDelay(facts.healthIntervalMs ?? 5000, failures);
    healthReason = backingOff ? 'backoff' : 'interval';
  }

  let traffic = null;
  let trafficReason;
  // The badge is only worth sampling when someone can look at it. The popup
  // samples on its own while open, so the background timer stands down.
  if (!facts.hasInstance) trafficReason = 'no-instance';
  else if (idleState !== 'active') trafficReason = idleState;
  else if (facts.windowFocused === false) trafficReason = 'unfocused';
  else if ((facts.watchingPorts || 0) > 0) trafficReason = 'popup-sampling';
  else {
    traffic = backoffDelay(facts.trafficIntervalMs ?? 1000, failures);
    trafficReason = backingOff ? 'backoff' : 'interval';
  }

  return { health, traffic, reasons: { health: healthReason, traffic: trafficReason } };
}

export function nextFailureCount(failures, ok) {
  return ok ? 0 : Math.min(MAX_COUNTED_FAILURES, (failures || 0) + 1);
}
