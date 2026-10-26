import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { visiblePolicyGroups } from "../lib/hidden-groups.js";
import { translateForLanguage } from "../lib/i18n.js";

const storage = {
  instances: [{ id: "mock-instance", baseUrl: "https://example.test", secret: "mock-secret" }],
};
globalThis.chrome = {
  action: { setBadgeBackgroundColor() {}, setBadgeText() {}, setTitle() {} },
  alarms: { create() {}, async clear() {}, onAlarm: { addListener() {} } },
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener() {} },
    onStartup: { addListener() {} },
    onConnect: { addListener() {} },
    async sendMessage() {},
  },
  storage: {
    local: {
      async get(keys) {
        return Object.fromEntries(keys.map((key) => [key, storage[key]]));
      },
      async set(values) {
        Object.assign(storage, values);
      },
    },
  },
};
const { GroupBatchControls } = await import("../lib/group-batch-controls.js");
const { startGroupTestTask, cancelGroupTestTask, refreshGroupTestState } =
  await import("../background.js");
const source = readFileSync(new URL("../popup.js", import.meta.url), "utf8");
const start = source.indexOf("  function displayedPolicyGroups("),
  end = source.indexOf("\n  function renderedGroupNames", start);
assert.ok(start >= 0 && end > start);
const filter = new Function(
  "visiblePolicyGroups",
  `let groupFilterText='mock-match', hiddenGroupsMode='hide';
${source.slice(start, end)}
return displayedPolicyGroups;`,
)(visiblePolicyGroups);
const groups = [
  { name: "mock-one", members: ["mock-match", "mock-extra"] },
  { name: "mock-two", members: ["mock-match", "mock-other"] },
  { name: "mock-hidden", hidden: true, members: ["mock-match"] },
  { name: "mock-busy", members: ["mock-match"] },
];
class Node {
  constructor(document) {
    this.ownerDocument = document;
    this.listeners = {};
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
  }
  addEventListener(event, callback) {
    this.listeners[event] = callback;
  }
  click() {
    if (!this.disabled) return this.listeners.click?.();
  }
  replaceChildren(...items) {
    this.children = items;
  }
  appendChild(item) {
    this.children.push(item);
  }
  setAttribute() {}
}
const nodes = new Map();
const document = {
  getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, new Node(document));
    return nodes.get(id);
  },
  createElement() {
    return new Node(document);
  },
};
const ui = (name) => document.getElementById(`group-batch-${name}`);
const calls = [],
  records = [],
  tasks = new Map(),
  instances = storage.instances;
let taskID = 0,
  scopeCurrent = true,
  complete = false,
  holdStart,
  namespace = "mock-runtime",
  failStart = false,
  legacy = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const path = new URL(input).pathname,
    method = options.method;
  const body = options.body ? JSON.parse(options.body) : undefined;
  calls.push({
    path,
    method,
    body,
    namespace: options.headers.get("spike-control-runtime-namespace"),
  });
  let value,
    status = 200;
  if (path === "/spike/groups") value = { revision: 7, groups };
  else if (path === "/spike/group-tests" && method === "GET")
    value = { tasks: [], active_tasks: [] };
  else {
    assert.equal(options.headers.get("spike-control-runtime-namespace"), "mock-runtime");
    if (method === "POST") {
      assert.deepEqual(
        Object.keys(body),
        ["group"],
        "a member filter must not truncate full-group requests",
      );
      if (legacy) return new Response("{}", { status: 404 });
      if (failStart) throw new Error("mock-secret https://example.test/mock");
      value = {
        id: ++taskID,
        revision: 7,
        group: body.group,
        status: "running",
        completed: 0,
        total: 2,
        results: [],
        task_namespace: "mock-tasks",
        created_at_unix_ms: taskID,
        update_sequence: 1,
      };
      tasks.set(value.id, value);
      if (holdStart) await holdStart.promise;
    } else {
      value = tasks.get(Number(path.split("/").at(-1)));
      assert.ok(value);
      if (method === "DELETE" || complete)
        value = {
          ...value,
          status: method === "DELETE" ? "cancelled" : "completed",
          completed: 2,
          update_sequence: 2,
        };
    }
  }
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "spike-control-runtime-namespace": namespace },
  });
};
const settle = async (condition) => {
  for (let i = 0; i < 300; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("mock controls did not settle");
};
const controller = new GroupBatchControls({
  document,
  scope: () => ({ instance: instances[0], isCurrent: () => scopeCurrent }),
  names: () => filter(groups).map((group) => group.name),
  active: (group) => group === "mock-busy",
  record: (task) => records.push(task),
  changed() {},
  confirm: () => true,
  send: async (message) => {
    try {
      const result =
        message.type === "START_GROUP_TEST"
          ? await startGroupTestTask(
              message.instanceId,
              message.groupName,
              undefined,
              message.runtimeNamespace,
            )
          : await cancelGroupTestTask(message.instanceId, message.taskId, message.runtimeNamespace);
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  },
});
try {
  controller.observeRevision(7);
  await settle(() => controller.session.ready);
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  ui("start").click();
  ui("start").click();
  await settle(() => !controller.session.starting);
  assert.deepEqual(
    calls.filter((call) => call.method === "POST").map((call) => call.body.group),
    ["mock-one"],
  );
  complete = true;
  await controller.session.poll();
  await settle(() => !controller.session.starting);
  assert.deepEqual(
    calls.filter((call) => call.method === "POST").map((call) => call.body.group),
    ["mock-one", "mock-two"],
  );
  await controller.session.poll();
  assert.equal(controller.session.done, 2);
  assert.equal(ui("start").disabled, false);
  assert.equal(ui("status").children[0].textContent, "2 / 2");
  complete = false;
  let resolve;
  holdStart = { promise: new Promise((done) => (resolve = done)) };
  ui("start").click();
  await settle(() => tasks.size === 3);
  ui("cancel").click();
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
  resolve();
  holdStart = null;
  await settle(() => !controller.session.running);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
  assert.equal(calls.filter((call) => call.method === "POST").length, 3);
  assert.equal(records.at(-1).status, "cancelled");
  failStart = true;
  ui("start").click();
  await settle(() => controller.session.paused);
  assert.equal(ui("start").disabled, true);
  assert.ok(!controller.session.message.includes("mock-secret"));
  ui("forget").click();
  assert.equal(controller.session.ready, false);
  failStart = false;
  ui("reload").click();
  await settle(() => controller.session.ready);
  legacy = true;
  ui("start").click();
  await settle(() => controller.session.paused);
  assert.equal(
    calls.some((call) => call.path === "/spike/groups/test"),
    false,
    "bound batch must not retry through the legacy start endpoint",
  );
  ui("forget").click();
  legacy = false;
  ui("reload").click();
  await settle(() => controller.session.ready);
  ui("start").click();
  await settle(() => !controller.session.starting);
  const before = records.length;
  namespace = "mock-restarted";
  await controller.session.poll();
  assert.equal(controller.session.ready, false);
  assert.equal(records.length, before);
  controller.reset();
  scopeCurrent = false;
  controller.observeRevision(8);
  await settle(() => !controller.session.reading);
  assert.equal(controller.session.ready, false);
  for (const text of [
    "跨组测速",
    "测试匹配的组",
    "取消批量测速",
    "重试查询状态",
    "停止观察",
    "重新读取组目录",
    "正在读取组目录…",
    "停止观察此批测试？已接受的测试可能继续在引擎中运行。",
  ])
    assert.notEqual(translateForLanguage(text, "en"), text);
  for (const text of [
    "Could not bind batch tests to this runtime. Reload the group catalog.",
    "Batch runtime changed. Reload the group catalog before testing.",
    "Unable to confirm this group test. Retry status or stop observing.",
    "Group test start is unconfirmed. Check recent tasks before starting again.",
    "Unable to confirm cancellation. Retry Cancel or inspect task status.",
  ])
    assert.notEqual(translateForLanguage(text, "zh-CN"), text);
  for (const fragment of [
    "new GroupBatchControls",
    "groupBatch.observeRevision(groupsData.revision)",
    "groupBatch.reserved.includes(groupName)",
    'window.addEventListener("pagehide", () => groupBatch.reset())',
  ])
    assert.ok(source.includes(fragment));
  const html = readFileSync(new URL("../popup.html", import.meta.url), "utf8");
  for (const name of ["start", "cancel", "retry", "forget", "reload", "status"])
    assert.ok(html.includes(`id="group-batch-${name}"`));
  console.log(
    "actual popup filtering + batch controls + background + native API: full groups, serial tasks, pending cancel, safe recovery and namespace binding passed",
  );
} finally {
  controller.reset();
  await refreshGroupTestState("mock-instance");
  globalThis.fetch = originalFetch;
}
