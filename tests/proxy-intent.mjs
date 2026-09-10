import assert from "node:assert/strict";

const storage = {
  instances: ["a", "b"].map((id) => ({
    id,
    name: id,
    baseUrl: `http://${id}.example.test`,
    secret: "mock-secret",
  })),
  activeInstanceId: "a",
  enableProxyMode: true,
};
const listeners = {};
const event = (name) => ({
  addListener(fn) {
    listeners[name] = fn;
  },
});
const calls = [];
let value = { mode: "system" };
let owner = "controllable_by_this_extension";
let beforeSet = async () => {};
let beforeClear = async () => {};
let writers = 0;
let maxWriters = 0;
let status = async (instance) => ({
  listeners: [{ kind: "mixed", address: `0.0.0.0:${instance.id === "a" ? 8001 : 8002}` }],
});

globalThis.chrome = {
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  storage: {
    onChanged: event("storage"),
    local: {
      async get(keys) {
        return structuredClone(Object.fromEntries(keys.map((key) => [key, storage[key]])));
      },
      async set(next) {
        Object.assign(storage, next);
      },
    },
  },
  proxy: {
    settings: {
      async get() {
        return { value: structuredClone(value), levelOfControl: owner };
      },
      async set(next) {
        writers += 1;
        maxWriters = Math.max(maxWriters, writers);
        try {
          await beforeSet(next);
          value = structuredClone(next.value);
          owner = "controlled_by_this_extension";
          calls.push(["set", value.rules.singleProxy.port]);
        } finally {
          writers -= 1;
        }
      },
      async clear() {
        writers += 1;
        maxWriters = Math.max(maxWriters, writers);
        try {
          await beforeClear();
          value = { mode: "system" };
          owner = "controllable_by_this_extension";
          calls.push(["clear"]);
        } finally {
          writers -= 1;
        }
      },
    },
  },
  runtime: {
    onInstalled: event("installed"),
    onStartup: event("startup"),
    onMessage: event("message"),
    onConnect: event("connect"),
    async sendMessage() {},
    async getContexts() {
      return [];
    },
  },
};

const { SpikeApiClient } = await import("../lib/spike-client.js");
SpikeApiClient.getStatus = (...args) => status(...args);
const { reconcileProxyWithHealth } = await import("../background.js");
const { invalidateProxyIntent } = await import("../lib/proxy-control.js");
const update = () =>
  new Promise((resolve) => listeners.message({ type: "UPDATE_PROXY_SETTING" }, {}, resolve));
const gate = () => {
  const entered = Promise.withResolvers();
  const done = Promise.withResolvers();
  return {
    entered: entered.promise,
    release: done.resolve,
    async wait() {
      entered.resolve();
      return await done.promise;
    },
  };
};
const defaults = status;
function reset() {
  assert.equal(writers, 0);
  calls.length = 0;
  maxWriters = 0;
  beforeSet = async () => {};
  beforeClear = async () => {};
  status = defaults;
  Object.assign(storage, {
    enableProxyMode: true,
    activeInstanceId: "a",
    proxyReleasedForUnhealthy: false,
  });
  value = { mode: "system" };
  owner = "controllable_by_this_extension";
  invalidateProxyIntent();
}

// Closing takeover cannot wait for, or be undone by, an older status request.
reset();
{
  const pending = gate();
  status = async (instance) => {
    await pending.wait();
    return defaults(instance);
  };
  const old = update();
  await pending.entered;
  storage.enableProxyMode = false;
  const closed = await update();
  assert.equal(closed.mode, "released");
  assert.equal(owner, "controllable_by_this_extension");
  pending.release();
  assert.equal((await old).superseded, true);
  assert.deepEqual(calls, [["clear"]]);
  assert.equal(storage.enableProxyMode, false);
}

// Both late success and late failure from A must leave B's applied route alone.
for (const fail of [false, true]) {
  reset();
  const pending = gate();
  status = async (instance) => {
    if (instance.id === "a") {
      await pending.wait();
      if (fail) throw new Error("mock old probe failure");
    }
    return defaults(instance);
  };
  const old = update();
  await pending.entered;
  storage.activeInstanceId = "b";
  const applied = await update();
  assert.equal(applied.port, 8002, JSON.stringify(applied));
  pending.release();
  assert.equal((await old).superseded, true);
  assert.deepEqual(calls, [["set", 8002]]);
  assert.equal(storage.proxyReleasedForUnhealthy, false);
}

// Same-intent health and explicit updates join one probe without superseding it.
reset();
{
  const pending = gate();
  let probes = 0;
  status = async (instance) => {
    probes += 1;
    await pending.wait();
    return defaults(instance);
  };
  const first = update();
  await pending.entered;
  const second = reconcileProxyWithHealth();
  pending.release();
  await Promise.all([first, second]);
  assert.equal(probes, 1);
  assert.deepEqual(calls, [["set", 8001]]);
}

// Already-started Chrome writes cannot be cancelled; release must follow set.
for (const fail of [false, true]) {
  reset();
  const pending = gate();
  beforeSet = async () => {
    await pending.wait();
    if (fail) throw new Error("mock old set failure");
  };
  const old = update();
  await pending.entered;
  storage.enableProxyMode = false;
  const newer = update();
  pending.release();
  assert.equal((await old).superseded, true);
  assert.equal((await newer).mode, "released");
  assert.equal(owner, "controllable_by_this_extension");
  assert.equal(maxWriters, 1);
  assert.deepEqual(calls, fail ? [["clear"]] : [["set", 8001], ["clear"]]);
}

reset();
{
  await update();
  const pending = gate();
  beforeClear = async () => {
    await pending.wait();
  };
  storage.enableProxyMode = false;
  const old = update();
  await pending.entered;
  Object.assign(storage, { enableProxyMode: true, activeInstanceId: "b" });
  const newer = update();
  pending.release();
  await Promise.all([old, newer]);
  assert.equal(value.rules.singleProxy.port, 8002);
  assert.equal(maxWriters, 1);
  assert.deepEqual(calls, [["set", 8001], ["clear"], ["set", 8002]]);
}

// Owning the setting is insufficient: reconcile the actual endpoint after restart/drift.
reset();
await update();
value.rules.singleProxy.port = 8002;
assert.equal((await reconcileProxyWithHealth()).action, "restored");
assert.equal(value.rules.singleProxy.port, 8001);
assert.equal((await reconcileProxyWithHealth()).action, "holding");

// A failed Chrome write does not poison the commit queue or change the user's intent.
reset();
beforeSet = async () => {
  throw new Error("mock set failure");
};
assert.equal((await update()).ok, false);
assert.equal(storage.enableProxyMode, true);
assert.equal(storage.proxyReleasedForUnhealthy, true);
beforeSet = async () => {};
assert.equal((await reconcileProxyWithHealth()).healthy, true);
assert.equal(storage.proxyReleasedForUnhealthy, false);

// The real background storage listener invalidates a read already in flight.
reset();
{
  const pending = gate();
  status = async (instance) => {
    await pending.wait();
    return defaults(instance);
  };
  const old = update();
  await pending.entered;
  storage.enableProxyMode = false;
  listeners.storage({ enableProxyMode: { oldValue: true, newValue: false } }, "local");
  await update();
  pending.release();
  assert.equal((await old).superseded, true);
  assert.equal(owner, "controllable_by_this_extension");
  assert.ok(calls.every(([action]) => action === "clear"));
}

reset();
{
  const pending = gate();
  let firstA = true;
  status = async (instance) => {
    if (instance.id === "a") {
      if (firstA) {
        firstA = false;
        await pending.wait();
        return defaults(instance);
      }
      return { listeners: [{ kind: "mixed", address: "0.0.0.0:8003" }] };
    }
    return defaults(instance);
  };
  const old = update();
  await pending.entered;
  storage.activeInstanceId = "b";
  await update();
  storage.activeInstanceId = "a";
  await update();
  pending.release();
  assert.equal((await old).superseded, true);
  assert.equal(value.rules.singleProxy.port, 8003);
}

// A successful clear call that did not release ownership is not reported as idle.
reset();
await update();
{
  const clear = chrome.proxy.settings.clear;
  chrome.proxy.settings.clear = async () => {};
  storage.enableProxyMode = false;
  const failed = await update();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /did not release/);
  chrome.proxy.settings.clear = clear;
  assert.equal((await update()).mode, "released");
}

// Badge errors are presentation failures, not grounds to release a healthy route.
reset();
{
  const badge = chrome.action.setBadgeText;
  const warn = console.warn;
  const warnings = [];
  chrome.action.setBadgeText = async () => {
    throw new Error("mock badge failure");
  };
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal((await update()).healthy, true);
    assert.equal(owner, "controlled_by_this_extension");
    assert.deepEqual(calls, [["set", 8001]]);
    assert.equal(storage.proxyReleasedForUnhealthy, false);
    assert.equal(warnings.length, 1);
  } finally {
    chrome.action.setBadgeText = badge;
    console.warn = warn;
  }
}

console.log("proxy intent ordering and recovery tests passed");
