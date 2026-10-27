import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { SpikeApiClient } from "../lib/spike-client.js";
import { PanelObservation } from "../lib/panels.js";
import { ThroughputSession } from "../lib/throughput.js";
import { chronological } from "../lib/journal-export.js";
import { reloadView, reloadStatusView } from "../lib/reload-view.js";
import { translateForLanguage } from "../lib/i18n.js";
const nodes = new Map();
const node = () => ({
  value: "",
  dataset: {},
  children: [],
  listeners: {},
  classList: { add() {}, remove() {} },
  addEventListener(event, callback) {
    this.listeners[event] = callback;
  },
  append(...values) {
    this.children.push(...values);
  },
  replaceChildren(...values) {
    this.children = values;
  },
  focus() {},
  setAttribute() {},
});
const document = {
  hidden: false,
  getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  },
  createElement: node,
  addEventListener() {},
  removeEventListener() {},
};
const get = (id) => document.getElementById(id),
  timers = [],
  windowListeners = {};
const originalFetch = globalThis.fetch;
let revision = 7,
  apiNamespace = "mock-runtime",
  logNamespace = null,
  failReload = false,
  hold,
  release,
  missingIdentity = false;
const calls = [];
globalThis.fetch = async (input, options) => {
  const path = new URL(input).pathname;
  calls.push({
    path,
    method: options.method,
    namespace: options.headers.get("spike-control-runtime-namespace"),
  });
  const headers = { "Content-Type": "application/json" };
  if (!missingIdentity) headers["spike-control-runtime-namespace"] = apiNamespace;
  let result;
  if (path === "/spike/status")
    result = { revision, profile: "mock.conf", groups: 2, leaves: 3, rules: 4 };
  else {
    assert.equal(options.method, "POST");
    assert.equal(options.headers.get("spike-control-runtime-namespace"), apiNamespace);
    if (path === "/spike/reload/preview")
      result = {
        ok: false,
        classification: "invalid",
        current_revision: revision,
        errors: [{ code: "mock-unknown", message: "mock-secret" }],
      };
    else {
      assert.equal(path, "/spike/reload");
      if (failReload) throw new Error("mock-secret https://example.test/mock");
      result = {
        ok: true,
        classification: "mixed",
        revision: ++revision,
        profile: "/mock-profile/mock-secret.conf",
        message: "mock-secret",
        hot_applied: [{ field: "rules.count", before: "1", after: "2" }],
        restart_required: [{ field: "http_port", before: "19000", after: "19001" }],
      };
    }
    if (hold) {
      release = hold.resolve;
      await hold.promise;
    }
  }
  return new Response(JSON.stringify(result), { headers });
};
const api = new Proxy(
  {},
  {
    get(_target, key) {
      if (["getStatus", "previewReload", "reloadRuntime"].includes(key))
        return (...args) => SpikeApiClient[key](...args);
      if (key === "getLogs") return async () => ({ event_namespace: logNamespace, entries: [] });
      return async () => ({});
    },
  },
);
const context = vm.createContext({
  document,
  console,
  PanelObservation,
  ThroughputSession,
  chronological,
  reloadView,
  reloadStatusView,
  window: {
    setInterval(callback) {
      timers.push(callback);
      return 1;
    },
    clearInterval() {},
    setTimeout() {},
    addEventListener(event, callback) {
      windowListeners[event] = callback;
    },
  },
  chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) } },
  SpikeApiClient: api,
  StorageManager: {
    init: async () => {},
    getActiveInstance: async () => ({
      id: "mock-instance",
      name: "mock-instance",
      baseUrl: "https://example.test",
      secret: "mock-secret",
    }),
  },
  initializeI18n: async () => {},
  t: (value) => value,
  filterRuntimeLogs: (entries) => entries,
  sortRuntimeLogs: (entries) => entries,
  formatRuntimeLogs: () => "",
});
const source = readFileSync(new URL("../tools.js", import.meta.url), "utf8").replace(
  /^import[\s\S]*?;\n/gm,
  "",
);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = async (condition) => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await settle();
  }
  assert.fail("mock reload did not settle");
};
try {
  await vm.runInContext(`(async()=>{${source}})()`, context);
  assert.equal(calls.length, 0, "opening Tools performs no preview or reload");
  let adopted;
  hold = { promise: new Promise((resolve) => (adopted = resolve)), resolve: () => adopted() };
  const adopting = get("reload-preview").listeners.click();
  await wait(() => release != null);
  logNamespace = "mock-runtime";
  timers[0]();
  await settle();
  release();
  hold = null;
  release = null;
  await adopting;
  assert.match(
    get("reload-preview-output").textContent,
    /Invalid candidate/,
    "adopting the first runtime identity keeps an in-flight preview",
  );
  assert.equal(get("reload-operation-error").textContent, "");
  const previews = calls.filter((call) => call.path === "/spike/reload/preview").length;
  const first = get("reload-preview").listeners.click();
  get("reload-preview").listeners.click();
  await first;
  assert.equal(calls.filter((call) => call.path === "/spike/reload/preview").length, previews + 1);
  assert.match(get("reload-preview-output").textContent, /Invalid candidate/);
  assert.doesNotMatch(get("reload-preview-output").textContent, /mock-secret/);
  await get("reload-apply").listeners.click();
  await settle();
  assert.match(get("reload-result-output").textContent, /"Reloaded revision": 8/);
  assert.match(get("reload-result-output").textContent, /Restart required/);
  assert.doesNotMatch(get("reload-result-output").textContent, /mock-secret/);
  assert.equal(get("reload-preview-output").textContent, "");
  failReload = true;
  await get("reload-apply").listeners.click();
  assert.match(get("reload-operation-error").textContent, /unconfirmed/);
  assert.doesNotMatch(get("reload-operation-error").textContent, /mock-secret/);
  assert.equal(get("reload-apply").disabled, true);
  const before = calls.filter((call) => call.path === "/spike/reload").length;
  await get("reload-apply").listeners.click();
  assert.equal(calls.filter((call) => call.path === "/spike/reload").length, before);
  await get("reload-check").listeners.click();
  assert.equal(calls.filter((call) => call.path === "/spike/reload").length, before);
  assert.equal(calls.at(-1).method, "GET");
  assert.equal(get("reload-apply").disabled, false);
  failReload = false;
  missingIdentity = true;
  await get("reload-apply").listeners.click();
  assert.equal(calls.filter((call) => call.path === "/spike/reload").length, before);
  missingIdentity = false;
  let done;
  hold = { promise: new Promise((resolve) => (done = resolve)), resolve: () => done() };
  const pending = get("reload-apply").listeners.click();
  await wait(() => release != null);
  apiNamespace = logNamespace = "mock-next";
  timers[0]();
  await settle();
  release();
  hold = null;
  release = null;
  await pending;
  assert.equal(get("reload-result-output").textContent, "");
  assert.match(get("reload-operation-error").textContent, /Runtime changed/);
  hold = { promise: new Promise((resolve) => (done = resolve)), resolve: () => done() };
  const closing = get("reload-preview").listeners.click();
  await wait(() => release != null);
  const old = get("reload-preview-output").textContent;
  windowListeners.pagehide();
  release();
  hold = null;
  release = null;
  await closing;
  assert.equal(get("reload-preview-output").textContent, old);
  for (const classification of ["no_change", "hot_apply", "restart_required", "mixed"]) {
    const projected = reloadView(
      { ok: true, classification, current_revision: 7, candidate_revision: 8 },
      true,
    );
    assert.equal(projected["Current revision"], 7);
  }
  assert.throws(() => reloadView({ ok: true, classification: "constructor", revision: 8 }, false));
  assert.match(
    JSON.stringify(
      reloadView(
        {
          ok: false,
          classification: "invalid",
          current_revision: 7,
          errors: [{ code: "revision_exhausted", message: "mock-secret" }],
        },
        true,
      ),
    ),
    /revision limit/,
  );
  assert.throws(() => reloadStatusView({ revision: "mock-secret" }));
  for (const value of [
    "重新加载配置",
    "检查运行时状态",
    "预览只检查当前配置，不应用更改。重新加载会再次读取当前配置文件，不会重启引擎。",
  ])
    assert.notEqual(translateForLanguage(value, "en"), value);
  for (const value of [
    "Classification",
    "No changes",
    "Hot update",
    "Restart required",
    "Hot update and restart required",
    "Invalid candidate",
    "Field",
    "Before",
    "After",
    "Current revision",
    "Candidate revision",
    "Reloaded revision",
    "Error",
    "Runtime changed. Check current status before reloading.",
    "Reading runtime status…",
    "Runtime status checked. Retry reload explicitly if needed.",
    "Preview only. No configuration was applied.",
    "Profile reloaded.",
    "Profile reloaded. Restart-required changes remain pending.",
    "Reload result is unconfirmed. Check runtime status before trying again.",
    "Unable to read reload information. Check runtime status and configuration.",
    "The revision limit was reached. Restart the engine before reloading.",
    "The candidate profile could not be validated. Check the configuration before reloading.",
  ])
    assert.notEqual(translateForLanguage(value, "zh-CN"), value);
  assert.ok(
    calls.every((call) =>
      ["/spike/status", "/spike/reload/preview", "/spike/reload"].includes(call.path),
    ),
  );
  const html = readFileSync(new URL("../tools.html", import.meta.url), "utf8");
  for (const id of [
    "reload-preview",
    "reload-apply",
    "reload-check",
    "reload-operation-status",
    "reload-operation-error",
    "reload-preview-output",
    "reload-result-output",
  ])
    assert.ok(html.includes(`id="${id}"`));
  console.log(
    "actual Tools reload controls + native API: explicit preview/reload/status, namespace preconditions, duplicate/unconfirmed guards, safe results and closed/stale views passed",
  );
} finally {
  if (release) release();
  await settle();
  globalThis.fetch = originalFetch;
}
