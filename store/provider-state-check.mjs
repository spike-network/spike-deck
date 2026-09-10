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
const profile = await mkdtemp(join(tmpdir(), "deck-provider-browser-"));
const tasks = new Map();
const starts = { a: 0, b: 0 };
let nextId = 1;
let pending;
let context;
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "condition did not become true");
    await delay(20);
  }
}
function hold(id, method) {
  const gate = Promise.withResolvers();
  pending = { id, method, entered: false, release: gate.resolve, promise: gate.promise };
  return pending;
}
const server = http.createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const [, instance, , resource, taskId] = path.split("/");
  let result;
  let status = 200;
  if (!["a", "b"].includes(instance)) status = 404;
  else if (resource === "provider-refreshes") {
    const waiting =
      pending?.id === instance && pending.method === request.method && !pending.entered
        ? pending
        : null;
    if (waiting) {
      waiting.entered = true;
      await waiting.promise;
    }
    if (request.method === "POST") {
      starts[instance] += 1;
      result = {
        id: nextId++,
        status: "running",
        started_at_unix_ms: Date.now(),
        provider_results: [],
      };
      tasks.set(`${instance}:${result.id}`, result);
    } else result = tasks.get(`${instance}:${taskId}`);
    if (!result) status = 404;
  } else if (resource === "providers") {
    result = {
      refreshing: false,
      providers: [{ id: "source", type: "policy", status: "ready", availability: "available" }],
    };
  } else status = 404;
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(result || { error: "mock endpoint unavailable" }));
});

try {
  let extension = root;
  if (process.env.DECK_BASELINE_REF) {
    const baseline = process.env.DECK_BASELINE_REF;
    assert.match(baseline, /^[a-f0-9]{7,40}$/);
    extension = join(profile, "extension");
    await mkdir(extension);
    const archive = execFileSync("rtk", ["proxy", "git", "archive", baseline], { cwd: root });
    execFileSync("rtk", ["proxy", "tar", "-xf", "-", "-C", extension], { input: archive });
  }
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiPort = server.address().port;
  const launch = async () => {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    return (
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker", { timeout: 10000 }))
    );
  };
  let worker = await launch();
  await until(() =>
    worker.evaluate(
      async () => (await chrome.storage.local.get("instances")).instances !== undefined,
    ),
  );
  await worker.evaluate(async (apiPort) => {
    await chrome.storage.local.set({
      instances: ["a", "b"].map((id) => ({
        id,
        name: id,
        baseUrl: `http://127.0.0.1:${apiPort}/${id}`,
        secret: "",
      })),
      activeInstanceId: "a",
      enableProxyMode: false,
      healthCheckInterval: 300,
      uiLanguage: "en",
    });
    // Real storage snapshots are delayed to force overlapping read-modify-write windows.
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = async (keys) => {
      const result = await get(keys);
      if (Array.isArray(keys) && keys.includes("providerRefreshTasks"))
        await new Promise((resolve) => setTimeout(resolve, 40));
      return result;
    };
  }, apiPort);
  const open = async (name) => {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/${name}.html`);
    return page;
  };
  const a = await open("options");
  const b = await open("options");
  const send = (page, type, instanceId, extra = {}) =>
    page.evaluate((body) => chrome.runtime.sendMessage(body), { type, instanceId, ...extra });
  const start = (page, instanceId) =>
    send(page, "START_PROVIDER_REFRESH", instanceId, { providerId: "source" });
  const read = (page, instanceId) => send(page, "GET_PROVIDER_REFRESH_TASK", instanceId);
  const stored = () =>
    worker.evaluate(() =>
      chrome.storage.local.get(["providerRefreshTasks", "providerRefreshFailures"]),
    );
  const finish = (instance, task) =>
    Object.assign(tasks.get(`${instance}:${task.coreTaskId}`), {
      status: "failed",
      completed_at_unix_ms: Date.now(),
      error: "mock refresh failure",
      provider_results: [{ provider_id: "source", status: "failed", error: "mock source failure" }],
    });

  const [firstA, firstB] = await Promise.all([start(a, "a"), start(b, "b")]);
  assert.equal(firstA.ok, true);
  assert.equal(firstB.ok, true);
  let data = await stored();
  assert.equal(
    data.providerRefreshTasks.a?.id,
    firstA.task.id,
    "Concurrent B update lost A's task",
  );
  assert.equal(
    data.providerRefreshTasks.b?.id,
    firstB.task.id,
    "Concurrent A update lost B's task",
  );
  finish("a", firstA.task);
  finish("b", firstB.task);
  await Promise.all([read(a, "a"), read(b, "b")]);
  data = await stored();
  for (const id of ["a", "b"]) {
    assert.equal(data.providerRefreshTasks[id].status, "failed");
    assert.equal(data.providerRefreshFailures[id].source.error, "mock source failure");
  }

  // A real popup holds an old terminal result; another page starts a new task.
  const popup = await open("popup");
  await popup.waitForFunction(() =>
    document.querySelector("#status-dot").classList.contains("offline"),
  );
  await popup.locator("#btn-refresh-providers").click();
  await popup.locator("#providers-panel-notice.error").waitFor({ state: "visible" });
  const heldStart = hold("a", "POST");
  const newer = start(a, "a");
  await until(() => heldStart.entered);
  const duplicate = start(b, "a");
  await popup.locator("#btn-refresh-providers").click();
  await until(async () => (await stored()).providerRefreshTasks.a?.status === "running");
  heldStart.release();
  const [newA, joined] = await Promise.all([newer, duplicate]);
  assert.equal(newA.task.id, joined.task.id);
  assert.equal(starts.a, 2);
  assert.notEqual(newA.task.id, firstA.task.id);
  assert.equal((await stored()).providerRefreshTasks.a.coreTaskId, newA.task.coreTaskId);
  await popup.close();

  // A clear from another context during reconciliation cannot drop the running record.
  const heldPoll = hold("a", "GET");
  const polling = read(a, "a");
  await until(() => heldPoll.entered);
  const dismissed = await send(b, "DISMISS_PROVIDER_REFRESH_TASK", "a", { taskId: newA.task.id });
  assert.equal(dismissed.task.status, "running");
  finish("a", newA.task);
  heldPoll.release();
  assert.equal((await polling).task.status, "failed");
  const terminalDismiss = await send(b, "DISMISS_PROVIDER_REFRESH_TASK", "a", {
    taskId: newA.task.id,
  });
  assert.equal(terminalDismiss.task, null);
  data = await stored();
  assert.equal(data.providerRefreshTasks.a, undefined);
  assert.ok(data.providerRefreshFailures.a.source);
  assert.equal(data.providerRefreshTasks.b.id, firstB.task.id);

  const [pendingA, pendingB] = await Promise.all([start(a, "a"), start(b, "b")]);
  assert.equal(pendingA.task.status, "running");
  assert.equal(pendingB.task.status, "running");
  // Recreate the extension worker and pages from the same private profile, without replaying POST.
  await context.close();
  context = null;
  finish("a", pendingA.task);
  finish("b", pendingB.task);
  worker = await launch();
  await until(async () => {
    const persisted = await stored();
    return ["a", "b"].every((id) => persisted.providerRefreshTasks[id]?.status === "failed");
  });
  const reopened = await open("options");
  const restored = await read(reopened, "b");
  assert.equal(restored.task.id, pendingB.task.id);
  assert.equal(restored.task.status, "failed");
  assert.ok(restored.failures.source);
  assert.equal((await stored()).providerRefreshTasks.a.id, pendingA.task.id);
  assert.deepEqual(starts, { a: 3, b: 2 });
  console.log(
    "Real Chromium cross-context provider persistence, popup dismissal and restart checks passed",
  );
} finally {
  pending?.release();
  if (context) await context.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
