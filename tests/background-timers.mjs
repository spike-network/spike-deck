import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_BACKOFF_MS,
  MAX_COUNTED_FAILURES,
  UNREACHABLE_GRACE_FAILURES,
  backoffDelay,
  nextFailureCount,
  timerPlan
} from '../lib/background-timers.js';

const visible = {
  idleState: 'active',
  windowFocused: true,
  watchingPorts: 0,
  proxyEnabled: true,
  hasInstance: true
};

test('keeps the default 5 s health and 1 s badge intervals while there is work', () => {
  const plan = timerPlan(visible);
  assert.equal(plan.health, 5000);
  assert.equal(plan.traffic, 1000);
  assert.deepEqual(plan.reasons, { health: 'interval', traffic: 'interval' });
  const custom = timerPlan({ ...visible, healthIntervalMs: 12000, trafficIntervalMs: 3000 });
  assert.equal(custom.health, 12000);
  assert.equal(custom.traffic, 3000);
});

test('pauses the badge when nobody can see it and health when nothing needs it', () => {
  assert.equal(timerPlan({ ...visible, idleState: 'idle' }).traffic, null);
  assert.equal(timerPlan({ ...visible, idleState: 'idle' }).health, 5000);
  const locked = timerPlan({ ...visible, idleState: 'locked' });
  assert.deepEqual([locked.health, locked.traffic], [null, null]);
  assert.deepEqual(locked.reasons, { health: 'locked', traffic: 'locked' });
  assert.equal(timerPlan({ ...visible, windowFocused: false }).reasons.traffic, 'unfocused');
  assert.equal(timerPlan({ ...visible, watchingPorts: 1 }).reasons.traffic, 'popup-sampling');
  assert.equal(timerPlan({ ...visible, hasInstance: false }).reasons.traffic, 'no-instance');
  const off = timerPlan({ ...visible, proxyEnabled: false });
  assert.equal(off.health, null);
  assert.equal(off.reasons.health, 'proxy-off');
  assert.equal(off.traffic, 1000);
});

test('backs off on a bounded schedule while Spike is unreachable', () => {
  const badge = [];
  const health = [];
  for (let failures = 0; failures <= 10; failures += 1) {
    badge.push(backoffDelay(1000, failures));
    health.push(backoffDelay(5000, failures));
  }
  assert.deepEqual(badge, [1000, 1000, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
  assert.deepEqual(health, [5000, 5000, 5000, 10000, 20000, 30000, 30000, 30000, 30000, 30000, 30000]);
  for (let failures = 0; failures <= MAX_COUNTED_FAILURES + 5; failures += 1) {
    const delay = backoffDelay(1000, failures);
    assert.ok(delay >= 1000 && delay <= MAX_BACKOFF_MS, `delay ${delay} out of bounds`);
  }
  // A long configured interval is never shortened by the backoff cap.
  assert.equal(backoffDelay(60000, 20), 60000);
  // Bad inputs fall back to a one-second floor rather than a busy loop.
  assert.equal(backoffDelay(0, 0), 1000);
  assert.equal(backoffDelay(Number.NaN, Number.NaN), 1000);
  assert.equal(backoffDelay(-5, -5), 1000);
  const plan = timerPlan({ ...visible, failures: UNREACHABLE_GRACE_FAILURES });
  assert.deepEqual(plan.reasons, { health: 'backoff', traffic: 'backoff' });
  assert.equal(plan.traffic, 2000);
});

test('a success resets the failure count and the count is capped', () => {
  assert.equal(nextFailureCount(7, true), 0);
  assert.equal(nextFailureCount(0, false), 1);
  assert.equal(nextFailureCount(undefined, false), 1);
  assert.equal(nextFailureCount(MAX_COUNTED_FAILURES, false), MAX_COUNTED_FAILURES);
});
