import assert from "node:assert/strict";

const storage = {
  instances: ["a", "b"].map((id) => ({ id, baseUrl: `http://${id}.example.test`, secret: "" })),
  enableProxyMode: false,
};
const listeners = {};
const event = (key) => ({
  addListener(fn) {
    listeners[key] = fn;
  },
});
let beforeWrite = async () => {};
const writes = [];
globalThis.chrome = {
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  storage: {
    local: {
      async get(keys) {
        return structuredClone(Object.fromEntries(keys.map((key) => [key, storage[key]])));
      },
      async set(values) {
        await beforeWrite(values);
        writes.push(structuredClone(values));
        Object.assign(storage, structuredClone(values));
      },
    },
  },
  runtime: {
    onMessage: event("message"),
    onInstalled: event("installed"),
    onStartup: event("startup"),
    onConnect: event("connect"),
  },
};
const { SpikeApiClient } = await import("../lib/spike-client.js");
let nextId = 1;
let starts = 0;
let polls = 0;
let beforeStart = async () => {};
let beforePoll = async () => {};
let coreStatus = "running";
let coreTaskNamespace = "provider-process-1";
let statusReads = 0;
SpikeApiClient.startProviderRefreshTask = async () => {
  starts += 1;
  await beforeStart();
  return {
    id: nextId++,
    task_namespace: coreTaskNamespace,
    started_at_unix_ms: Date.now(),
    provider_results: [],
  };
};
SpikeApiClient.getProviderRefreshTask = async (_, id) => {
  polls += 1;
  await beforePoll();
  return {
    id,
    task_namespace: coreTaskNamespace,
    status: coreStatus,
    completed_at_unix_ms: Date.now(),
    provider_results: [
      { provider_id: "source", status: coreStatus === "running" ? "pending" : coreStatus },
    ],
  };
};
SpikeApiClient.getProviders = async () => ({ providers: [{ id: "source", status: "ready" }] });
SpikeApiClient.getStatus = async () => {
  statusReads += 1;
  return { provider_refresh: { refreshing: true } };
};
const { startProviderRefreshTask, getProviderRefreshTask } = await import("../background.js");
const message = (body) => new Promise((resolve) => listeners.message(body, {}, resolve));
const dismiss = (instanceId, taskId) =>
  message({ type: "DISMISS_PROVIDER_REFRESH_TASK", instanceId, taskId });
const start = (id) => startProviderRefreshTask(id, "source");
function gate() {
  const entered = Promise.withResolvers();
  const done = Promise.withResolvers();
  return {
    entered: entered.promise,
    release: done.resolve,
    async wait() {
      entered.resolve();
      await done.promise;
    },
  };
}
function reset() {
  storage.providerRefreshTasks = {};
  storage.providerRefreshFailures = {};
  writes.length = 0;
  starts = polls = 0;
  coreStatus = "running";
  coreTaskNamespace = "provider-process-1";
  statusReads = 0;
  beforeWrite = beforeStart = beforePoll = async () => {};
}

// Concurrent instances retain both task IDs and both failure histories.
reset();
{
  const [a, b] = await Promise.all([start("a"), start("b")]);
  assert.notEqual(a.coreTaskId, b.coreTaskId);
  assert.equal(a.coreTaskNamespace, coreTaskNamespace);
  assert.equal(b.coreTaskNamespace, coreTaskNamespace);
  assert.equal(storage.providerRefreshTasks.a.id, a.id);
  assert.equal(storage.providerRefreshTasks.b.id, b.id);
  coreStatus = "failed";
  await Promise.all([getProviderRefreshTask("a"), getProviderRefreshTask("b")]);
  for (const id of ["a", "b"]) {
    assert.equal(storage.providerRefreshTasks[id].status, "failed");
    assert.ok(storage.providerRefreshFailures[id].source);
  }
}

// A same-numbered task from a restarted Core is unrelated and cannot record failure.
reset();
{
  const task = await start("a");
  coreTaskNamespace = "provider-process-2";
  const reconciled = await getProviderRefreshTask("a");
  assert.equal(reconciled.id, task.id);
  assert.equal(reconciled.status, "unknown");
  assert.match(reconciled.error, /Core 已重启/);
  assert.deepEqual(storage.providerRefreshFailures, {});
  assert.equal(starts, 1);
}

// Legacy records without a namespace use status reconciliation, never numeric task lookup.
reset();
{
  storage.providerRefreshTasks.a = {
    schemaVersion: 2,
    id: "legacy-task",
    instanceId: "a",
    providerId: "source",
    requestedProviderIds: ["source"],
    status: "running",
    startedAtUnix: Math.floor(Date.now() / 1000),
    coreTaskId: 1,
  };
  const legacy = await getProviderRefreshTask("a");
  assert.equal(legacy.status, "running");
  assert.equal(polls, 0);
  assert.equal(statusReads, 1);
}

// Admission is reserved before POST. Queries and overlapping starts join it.
reset();
{
  const pending = gate();
  beforeStart = () => pending.wait();
  const first = start("a");
  await pending.entered;
  const second = start("a");
  const read = getProviderRefreshTask("a");
  pending.release();
  const results = await Promise.all([first, second, read]);
  assert.equal(starts, 1);
  assert.equal(polls, 0);
  assert.ok(results.every((task) => task.id === results[0].id));
}

// Polling is single-flight, and dismissal cannot discard a running task.
reset();
{
  const task = await start("a");
  const pending = gate();
  beforePoll = () => pending.wait();
  const first = getProviderRefreshTask("a");
  await pending.entered;
  const second = getProviderRefreshTask("a");
  assert.equal((await dismiss("a", task.id)).task.status, "running");
  coreStatus = "succeeded";
  pending.release();
  const results = await Promise.all([first, second]);
  assert.equal(polls, 1);
  assert.ok(results.every((value) => value.status === "succeeded"));
  assert.equal(storage.providerRefreshTasks.a.status, "succeeded");
}

// A popup's old dismissal does not delete a newer task, including during acceptance.
reset();
{
  const old = await start("a");
  coreStatus = "succeeded";
  await getProviderRefreshTask("a");
  const pending = gate();
  beforeStart = () => pending.wait();
  const newer = start("a");
  await pending.entered;
  await dismiss("a", old.id);
  pending.release();
  assert.equal(storage.providerRefreshTasks.a.id, (await newer).id);
  assert.equal(storage.providerRefreshTasks.a.status, "running");
}

// Completion and dismissal use one queue; failure outcomes survive dismissal.
reset();
{
  const task = await start("a");
  coreStatus = "failed";
  const pending = gate();
  beforeWrite = async (values) => {
    if (values.providerRefreshTasks?.a?.status === "failed") await pending.wait();
  };
  const completing = getProviderRefreshTask("a");
  await pending.entered;
  const closing = dismiss("a", task.id);
  pending.release();
  await completing;
  assert.equal((await closing).task, null);
  assert.equal(storage.providerRefreshTasks.a, undefined);
  assert.ok(storage.providerRefreshFailures.a.source);
  assert.equal(await getProviderRefreshTask("a"), null);
}

// A rejected storage commit cannot leave outcomes and task status in different states.
reset();
{
  await start("a");
  coreStatus = "failed";
  beforeWrite = async () => {
    throw new Error("mock storage failure");
  };
  await assert.rejects(getProviderRefreshTask("a"), /mock storage failure/);
  assert.equal(storage.providerRefreshTasks.a.status, "running");
  assert.deepEqual(storage.providerRefreshFailures, {});
  beforeWrite = async () => {};
  assert.equal((await getProviderRefreshTask("a")).status, "failed");
  const outcome = writes.at(-1);
  assert.equal(outcome.providerRefreshTasks.a.outcomeRecorded, true);
  assert.ok(outcome.providerRefreshFailures.a.source);
}

// A transient query failure retains the active task and previously recorded failures.
reset();
{
  const task = await start("a");
  storage.providerRefreshFailures.a = { other: { error: "retained mock failure" } };
  beforePoll = async () => {
    throw new Error("mock transient network failure");
  };
  assert.equal((await getProviderRefreshTask("a")).id, task.id);
  assert.equal(storage.providerRefreshTasks.a.status, "running");
  assert.equal(storage.providerRefreshFailures.a.other.error, "retained mock failure");
  beforePoll = async () => {};
  coreStatus = "succeeded";
  assert.equal((await getProviderRefreshTask("a")).status, "succeeded");
  assert.equal(storage.providerRefreshFailures.a.other.error, "retained mock failure");
}

// An accepted POST followed by a storage failure is never recorded as Core failure.
reset();
{
  beforeWrite = async (values) => {
    if (values.providerRefreshTasks?.a?.coreTaskId)
      throw new Error("mock acceptance storage failure");
  };
  await assert.rejects(start("a"), /mock acceptance storage failure/);
  assert.equal(storage.providerRefreshTasks.a.status, "running");
  assert.deepEqual(storage.providerRefreshFailures, {});
  assert.equal(starts, 1);
}

console.log("Provider refresh concurrency, dismissal and atomic outcome checks passed");
