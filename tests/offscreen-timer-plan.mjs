import assert from 'node:assert/strict';

// The offscreen document runs only the timers the worker's plan asks for and
// restarts one only when its period changes.
const sent = [];
const intervals = new Map();
let nextId = 1;
let onMessage = null;
const original = { setInterval, clearInterval };

globalThis.chrome = {
  storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
  runtime: {
    async sendMessage(message) {
      sent.push(message.type);
      if (message.type === 'SPIKE_TIMER_PLAN_REQUEST') {
        return { ok: true, plan: { health: 5000, traffic: 1000 } };
      }
      return undefined;
    },
    onMessage: { addListener: (listener) => { onMessage = listener; } },
    onConnect: { addListener() {} }
  }
};
globalThis.setInterval = (callback, delay) => {
  const id = nextId++;
  intervals.set(id, { callback, delay });
  return id;
};
globalThis.clearInterval = (id) => intervals.delete(id);

const settle = () => new Promise((resolve) => setImmediate(resolve));
const periods = () => [...intervals.values()].map((timer) => timer.delay).sort((a, b) => a - b);

try {
  await import('../offscreen.js');
  await settle();
  assert.deepEqual(sent, ['SPIKE_TIMER_PLAN_REQUEST'], 'asks the worker for a plan, no eager ticks');
  assert.deepEqual(periods(), [1000, 5000]);

  const before = [...intervals.keys()];
  onMessage({ type: 'SPIKE_TIMER_PLAN', plan: { health: 5000, traffic: 1000 } });
  assert.deepEqual([...intervals.keys()], before, 'an unchanged plan keeps the running timers');

  onMessage({ type: 'SPIKE_TIMER_PLAN', plan: { health: 5000, traffic: null } });
  assert.deepEqual(periods(), [5000], 'a paused badge timer is cleared');

  onMessage({ type: 'SPIKE_TIMER_PLAN', plan: { health: null, traffic: null } });
  assert.equal(intervals.size, 0, 'nothing runs while both are paused');

  onMessage({ type: 'SPIKE_TIMER_PLAN', plan: { health: 20000, traffic: 2 } });
  assert.deepEqual(periods(), [1000, 20000], 'periods are clamped to at least one second');

  onMessage({ type: 'SPIKE_TIMER_PLAN', plan: { health: 10 ** 9, traffic: 'soon' } });
  assert.deepEqual(periods(), [300000], 'periods are bounded and invalid ones pause');

  sent.length = 0;
  for (const timer of intervals.values()) timer.callback();
  assert.deepEqual(sent, ['SPIKE_HEALTH_TICK']);

  onMessage({ type: 'RESTART_OFFSCREEN_TIMERS' });
  await settle();
  assert.deepEqual(periods(), [1000, 5000], 'a restart re-reads the plan from the worker');
} finally {
  globalThis.setInterval = original.setInterval;
  globalThis.clearInterval = original.clearInterval;
  for (const id of intervals.keys()) intervals.delete(id);
}

console.log('offscreen timer plan tests passed');
