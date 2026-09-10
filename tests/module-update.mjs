import assert from "node:assert/strict";

const storage = {
  instances: ["a", "b"].map((id) => ({
    id,
    baseUrl: `http://${id}.example.test`,
    secret: "mock-secret",
  })),
};
const notices = [];
let failWrite = () => false;
globalThis.chrome = {
  runtime: {
    async sendMessage(value) {
      notices.push(structuredClone(value));
    },
  },
  storage: {
    local: {
      async get(keys) {
        return structuredClone(Object.fromEntries(keys.map((key) => [key, storage[key]])));
      },
      async set(value) {
        if (failWrite(value)) throw new Error("mock storage failure");
        Object.assign(storage, structuredClone(value));
      },
    },
  },
};
const { SpikeApiClient } = await import("../lib/spike-client.js");
let namespace = "runtime-one";
let schemaVersion = 1;
let records = [];
let posts = 0;
let legacy = false;
let postGate = null;
let getError = null;
let postError = null;
let legacyResponse = { ok: true, modules: [] };
SpikeApiClient.getModuleUpdateTasks = async () => {
  if (legacy) throw Object.assign(new Error("mock old server"), { status: 404 });
  if (getError) throw getError;
  return {
    schema_version: schemaVersion,
    task_namespace: namespace,
    tasks: structuredClone(records.map((task) => ({ schema_version: 1, ...task }))),
  };
};
SpikeApiClient.getModules = async () => ({ modules: [] });
SpikeApiClient.startModuleUpdateTask = async (instance, task) => {
  posts += 1;
  const stored = storage[`moduleUpdateTask:${instance.id}`];
  assert.equal(stored.id, task.id, "Reference must be persisted before POST");
  const accepted = {
    schema_version: 1,
    id: task.id,
    task_namespace: namespace,
    status: "running",
    started_at_unix_ms: Date.now(),
  };
  records.push(accepted);
  if (postGate) await postGate.wait();
  if (postError) throw postError;
  return structuredClone(accepted);
};
SpikeApiClient.updateModules = async () => {
  posts += 1;
  if (postGate) await postGate.wait();
  if (postError) throw postError;
  return legacyResponse;
};
const controller = await import("../lib/module-update.js");
const {
  startModuleUpdate: start,
  getModuleUpdateState: read,
  dismissUnknownModuleUpdate: dismiss,
} = controller;
const changes = {
  name: "Example",
  url: "https://modules.example.test/example?token=mock-install-secret",
};
const key = "moduleUpdateTask:a";
function gate() {
  const started = Promise.withResolvers();
  const done = Promise.withResolvers();
  return {
    entered: started.promise,
    release: done.resolve,
    async wait() {
      started.resolve();
      await done.promise;
    },
  };
}
function reset() {
  delete storage[key];
  delete storage["moduleUpdateTask:b"];
  namespace = "runtime-one";
  schemaVersion = 1;
  records = [];
  posts = 0;
  notices.length = 0;
  postGate = null;
  getError = postError = null;
  failWrite = () => false;
  legacy = false;
}

reset();
{
  postGate = gate();
  const pending = start("a", changes);
  await postGate.entered;
  await assert.rejects(start("a", { uninstall: "Example" }), /未提交/);
  const reopening = read("a");
  postGate.release();
  const task = await pending;
  assert.equal((await reopening).task.id, task.id);
  assert.equal(posts, 1);
  records[0].status = "succeeded";
  assert.equal((await read("a")).task.status, "succeeded");
  assert.doesNotMatch(JSON.stringify(storage[key]), /mock-install-secret|mock-secret|https:/);
  assert.doesNotMatch(JSON.stringify(notices), /mock-install-secret|mock-secret|https:/);
  records.push({
    id: "external-after-completion",
    task_namespace: namespace,
    status: "running",
    started_at_unix_ms: Date.now(),
  });
  assert.equal((await read("a")).task.id, "external-after-completion");
  await assert.rejects(start("a", changes), /未提交/);
}

// Lost response after Core accepts is recovered by query, never a second POST.
reset();
{
  postError = new Error("mock lost reply");
  assert.equal((await start("a", changes)).status, "unknown");
  assert.equal((await read("a")).task.status, "running");
  assert.equal(posts, 1);
  getError = new Error("mock temporary query failure");
  assert.equal((await read("a")).task.status, "running");
  assert.ok((await read("a")).error);
  getError = null;
  records[0].status = "failed";
  assert.equal((await read("a")).task.status, "failed");
}

// Worker reconstruction retains the reference and performs no mutation.
reset();
{
  const task = await start("a", changes);
  const restored = await import("../lib/module-update.js?worker=restored");
  assert.equal((await restored.getModuleUpdateState("a")).task.id, task.id);
  records[0].status = "succeeded";
  assert.equal((await restored.getModuleUpdateState("a")).task.status, "succeeded");
  assert.equal(posts, 1);
}

// A new runtime cannot lend an unrelated task's success to an old reference.
reset();
{
  await start("a", changes);
  schemaVersion = 2;
  const state = await read("a");
  assert.equal(state.task.status, "running");
  assert.ok(state.error);
  assert.equal(posts, 1);
}

reset();
{
  const task = await start("a", changes);
  namespace = "runtime-two";
  records = [{ id: task.id, task_namespace: namespace, status: "succeeded" }];
  const state = await read("a");
  assert.equal(state.task.status, "unknown");
  assert.equal(state.canDismiss, true);
  await assert.rejects(start("a", changes), /无法确认/);
  await assert.rejects(dismiss("a", "wrong-task"), /已改变/);
  await assert.rejects(dismiss("a", task.id, state.task.sequence - 1), /已改变/);
  await dismiss("a", task.id, state.task.sequence);
  assert.equal((await read("a")).task, null);
  assert.equal(posts, 1);
}

// A foreign active task is discoverable and prevents submitting an overlapping change.
reset();
records = [{ id: "external", task_namespace: namespace, status: "running", started_at_unix_ms: 1 }];
assert.equal((await read("a")).task.id, "external");
await assert.rejects(start("a", changes), /未提交/);
assert.equal(posts, 0);

// Storage failures before and after acceptance have different, visible recovery paths.
reset();
failWrite = () => true;
await assert.rejects(start("a", changes), /storage failure/);
assert.equal(posts, 0);
failWrite = (values) => Object.values(values).some((value) => value.status === "running");
await assert.rejects(start("a", changes), /storage failure/);
assert.equal(posts, 1);
assert.equal(storage[key].status, "submitting");
failWrite = () => false;
assert.equal((await read("a")).task.status, "running");

// Explicit rejection never becomes successful acceptance.
reset();
{
  await start("a", changes);
  storage.instances[0].secret = "mock-replaced-secret";
  let state = await read("a");
  assert.equal(state.task.status, "unknown");
  assert.match(state.task.error, /连接已更改/);
  assert.equal(state.canDismiss, false);
  records[0].status = "succeeded";
  state = await read("a");
  assert.equal(state.task.status, "unknown");
  assert.equal(state.canDismiss, true);
  await dismiss("a", state.task.id, state.task.sequence);
  assert.equal((await read("a")).task, null);
  assert.equal(posts, 1);
  storage.instances[0].secret = "mock-secret";
}

reset();
postError = Object.assign(new Error("mock rejected"), { status: 409 });
await assert.rejects(start("a", changes), /未被接受/);
assert.equal(storage[key].status, "rejected");

// The legacy request outlives the popup, but a rebuilt worker cannot infer its outcome.
reset();
legacy = true;
postGate = gate();
{
  const task = await start("a", changes);
  assert.equal(task.mode, "legacy");
  await postGate.entered;
  postGate.release();
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await read("a")).task.status, "succeeded");
  assert.equal(posts, 1);
}

reset();
legacy = true;
postGate = gate();
{
  const task = await start("a", changes);
  await postGate.entered;
  await assert.rejects(start("a", changes), /未提交/);
  assert.equal((await read("a")).task.status, "running");
  const rebuilt = await import("../lib/module-update.js?worker=legacy-restored");
  assert.equal((await rebuilt.getModuleUpdateState("a")).task.status, "unknown");
  await assert.rejects(rebuilt.startModuleUpdate("a", changes), /无法确认/);
  postGate.release();
  // The old completion cannot overwrite the reconstructed worker's newer record.
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storage[key].status, "unknown");
  assert.equal(storage[key].id, task.id);
  assert.equal(posts, 1);
}

console.log(
  "Module task admission, persistent identity, restart and unknown outcome checks passed",
);
