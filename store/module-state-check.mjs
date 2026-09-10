import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(join(tmpdir(), "deck-module-browser-"));
let extension = root;
let context;
let worker;
let client;
let popup;
let heldRead;
let heldLegacy;
const states = Object.fromEntries(
  ["a", "b"].map((id) => [
    id,
    {
      namespace: `runtime-${id}`,
      tasks: [],
      posts: 0,
      unavailable: false,
      dropReply: false,
      modules: [{ name: `${id}-example`, enabled: true, source: "installed" }],
    },
  ]),
);
const server = http.createServer(async (request, response) => {
  const [, id, , resource] = new URL(request.url, "http://localhost").pathname.split("/");
  const state = states[id];
  let value;
  let code = 200;
  if (!state) code = 404;
  else if (resource === "module-updates" && request.method === "GET") {
    code = state.legacy ? 404 : state.unavailable ? 503 : 200;
    value = {
      schema_version: 1,
      task_namespace: state.namespace,
      tasks: state.tasks.map(({ changes: _changes, ...task }) => task),
    };
  } else if (resource === "module-updates" && request.method === "POST") {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    if (
      body.task_namespace !== state.namespace ||
      state.tasks.some((task) => task.status === "running")
    ) {
      code = 409;
      value = { error: "mock request not accepted" };
    } else {
      state.posts += 1;
      const task = {
        schema_version: 1,
        id: body.id,
        task_namespace: state.namespace,
        status: "running",
        started_at_unix_ms: Date.now(),
        changes: body.changes,
      };
      state.tasks.push(task);
      const { changes: _changes, ...snapshot } = task;
      value = snapshot;
      code = 202;
      if (state.dropReply) {
        state.dropReply = false;
        response.destroy();
        return;
      }
    }
  } else if (resource === "modules" && request.method === "POST") {
    let text = "";
    for await (const chunk of request) text += chunk;
    const changes = JSON.parse(text);
    state.posts += 1;
    if (!heldLegacy && process.env.DECK_BASELINE_REF) {
      const pending = Promise.withResolvers();
      heldLegacy = { entered: false, promise: pending.promise, release: pending.resolve };
    }
    if (heldLegacy) {
      heldLegacy.entered = true;
      await heldLegacy.promise;
    }
    applyChanges(state, changes);
    value = { ok: true, modules: state.modules };
  } else if (resource === "modules") {
    value = { ok: true, modules: structuredClone(state.modules) };
    if (heldRead?.id === id && !heldRead.entered) {
      const pending = heldRead;
      pending.entered = true;
      await pending.promise;
      if (pending.failed) code = 503;
    }
  } else code = 404;
  response.writeHead(code, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value || { error: "mock endpoint unavailable" }));
});
async function until(predicate, message = "condition did not become true") {
  const deadline = Date.now() + 12000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message);
    await delay(20);
  }
}
function complete(id, status = "succeeded") {
  const state = states[id];
  const task = state.tasks.find((task) => task.status === "running");
  assert.ok(task);
  task.status = status;
  task.completed_at_unix_ms = Date.now();
  if (status !== "succeeded") return;
  applyChanges(state, task.changes);
}
function applyChanges(state, changes) {
  if (changes.url) state.modules.push({ name: changes.name, enabled: true, source: "installed" });
  else if (changes.uninstall)
    state.modules = state.modules.filter((module) => module.name !== changes.uninstall);
  else
    for (const module of state.modules)
      if (module.name in changes) module.enabled = changes[module.name];
}
const message = (body) => client.evaluate((body) => chrome.runtime.sendMessage(body), body);
const stored = (id) =>
  worker.evaluate(
    async (key) => (await chrome.storage.local.get(key))[key],
    `moduleUpdateTask:${id}`,
  );
async function openPage(name) {
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/${name}.html`);
  return page;
}
async function openPopup() {
  popup = await openPage("popup");
  await popup.setViewportSize({ width: 415, height: 760 });
  await popup.waitForFunction(() =>
    document.querySelector("#status-dot").classList.contains("offline"),
  );
  await popup.locator("#btn-modules").click();
  await popup.locator("#modules-list .provider-row").first().waitFor();
}
async function expectBusy() {
  await until(
    () => popup.locator("#btn-module-install").isDisabled(),
    "Module mutation controls must stay disabled while a task is running",
  );
  assert.ok(await popup.locator("#modules-list button").first().isDisabled());
}
async function expectReady() {
  await until(async () => !(await popup.locator("#btn-module-install").isDisabled()));
}
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 12000 }));
  await until(() =>
    worker.evaluate(
      async () => (await chrome.storage.local.get("instances")).instances !== undefined,
    ),
  );
}

try {
  if (process.env.DECK_BASELINE_REF) {
    const baseline = process.env.DECK_BASELINE_REF;
    assert.match(baseline, /^[a-f0-9]{7,40}$/);
    extension = join(profile, "extension");
    await mkdir(extension);
    const archive = execFileSync("rtk", ["proxy", "git", "archive", baseline], { cwd: root });
    execFileSync("rtk", ["proxy", "tar", "-xf", "-", "-C", extension], { input: archive });
  }
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await launch();
  await worker.evaluate(async (port) => {
    await chrome.storage.local.set({
      instances: ["a", "b"].map((id) => ({
        id,
        name: id,
        baseUrl: `http://127.0.0.1:${port}/${id}`,
        secret: "",
      })),
      activeInstanceId: "a",
      enableProxyMode: false,
      uiLanguage: "en",
      healthCheckInterval: 300,
    });
  }, server.address().port);
  client = await openPage("options");
  await openPopup();
  await expectReady();
  await popup.locator("#modules-list button").first().click();
  await until(() => states.a.posts === 1);
  const pendingRecord = await stored("a");
  assert.ok(
    pendingRecord?.id,
    "Submitted module task must have a durable reference before popup closes",
  );
  await expectBusy();
  const firstId = pendingRecord.id;
  await popup.close();
  await openPopup();
  await until(async () =>
    (await popup.locator("#modules-panel-notice").textContent()).includes("Updating modules"),
  );
  await expectBusy();
  const duplicate = await message({
    type: "START_MODULE_UPDATE",
    instanceId: "a",
    body: { uninstall: "a-example" },
  });
  assert.equal(duplicate.ok, false);
  assert.equal(states.a.posts, 1);
  assert.equal((await stored("a")).id, firstId);

  // A transient query error retains the task and the busy controls.
  states.a.unavailable = true;
  await popup.locator("#btn-module-task-check").click();
  await until(async () =>
    (await popup.locator("#modules-panel-notice").textContent()).includes("retrying"),
  );
  assert.equal((await stored("a")).status, "running");
  await expectBusy();
  states.a.unavailable = false;
  complete("a");
  await popup.locator("#btn-module-task-check").click();
  await expectReady();
  await until(
    async () => (await popup.locator("#modules-list button").first().textContent()) === "Enable",
  );

  // Installation drafts only clear on success, and only if the user has not edited them.
  await popup.locator("#module-name-input").fill("Fresh");
  await popup
    .locator("#module-url-input")
    .fill("https://modules.example.test/example?token=mock-install-secret");
  await popup.locator("#btn-module-install").click();
  await until(() => states.a.posts === 2);
  await expectBusy();
  assert.doesNotMatch(JSON.stringify(await stored("a")), /mock-install-secret|https:/);
  await popup.locator("#module-name-input").fill("Draft");
  complete("a");
  await popup.locator("#btn-module-task-check").click();
  await expectReady();
  assert.equal(await popup.locator("#module-name-input").inputValue(), "Draft");

  // Old instance notifications cannot release B's busy state or supply its inventory.
  const oldA = await message({
    type: "START_MODULE_UPDATE",
    instanceId: "a",
    body: { "a-example": true },
  });
  const newB = await message({
    type: "START_MODULE_UPDATE",
    instanceId: "b",
    body: { "b-example": false },
  });
  assert.equal(oldA.ok, true);
  assert.equal(newB.ok, true);
  await popup.locator("#btn-quick-instance").click();
  await popup.locator("#instance-select").selectOption("b");
  await popup.locator("#btn-modules").click();
  await until(async () =>
    (await popup.locator("#modules-list").textContent()).includes("b-example"),
  );
  await expectBusy();
  complete("a");
  await message({ type: "GET_MODULE_UPDATE", instanceId: "a" });
  await client.evaluate(async () => {
    await chrome.runtime
      .sendMessage({
        type: "MODULE_UPDATE_CHANGED",
        instanceId: "b",
        task: { id: "obsolete", status: "succeeded", result: { modules: [{ name: "Poison" }] } },
      })
      .catch(() => {});
  });
  await popup.locator("#btn-module-task-check").click();
  await expectBusy();
  assert.doesNotMatch(await popup.locator("#modules-list").textContent(), /a-example|Poison/);

  // Close the whole private browser while B is pending, then restore from real storage.
  const runningB = (await stored("b")).id;
  await context.close();
  context = null;
  await launch();
  client = await openPage("options");
  await openPopup();
  await expectBusy();
  assert.equal((await stored("b")).id, runningB);
  assert.equal(states.b.posts, 1);
  complete("b");
  await popup.locator("#btn-module-task-check").click();
  await expectReady();

  // A lost acceptance reply is queried by ID; it must not trigger another POST.
  states.b.dropReply = true;
  await popup.locator("#modules-list button").first().click();
  await until(() => states.b.posts === 2);
  await until(async () => (await stored("b")).status === "running");
  await expectBusy();
  assert.equal(states.b.posts, 2);

  // Runtime replacement turns the reference unknown, requiring explicit acknowledgement.
  states.b.namespace = "runtime-b-restarted";
  states.b.tasks = [];
  states.b.modules[0].enabled = true;
  await popup.locator("#btn-module-task-check").click();
  await popup.locator("#btn-module-task-dismiss").waitFor({ state: "visible" });
  await until(
    async () => (await popup.locator("#modules-list button").first().textContent()) === "Disable",
  );
  assert.equal((await stored("b")).status, "unknown");
  await expectBusy();
  await popup.locator("#btn-module-task-dismiss").click();
  assert.equal(await popup.locator("#btn-module-task-dismiss").textContent(), "Confirm clear");
  assert.equal(states.b.posts, 2);
  assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mkdir(join(root, "dist/ui-check"), { recursive: true });
  await popup.screenshot({ path: join(root, "dist/ui-check/module-unknown-en-415.png") });
  await popup.locator("#btn-module-task-dismiss").click();
  await expectReady();
  assert.equal(states.b.posts, 2);
  assert.equal((await stored("b")).status, "dismissed");

  // Delayed module inventories use the popup lifetime, including A -> B -> A.
  const switchInstance = async (id) => {
    await popup.locator("#btn-quick-instance").click();
    await popup.locator("#instance-select").selectOption(id);
    await popup.locator("#btn-modules").click();
  };
  for (const failed of [false, true]) {
    states.a.modules = [{ name: "a-old", enabled: true, source: "installed" }];
    const gate = Promise.withResolvers();
    heldRead = { id: "a", failed, entered: false, promise: gate.promise, release: gate.resolve };
    await switchInstance("a");
    await until(() => heldRead.entered);
    await switchInstance("b");
    await until(async () =>
      (await popup.locator("#modules-list").textContent()).includes("b-example"),
    );
    if (!failed) {
      states.a.modules = [{ name: "a-new", enabled: true, source: "installed" }];
      await switchInstance("a");
      await until(async () =>
        (await popup.locator("#modules-list").textContent()).includes("a-new"),
      );
    }
    heldRead.release();
    await delay(100);
    const text = await popup.locator("#modules-list").textContent();
    assert.ok(text.includes(failed ? "b-example" : "a-new"));
    assert.doesNotMatch(text, /a-old|mock endpoint unavailable/);
    if (!failed) await switchInstance("b");
  }

  // The legacy Core path stays alive after popup close but becomes explicitly unknown
  // after worker reconstruction, even when inventory later matches the requested state.
  states.b.legacy = true;
  const legacyGate = Promise.withResolvers();
  heldLegacy = { entered: false, promise: legacyGate.promise, release: legacyGate.resolve };
  await expectReady();
  const previousPosts = states.b.posts;
  await popup.locator("#modules-list button").first().click();
  await until(() => heldLegacy.entered);
  assert.equal((await stored("b")).mode, "legacy");
  await popup.close();
  await openPopup();
  await until(async () =>
    (await popup.locator("#modules-panel-notice").textContent()).includes("Updating modules"),
  );
  await expectBusy();
  await context.close();
  context = null;
  await launch();
  client = await openPage("options");
  await openPopup();
  await popup.locator("#btn-module-task-dismiss").waitFor({ state: "visible" });
  assert.equal((await stored("b")).status, "unknown");
  assert.equal(states.b.posts, previousPosts + 1);
  heldLegacy.release();
  await popup.locator("#btn-module-task-check").click();
  await expectBusy();
  assert.equal((await stored("b")).status, "unknown");
  assert.equal(states.b.posts, previousPosts + 1);
  console.log(
    "Real Chromium module recovery, instance isolation, lost reply and unknown-result checks passed",
  );
} finally {
  heldRead?.release();
  heldLegacy?.release();
  if (context) await context.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
