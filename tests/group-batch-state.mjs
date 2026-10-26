import assert from "node:assert/strict";
import { GroupTestBatch } from "../lib/group-batch.js";
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const receipt = (value) => ({ value, namespace: "mock-runtime" });
const task = (group = "mock-one", extra = {}) => ({
  id: 1,
  revision: 7,
  group,
  status: "running",
  completed: 0,
  created_at_unix_ms: 1,
  task_namespace: "mock-tasks",
  update_sequence: 1,
  ...extra,
});
const originalSet = globalThis.setTimeout,
  originalClear = globalThis.clearTimeout;
const timers = new Map(),
  sessions = [];
let timerID = 0;
globalThis.setTimeout = (fn) => {
  timers.set(++timerID, fn);
  return timerID;
};
globalThis.clearTimeout = (id) => timers.delete(id);
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const tick = async () => {
  const queued = [...timers.values()];
  timers.clear();
  for (const callback of queued) await callback();
  await settle();
};
function fixture(overrides = {}) {
  const starts = [],
    cancels = [],
    reads = [],
    records = [];
  const api = {
    context: async () =>
      receipt({
        revision: 7,
        groups: [{ name: "mock-one" }, { name: "mock-two" }, { name: "mock-three" }],
      }),
    start: async (group) => {
      starts.push(group);
      return receipt(task(group, { id: starts.length }));
    },
    get: async (id) => {
      reads.push(id);
      return receipt(
        task(starts[id - 1], { id, status: "completed", completed: 3, update_sequence: 2 }),
      );
    },
    cancel: async (id) => {
      cancels.push(id);
      return receipt(task(starts[id - 1], { id, status: "cancelled", update_sequence: 2 }));
    },
    record: (value) => records.push(value),
    active: () => false,
    ...overrides,
  };
  const session = new GroupTestBatch(api, 7, () => {});
  sessions.push(session);
  return { session, starts, cancels, reads, records, api };
}
try {
  {
    const { session, starts, records } = fixture();
    await session.load();
    assert.equal(starts.length, 0, "catalog reads never test");
    session.start(["mock-one", "mock-two", "mock-one", "mock-three"]);
    session.start(["mock-two"]);
    await settle();
    assert.deepEqual(starts, ["mock-one"], "no second group before completion");
    await tick();
    assert.deepEqual(starts, ["mock-one", "mock-two"]);
    await tick();
    await tick();
    assert.deepEqual(starts, ["mock-one", "mock-two", "mock-three"]);
    assert.equal(session.running, false);
    assert.equal(session.done, 3);
    assert.equal(records.length, 6);
  }
  {
    const pending = deferred();
    let cancels = 0;
    const { session } = fixture({
      start: () => pending.promise,
      cancel: async () => {
        cancels++;
        return receipt(task("mock-one", { status: "cancelled" }));
      },
    });
    await session.load();
    session.start(["mock-one", "mock-two"]);
    await session.cancel();
    assert.equal(cancels, 0);
    pending.resolve(receipt(task()));
    await settle();
    assert.equal(cancels, 1, "pending-start Cancel is sent after the ID arrives");
    assert.equal(session.running, false);
  }
  {
    const { session, starts } = fixture({
      get: async () => {
        throw Error("mock-secret https://example.test/mock");
      },
    });
    await session.load();
    session.start(["mock-one", "mock-two"]);
    await settle();
    await tick();
    await tick();
    await tick();
    assert.equal(session.paused, true);
    assert.equal(timers.size, 0);
    assert.deepEqual(starts, ["mock-one"]);
    assert.equal(session.task.status, "running", "query failure never invents a terminal state");
    assert.equal(session.message.includes("mock-secret"), false);
    await session.poll();
    assert.deepEqual(starts, ["mock-one"], "retry only queries the original task");
    session.forget();
    assert.equal(session.ready, false);
  }
  {
    const { session, starts } = fixture({
      start: async () => {
        throw Error("mock-secret");
      },
    });
    await session.load();
    session.start(["mock-one", "mock-two"]);
    await settle();
    assert.equal(session.paused, true);
    assert.equal(session.message.includes("unconfirmed"), true);
    assert.equal(session.message.includes("mock-secret"), false);
    session.start(["mock-two"]);
    await settle();
    assert.equal(starts.length, 0);
    assert.equal(session.reserved.length, 2);
  }
  {
    const { session, starts } = fixture({
      get: async () => ({ namespace: "mock-new-runtime", value: task() }),
    });
    await session.load();
    session.start(["mock-one", "mock-two"]);
    await settle();
    await tick();
    assert.equal(session.ready, false);
    assert.equal(session.running, false);
    assert.deepEqual(starts, ["mock-one"]);
  }
  {
    const { session, records } = fixture({
      get: async () => receipt(task("mock-one", { created_at_unix_ms: 2 })),
    });
    await session.load();
    session.start(["mock-one", "mock-two"]);
    await settle();
    await tick();
    assert.equal(session.paused, true);
    assert.equal(records.length, 1, "reused ID cannot replace an accepted task");
  }
  {
    const pending = deferred();
    const { session, cancels, api } = fixture();
    api.start = () => pending.promise;
    api.cancel = async (id) => {
      cancels.push(id);
      return receipt(task("mock-one", { status: "cancelled" }));
    };
    await session.load();
    session.start(["mock-one", "mock-two"]);
    await session.cancel();
    session.dispose();
    pending.resolve(receipt(task()));
    await settle();
    assert.deepEqual(cancels, [1], "explicit pending Cancel survives observer disposal");
  }
  {
    const pending = deferred();
    const { session, starts, api } = fixture();
    api.get = () => pending.promise;
    await session.load();
    session.start(["mock-one", "mock-two"]);
    await settle();
    const read = session.poll();
    await session.cancel();
    assert.equal(session.reading, true);
    pending.resolve(receipt(task()));
    await read;
    await settle();
    assert.deepEqual(starts, ["mock-one"]);
    assert.equal(session.running, false);
  }
  {
    const { session, starts } = fixture({ active: (group) => group === "mock-one" });
    await session.load();
    session.start(["mock-one", "mock-two"]);
    await settle();
    assert.deepEqual(starts, ["mock-two"]);
    session.dispose();
    await tick();
    assert.deepEqual(starts, ["mock-two"]);
  }
  console.log(
    "group batch: serial admission, pending cancel, bounded observation, identity and disposal tests passed",
  );
} finally {
  for (const session of sessions) session.dispose();
  globalThis.setTimeout = originalSet;
  globalThis.clearTimeout = originalClear;
}
