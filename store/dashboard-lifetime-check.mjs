import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { fixture, installChromeMock, now } from "./fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.env.DECK_BASELINE_REF;
const baselineSources = new Map();
if (baseline) {
  assert.match(baseline, /^[a-f0-9]{7,40}$/);
  for (const path of ["popup.js", "lib/storage.js"]) {
    baselineSources.set(
      path,
      execFileSync("rtk", ["proxy", "git", "show", `${baseline}:${path}`], { cwd: root }),
    );
  }
}
const origin = "http://deck.example.test";
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const browser = await chromium.launch({ headless: true });

async function until(predicate, message = "asynchronous condition did not become true") {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message);
    await delay(20);
  }
}

function gate() {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  return {
    get started() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("deferred operation was not started")),
          10000,
        );
        started.promise.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    release: release.resolve,
    async wait() {
      started.resolve();
      await release.promise;
    },
  };
}

async function harness(options = {}) {
  const context = await browser.newContext({
    viewport: { width: 415, height: 800 },
    locale: "en-US",
    serviceWorkers: "block",
  });
  const storage = {
    instances: ["a", "b"].map((id) => ({
      id,
      name: id.toUpperCase(),
      baseUrl: `http://${id}.example.test`,
      secret: "",
    })),
    activeInstanceId: "a",
    enableProxyMode: false,
    uiLanguage: "en",
    groupExpandMode: options.sharedGroups ? "expand-all" : "collapse-all",
    collapseGroupAfterSelection: options.collapseAfterSelection || false,
    healthCheckInterval: 300,
    trafficRefreshInterval: 60,
  };
  const requests = [];
  const messages = [];
  const errors = [];
  const versions = { a: 1, b: 1 };
  const selections = { a: "a-node-1", b: "b-node-1" };
  const overrides = { ...selections };
  const outbounds = { a: { mode: options.outboundMode || "rule" }, b: { mode: "rule" } };
  const offline = new Set();
  const held = [];
  const groupTasks = Object.fromEntries(["a", "b"].map((id) => [id, options.runningTasks ? [
    { id: 1, task_namespace: `${id}-process`, group: "shared-group", status: "running", completed: 0, total: 2, update_sequence: 1, results: [] },
  ] : []]));
  let snapshotReads = 0;
  let tabReads = 0;
  const api = JSON.parse(await readFile(resolve(root, "tests/fixtures/control-api-v1.json")));
  const hold = (match, failed = false) => {
    const item = { match, failed, gate: gate(), used: false };
    held.push(item);
    return item.gate;
  };
  await context.exposeBinding("__storageGet", async (_, keys) => {
    if (typeof keys === "string") keys = [keys];
    const result = structuredClone(
      keys ? Object.fromEntries(keys.map((key) => [key, storage[key]])) : storage,
    );
    if (keys?.includes("popupGroupSnapshots")) {
      snapshotReads += 1;
      if (snapshotReads === options.holdSnapshotRead) await options.storageGate.wait();
    }
    return result;
  });
  await context.exposeBinding("__storageSet", async (_, values) => {
    if (values.activeInstanceId === "b" && options.selectionGate)
      await options.selectionGate.wait();
    Object.assign(storage, structuredClone(values));
  });
  await context.exposeBinding("__storageRemove", async (_, keys) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
  });
  await context.exposeBinding("__currentTab", async () => {
    if (++tabReads === 1 && options.tabGate) {
      await options.tabGate.wait();
      if (options.tabFailed) throw new Error("mock tab query failed");
    }
    return [{ id: 1, url: options.tabUrl || "https://www.example.test/" }];
  });
  await context.exposeBinding("__groupMessage", async (_, message) => {
    const request = { ...message, id: message.instanceId, key: message.type };
    messages.push(request);
    const block = held.find((item) => !item.used && item.match(request));
    if (block) {
      block.used = true;
      await block.gate.wait();
    }
    if (block?.failed === "reject") throw new Error("mock group transport failure");
    if (block?.failed) return { ok: false, error: "mock group rejection" };
    const tasks = groupTasks[request.id];
    if (message.type === "START_GROUP_TEST") {
      if (options.legacyTasks) return { ok: true, mode: "sync", results: [] };
      const task = { id: tasks.length + 1, task_namespace: `${request.id}-process`, group: message.groupName, requested_member: message.memberName, status: "running", completed: 0, total: 2, update_sequence: 1, results: [] };
      tasks.push(task);
      return { ok: true, mode: "async", task };
    }
    if (message.type === "CANCEL_GROUP_TEST") {
      const task = tasks.find((task) => task.id === message.taskId);
      if (task) { task.status = "cancelled"; task.update_sequence++; }
    }
    return { ok: true, tasks: structuredClone(tasks) };
  });
  await context.addInitScript(installChromeMock, { theme: "dark", language: "en", now });
  await context.addInitScript(() => {
    chrome.storage.local.get = window.__storageGet;
    chrome.storage.local.set = window.__storageSet;
    chrome.storage.local.remove = window.__storageRemove;
    window.__settledTabs = 0;
    const nativeTabQuery = chrome.tabs.query;
    chrome.tabs.query = async (query, callback) => {
      // Popup sizing uses the callback form and is not part of the site request.
      if (callback) return nativeTabQuery(query, callback);
      try {
        return await window.__currentTab();
      } finally {
        setTimeout(() => window.__settledTabs++, 0);
      }
    };
    const send = chrome.runtime.sendMessage;
    window.__settledMessages = {};
    chrome.runtime.sendMessage = async (message) => {
      if (["GET_GROUP_TEST_STATE", "START_GROUP_TEST", "CANCEL_GROUP_TEST"].includes(message.type)) {
        try { return await window.__groupMessage(message); }
        finally {
          const key = `${message.instanceId}:${message.type}`;
          setTimeout(() => window.__settledMessages[key] = (window.__settledMessages[key] || 0) + 1, 0);
        }
      }
      return message.type === "UPDATE_PROXY_SETTING" ? { ok: true } : send(message);
    };
    window.__settledRequests = {};
    const nativeFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      if (String(args[0]).includes("/spike/")) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            setTimeout(() => {
              const key = String(args[0]);
              window.__settledRequests[key] = (window.__settledRequests[key] || 0) + 1;
            }, 0);
          }
        };
      }
      return response;
    };
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    try {
      if (url.origin === origin) {
        const path = resolve(root, `.${url.pathname}`);
        assert.ok(path.startsWith(root));
        await route.fulfill({
          body: baselineSources.get(url.pathname.slice(1)) || (await readFile(path)),
          contentType: types[extname(path)],
        });
        return;
      }
      assert.ok(
        ["a.example.test", "b.example.test"].includes(url.hostname),
        "Unexpected external request",
      );
      const id = url.hostname[0];
      const key = url.pathname.slice("/spike/".length);
      const request = {
        id,
        key,
        method: route.request().method(),
        body: route.request().postData(),
      };
      requests.push(request);
      const version = versions[id];
      const payloads = fixture();
      payloads.api = api;
      payloads.outbound = { ...outbounds[id] };
      payloads.policies = { policies: [1, 2].map((number) => ({ name: `${id}-node-${number}` })) };
      payloads["rules/explain"] = { rule_policy: `${id}-expected`, matched_rule: "FINAL" };
      payloads.connections = { live: [{ host: "www.example.test", port: 443, policy: `${id}-actual` }], recent: [] };
      payloads.status.profile = `${id}-${version}.conf`;
      payloads.status.listeners[0].address = `127.0.0.1:${id === "a" ? 6101 : 6102}`;
      payloads.groups.groups = [
        {
          name: options.sharedGroups ? "shared-group" : `${id}-group-${version}`,
          kind: options.sharedGroups ? "smart" : "select",
          selected: options.sharedGroups ? selections[id] : `${id}-node-1`,
          override_member: options.sharedGroups ? overrides[id] : undefined,
          members: [`${id}-node-1`, `${id}-node-2`],
        },
      ];
      payloads.profiles = { profiles: [`${id}-${version}`, "target"] };
      payloads["dns/delay"] = { delay: (id === "a" ? 101 : 202) * version };
      payloads["metrics.json"].traffic.download_bytes_per_second =
        (id === "a" ? 111000 : 222000) * version;
      const block = held.find((item) => !item.used && item.match(request));
      if (block) {
        block.used = true;
        await block.gate.wait();
      }
      if (offline.has(id) || block?.failed) {
        await route.fulfill({ status: 503, json: { error: "mock unavailable" } });
      } else if (request.method === "PUT" && key === "outbound") {
        const { mode, policy } = JSON.parse(request.body);
        outbounds[id] = { mode, ...(policy ? { global_policy: policy } : {}) };
        await route.fulfill({ json: outbounds[id] });
      } else if (["PUT", "DELETE"].includes(request.method) && key.startsWith("groups/")) {
        if (request.method === "PUT") selections[id] = JSON.parse(request.body).member;
        overrides[id] = request.method === "PUT" ? selections[id] : null;
        await route.fulfill({ json: { ok: true, member: selections[id] } });
      } else {
        assert.ok(Object.hasOwn(payloads, key), `Missing fixture: ${key}`);
        await route.fulfill({ json: payloads[key] });
      }
    } catch (error) {
      errors.push(error.message);
      await route.abort();
    }
  });
  const open = async () => {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/popup.html`);
    await page.waitForFunction(
      () => document.querySelector("#instance-select").options.length === 2,
    );
    return page;
  };
  const close = async () => {
    for (const item of held) item.gate.release();
    options.storageGate?.release();
    options.selectionGate?.release();
    options.tabGate?.release();
    await context.close();
  };
  return { context, storage, requests, messages, errors, versions, offline, hold, open, close };
}

async function changeInstance(page, id) {
  if ((await page.locator("#btn-quick-instance").getAttribute("aria-expanded")) !== "true")
    await page.locator("#btn-quick-instance").click();
  await page.locator("#instance-select").selectOption(id);
}

async function ready(page, id, version = 1) {
  await page.waitForFunction(
    ({ id, version }) =>
      document.querySelector("#status-dot").classList.contains("online") &&
      document.querySelector(".group-name")?.textContent === `${id}-group-${version}` &&
      document.querySelector("#profile-select").value === `${id}-${version}`,
    { id, version },
  );
}

async function settled(page, id, key, count = 1) {
  await page.waitForFunction(({ url, count }) => (window.__settledRequests[url] || 0) >= count, {
    url: `http://${id}.example.test/spike/${key}`,
    count,
  });
}

async function cacheReady(page, id, version = 1) {
  await until(() =>
    page.evaluate(
      async ({ id, version }) =>
        (await chrome.storage.local.get(["popupGroupSnapshots"])).popupGroupSnapshots?.[id]
          ?.groups[0]?.name === `${id}-group-${version}`,
      { id, version },
    ),
  );
}

async function verify(h) {
  for (const page of h.context.pages())
    assert.deepEqual(await page.evaluate(() => window.__screenshotErrors), []);
  assert.deepEqual(h.errors, []);
}

async function oldMainResponse({ failed = false, pendingB = false, returnToA = false } = {}) {
  const h = await harness();
  try {
    const a = h.hold(({ id, key }) => id === "a" && key === "groups", failed);
    const b = pendingB ? h.hold(({ id, key }) => id === "b" && key === "groups") : null;
    const page = await h.open();
    await a.started;
    await changeInstance(page, "b");
    await until(
      () => h.requests.some(({ id, key }) => id === "b" && key === "groups"),
      "B's load must start while A's response is still pending",
    );
    if (b) {
      await b.started;
      a.release();
      await settled(page, "a", "groups");
      assert.equal(
        await page
          .locator("#btn-refresh")
          .evaluate((button) => button.classList.contains("testing")),
        true,
      );
      assert.deepEqual(await page.locator(".group-name").allTextContents(), []);
      b.release();
    }
    await ready(page, "b");
    await cacheReady(page, "b");
    if (returnToA) {
      h.versions.a = 2;
      await changeInstance(page, "a");
      await ready(page, "a", 2);
      await cacheReady(page, "a", 2);
    }
    a.release();
    await settled(page, "a", "groups", returnToA ? 2 : 1);
    await ready(page, returnToA ? "a" : "b", returnToA ? 2 : 1);
    assert.equal(h.storage.activeInstanceId, returnToA ? "a" : "b");
    assert.equal(h.storage.popupGroupSnapshots.b.groups[0].name, "b-group-1");
    assert.equal(
      h.storage.popupGroupSnapshots.a?.groups[0].name,
      returnToA ? "a-group-2" : undefined,
    );
    if (!returnToA) {
      // Exercise the consumer of activeInstance, not merely the selector label.
      await page.locator(".group-header").first().click();
      await page.locator('[data-member="b-node-2"]').click();
      await settled(page, "b", "groups", 2);
      assert.ok(h.requests.some(({ id, method }) => id === "b" && method === "PUT"));
      assert.ok(!h.requests.some(({ id, method }) => id === "a" && method === "PUT"));
      await page.close();
      h.offline.add("b");
      const reopened = await h.open();
      await reopened.waitForFunction(
        () =>
          document.querySelector("#status-dot").classList.contains("offline") &&
          document.querySelector(".group-name")?.textContent === "b-group-1",
      );
      assert.deepEqual(await reopened.locator(".group-name").allTextContents(), ["b-group-1"]);
    }
    await verify(h);
  } finally {
    await h.close();
  }
}

async function oldStorageRead(read) {
  const storageGate = gate();
  const h = await harness({ holdSnapshotRead: read, storageGate });
  try {
    const page = await h.open();
    await storageGate.started;
    await changeInstance(page, "b");
    await ready(page, "b");
    storageGate.release();
    await cacheReady(page, "b");
    assert.equal(h.storage.popupGroupSnapshots.a, undefined);
    assert.deepEqual(await page.locator(".group-name").allTextContents(), ["b-group-1"]);
    if (read === 1)
      assert.equal(h.requests.filter(({ id, key }) => id === "a" && key === "status").length, 0);
    await verify(h);
  } finally {
    await h.close();
  }
}

async function oldAuxiliaryResponses({ failed = false, returnToA = false } = {}) {
  const h = await harness();
  try {
    const keys = ["profiles", "profiles/current", "dns/delay", "metrics.json"];
    const gates = keys.map((key) =>
      h.hold((request) => request.id === "a" && request.key === key, failed),
    );
    const page = await h.open();
    await Promise.all(gates.map((gate) => gate.started));
    await changeInstance(page, "b");
    await ready(page, "b");
    await settled(page, "b", "metrics.json");
    await settled(page, "b", "dns/delay");
    if (returnToA) {
      h.versions.a = 2;
      await changeInstance(page, "a");
      await ready(page, "a", 2);
      await Promise.all(keys.map((key) => settled(page, "a", key)));
    }
    const snapshot = () =>
      page.evaluate(() =>
        ["profile-select", "badge-dns-delay", "traffic-down", "proxy-listeners"].map((id) => {
          const element = document.getElementById(id);
          return [element.textContent, element.value, element.title];
        }),
      );
    const before = await snapshot();
    gates.forEach((gate) => gate.release());
    await Promise.all(keys.map((key) => settled(page, "a", key, returnToA ? 2 : 1)));
    assert.deepEqual(await snapshot(), before);
    await verify(h);
  } finally {
    await h.close();
  }
}

async function serializedSelectionAndCoalescing() {
  const selectionGate = gate();
  const h = await harness({ selectionGate });
  try {
    const page = await h.open();
    await ready(page, "a");
    await changeInstance(page, "b");
    await selectionGate.started;
    await changeInstance(page, "a");
    selectionGate.release();
    await until(() =>
      page.evaluate(
        async () => (await chrome.storage.local.get("activeInstanceId")).activeInstanceId === "a",
      ),
    );
    await ready(page, "a");
    assert.equal(h.requests.filter(({ id }) => id === "b").length, 0);
    const held = h.hold(({ id, key }) => id === "a" && key === "groups");
    await page.locator("#btn-refresh").click();
    await held.started;
    const count = h.requests.filter(({ id, key }) => id === "a" && key === "groups").length;
    await page.locator("#btn-refresh").click({ clickCount: 3 });
    held.release();
    await ready(page, "a");
    assert.equal(h.requests.filter(({ id, key }) => id === "a" && key === "groups").length, count);
    await verify(h);
  } finally {
    await h.close();
  }
}

async function sharedReady(page, id) {
  await page.waitForFunction(
    (id) =>
      document.querySelector("#status-dot").classList.contains("online") &&
      document.querySelector("#profile-select").value === `${id}-1` &&
      document.querySelector(`.member-item[data-member="${id}-node-1"]`),
    id,
  );
}

async function activateGroup(page, id, action, modifiers = []) {
  const card = page.locator('.group-card[data-group="shared-group"]');
  if (!(await card.evaluate((element) => element.classList.contains("expanded"))))
    await card.locator(".group-header").click();
  const member = `${id}-node-${action === "select" ? 2 : 1}`;
  await card.locator(`.member-item[data-member="${member}"]`).click({ modifiers });
}

async function staleGroupMutation({ action, failed = false, returnToA = false }) {
  const h = await harness({ sharedGroups: true });
  try {
    const page = await h.open();
    await sharedReady(page, "a");
    const key = "groups/shared-group/select";
    const old = h.hold((request) => request.id === "a" && request.key === key, failed);
    await activateGroup(page, "a", action);
    await old.started;
    await changeInstance(page, "b");
    await sharedReady(page, "b");
    const current = returnToA ? "a" : "b";
    if (returnToA) {
      await changeInstance(page, "a");
      await sharedReady(page, "a");
    }
    const newer = h.hold((request) => request.id === current && request.key === key);
    await activateGroup(page, current, "select");
    await newer.started;
    const count = h.requests.length;
    old.release();
    await settled(page, "a", key);
    assert.equal(h.requests.length, count, "old mutation must not refresh the new instance");
    assert.deepEqual(await page.locator(".toast").allTextContents(), []);
    const card = page.locator('.group-card[data-group="shared-group"]');
    assert.equal(await card.evaluate((element) => element.classList.contains("selection-busy")), true);
    // Keyboard activation must remain blocked while the newer request is pending.
    await card.locator(`.member-item[data-member="${current}-node-1"]`).press("Enter");
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(h.requests.length, count, "old finally must not unlock the newer selection");
    newer.release();
    await settled(page, current, key, returnToA ? 2 : 1);
    await page.waitForFunction(
      (current) => {
        const card = document.querySelector('.group-card[data-group="shared-group"]');
        return !card.classList.contains("selection-busy") &&
          card.querySelector(`.member-item[data-member="${current}-node-2"]`)?.classList.contains("pinned");
      },
      current,
    );
    await verify(h);
  } finally {
    await h.close();
  }
}

async function ordinaryGroupMutation({ action, failed = false, alt = false, redraw = false }) {
  const h = await harness({ sharedGroups: true, collapseAfterSelection: true });
  try {
    const page = await h.open();
    await sharedReady(page, "a");
    const key = "groups/shared-group/select";
    const pending = h.hold((request) => request.id === "a" && request.key === key, failed);
    await activateGroup(page, "a", action, alt ? ["Alt"] : []);
    await pending.started;
    const card = page.locator('.group-card[data-group="shared-group"]');
    assert.equal(await card.evaluate((element) => element.classList.contains("expanded")), alt);
    if (redraw) {
      await page.locator("#btn-refresh").click();
      await settled(page, "a", "groups", 2);
      assert.equal(await card.evaluate((element) => element.classList.contains("selection-busy")), true);
    }
    pending.release();
    await settled(page, "a", key);
    if (!failed || action === "select") await settled(page, "a", "groups", redraw ? 3 : 2);
    const pinned = await card.locator(".member-item.pinned").evaluateAll((items) => items[0]?.dataset.member || null);
    assert.equal(pinned, failed ? "a-node-1" : action === "select" ? "a-node-2" : null);
    assert.equal(await card.evaluate((element) => element.classList.contains("selection-busy")), false);
    assert.equal((await page.locator(".toast.error").count()) > 0, failed);
    assert.equal(h.requests.filter((request) => request.id === "b").length, 0);
    assert.equal(h.requests.filter((request) => request.key === key).length, 1);
    await verify(h);
  } finally {
    await h.close();
  }
}

async function staleSelectionRefresh(action) {
  const h = await harness({ sharedGroups: true });
  try {
    const page = await h.open();
    await sharedReady(page, "a");
    const refresh = h.hold((request) => request.id === "a" && request.key === "groups", true);
    await activateGroup(page, "a", action);
    await refresh.started;
    await changeInstance(page, "b");
    await sharedReady(page, "b");
    const key = "groups/shared-group/select";
    const pending = h.hold((request) => request.id === "b" && request.key === key);
    await activateGroup(page, "b", "select");
    await pending.started;
    const count = h.requests.length;
    refresh.release();
    await settled(page, "a", "groups", 2);
    assert.equal(h.requests.length, count);
    assert.deepEqual(await page.locator(".toast").allTextContents(), []);
    const card = page.locator('.group-card[data-group="shared-group"]');
    await card.locator('.member-item[data-member="b-node-1"]').press("Enter");
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(h.requests.length, count);
    pending.release();
    await settled(page, "b", key);
    await settled(page, "b", "groups", 2);
    assert.equal(await card.evaluate((element) => element.classList.contains("selection-busy")), false);
    await verify(h);
  } finally {
    await h.close();
  }
}

async function openOutbound(page) {
  if ((await page.locator("#btn-quick-outbound").getAttribute("aria-expanded")) !== "true")
    await page.locator("#btn-quick-outbound").click();
}

async function staleOutboundMutation({ failed = false, returnToA = false }) {
  const h = await harness();
  try {
    const page = await h.open();
    await ready(page, "a");
    await openOutbound(page);
    const old = h.hold(({ id, key, method }) => id === "a" && key === "outbound" && method === "PUT", failed);
    await page.locator('.btn-outbound-mode[data-mode="direct"]').click();
    await old.started;
    await changeInstance(page, "b");
    await ready(page, "b");
    const current = returnToA ? "a" : "b";
    if (returnToA) {
      await changeInstance(page, "a");
      await ready(page, "a");
    }
    await openOutbound(page);
    const global = page.locator('.btn-outbound-mode[data-mode="global"]');
    assert.equal(await global.isEnabled(), true, "old mode mutation must not lock the new instance");
    await page.locator("#outbound-policy-select").selectOption(`${current}-node-2`);
    const newer = h.hold(({ id, key, method }) => id === current && key === "outbound" && method === "PUT");
    await global.click();
    await newer.started;
    const before = await page.locator("#outbound-mode-card").innerHTML();
    const count = h.requests.length;
    old.release();
    await settled(page, "a", "outbound", returnToA ? 3 : 2);
    assert.equal(await page.locator("#outbound-mode-card").innerHTML(), before, "old callbacks must not change the current mode or busy state");
    assert.equal(h.requests.length, count);
    newer.release();
    await settled(page, current, "outbound", returnToA ? 4 : 2);
    assert.equal(await global.getAttribute("class"), "btn-outbound-mode active");
    assert.equal(await page.locator("#outbound-mode-card").evaluate((el) => el.classList.contains("busy")), false);
    assert.ok((await page.locator("#outbound-mode-state").textContent()).includes(`${current}-node-2`));
    const mutations = h.requests.filter(({ key, method }) => key === "outbound" && method === "PUT");
    assert.deepEqual(mutations.map(({ id, body }) => [id, JSON.parse(body)]), [
      ["a", { mode: "direct" }],
      [current, { mode: "global", policy: `${current}-node-2` }],
    ]);
    await verify(h);
  } finally {
    await h.close();
  }
}

async function ordinaryOutboundMutation({ mode, failed }) {
  const initial = mode === "rule" ? "direct" : "rule";
  const h = await harness({ outboundMode: initial });
  try {
    const page = await h.open();
    await ready(page, "a");
    await openOutbound(page);
    await page.locator("#outbound-policy-select").selectOption("a-node-2");
    const pending = h.hold(({ key, method }) => key === "outbound" && method === "PUT", failed);
    await page.locator(`.btn-outbound-mode[data-mode="${mode}"]`).click();
    await pending.started;
    await page.locator("#btn-refresh").click();
    await settled(page, "a", "outbound", 2);
    assert.equal(await page.locator("#outbound-mode-card").evaluate((el) => el.classList.contains("busy")), true);
    assert.equal(await page.locator(".btn-outbound-mode:enabled").count(), 0);
    assert.equal(await page.locator("#outbound-policy-select").isDisabled(), true);
    await page.locator('.btn-outbound-mode[data-mode="direct"]').dispatchEvent("click");
    assert.equal(h.requests.filter(({ method }) => method === "PUT").length, 1);
    pending.release();
    await settled(page, "a", "outbound", 3);
    assert.equal(await page.locator(".btn-outbound-mode.active").getAttribute("data-mode"), failed ? initial : mode);
    assert.equal(await page.locator("#outbound-mode-card").evaluate((el) => el.classList.contains("busy")), false);
    assert.equal(await page.locator("#outbound-policy-select").isEnabled(), true);
    assert.equal((await page.locator("#outbound-mode-state").textContent()).includes("mock unavailable"), failed);
    if (!failed && mode === "global")
      assert.ok((await page.locator("#outbound-mode-state").textContent()).includes("a-node-2"));
    assert.deepEqual(h.requests.filter(({ method }) => method === "PUT").map(({ id, body }) => [id, JSON.parse(body)]), [
      ["a", { mode, ...(mode === "global" ? { policy: "a-node-2" } : {}) }],
    ]);
    await verify(h);
  } finally {
    await h.close();
  }
}

async function checkSite(page) {
  if ((await page.locator("#btn-current-site-toggle").getAttribute("aria-expanded")) !== "true")
    await page.locator("#btn-current-site-toggle").click();
  else await page.locator("#btn-current-site-check").click();
}

async function staleSiteCheck({ failed = false, returnToA = false, tab = false, key = "rules/explain" }) {
  const tabGate = tab ? gate() : null;
  const h = await harness({ tabGate, tabFailed: failed });
  try {
    const page = await h.open();
    await ready(page, "a");
    const old = tabGate || h.hold((request) => request.id === "a" && request.key === key, failed);
    await checkSite(page);
    await old.started;
    await changeInstance(page, "b");
    await ready(page, "b");
    const current = returnToA ? "a" : "b";
    if (returnToA) {
      await changeInstance(page, "a");
      await ready(page, "a");
    }
    assert.equal(await page.locator("#btn-current-site-check").isEnabled(), true, "new instance must not wait for the old site check");
    assert.equal(await page.locator("#current-site-host").textContent(), "Not checked");
    const newer = h.hold((request) => request.id === current && request.key === "rules/explain");
    await checkSite(page);
    await newer.started;
    const before = await page.locator("#current-site-panel").innerHTML();
    const count = h.requests.length;
    old.release();
    if (tab) await page.waitForFunction(() => window.__settledTabs === 2);
    else await settled(page, "a", key);
    assert.equal(await page.locator("#current-site-panel").innerHTML(), before, "stale site result must not change the current operation");
    assert.equal(h.requests.length, count, "late tab query must not launch a request for another instance");
    newer.release();
    await settled(page, current, "rules/explain", !tab && returnToA ? 2 : 1);
    await page.waitForFunction(() => !document.querySelector("#btn-current-site-check").disabled);
    assert.deepEqual(await page.locator("#current-site-result strong").allTextContents(), [`${current}-expected`, `${current}-actual`]);
    await verify(h);
  } finally {
    await h.close();
  }
}

async function ordinarySiteCheck({ failed = false, unsupported = false }) {
  const h = await harness({ tabUrl: unsupported ? "chrome://extensions/" : undefined });
  try {
    const page = await h.open();
    await ready(page, "a");
    const pending = unsupported ? null : h.hold(({ key }) => key === "rules/explain", failed);
    await checkSite(page);
    if (pending) {
      await pending.started;
      await page.locator("#btn-current-site-check").dispatchEvent("click");
      pending.release();
      await settled(page, "a", "rules/explain");
    } else await page.waitForFunction(() => window.__settledTabs === 1);
    await page.waitForFunction(() => !document.querySelector("#btn-current-site-check").disabled);
    assert.equal(h.requests.filter(({ key }) => key === "rules/explain").length, unsupported ? 0 : 1);
    if (!failed && !unsupported)
      assert.deepEqual(await page.locator("#current-site-result strong").allTextContents(), ["a-expected", "a-actual"]);
    else assert.equal(await page.locator("#current-site-result strong").count(), 0);
    if (failed) assert.ok((await page.locator("#current-site-result").textContent()).includes("mock unavailable"));
    assert.equal(h.requests.filter(({ id }) => id === "b").length, 0);
    await verify(h);
  } finally {
    await h.close();
  }
}

async function messageSettled(page, id, type, count = 1) {
  await page.waitForFunction(({ key, count }) => (window.__settledMessages[key] || 0) >= count, { key: `${id}:${type}`, count });
}

async function staleGroupTask({ cancel, failed, returnToA }) {
  const h = await harness({ sharedGroups: true, runningTasks: cancel });
  try {
    const page = await h.open();
    await sharedReady(page, "a");
    await messageSettled(page, "a", "GET_GROUP_TEST_STATE");
    const type = cancel ? "CANCEL_GROUP_TEST" : "START_GROUP_TEST";
    const button = page.locator('.btn-test-group[data-group="shared-group"]');
    const old = h.hold(({ id, key }) => id === "a" && key === type, failed);
    await button.click();
    await old.started;
    await changeInstance(page, "b");
    await sharedReady(page, "b");
    await messageSettled(page, "b", "GET_GROUP_TEST_STATE");
    const current = returnToA ? "a" : "b";
    if (returnToA) {
      await changeInstance(page, "a");
      await sharedReady(page, "a");
      await messageSettled(page, "a", "GET_GROUP_TEST_STATE", 2);
    }
    const newer = h.hold(({ id, key }) => id === current && key === type);
    await button.click();
    await newer.started;
    const before = await button.evaluate((el) => ({ class: el.className, disabled: el.disabled, title: el.title }));
    const count = h.messages.length;
    old.release();
    await messageSettled(page, "a", type);
    assert.deepEqual(await button.evaluate((el) => ({ class: el.className, disabled: el.disabled, title: el.title })), before, "old task callback must not change new-instance controls");
    assert.equal(h.messages.length, count, "old failure must not restore tasks for the new instance");
    assert.deepEqual(await page.locator(".toast").allTextContents(), []);
    await page.locator("#btn-refresh").click();
    await messageSettled(page, current, "GET_GROUP_TEST_STATE", returnToA ? 3 : 2);
    assert.equal(await button.isDisabled(), true, "redraw must preserve pending task ownership");
    await button.dispatchEvent("click");
    assert.equal(h.messages.filter(({ key }) => key === type).length, 2);
    newer.release();
    await messageSettled(page, current, type, returnToA ? 2 : 1);
    assert.equal(await button.isEnabled(), true);
    assert.equal(await button.evaluate((el) => el.classList.contains("testing")), !cancel);
    assert.equal(h.messages.filter(({ key }) => key === type).length, 2);
    await verify(h);
  } finally { await h.close(); }
}

async function ordinaryGroupTask({ cancel = false, failed = false, legacy = false, member = false }) {
  const h = await harness({ sharedGroups: true, runningTasks: cancel, legacyTasks: legacy });
  try {
    const page = await h.open();
    await sharedReady(page, "a");
    await messageSettled(page, "a", "GET_GROUP_TEST_STATE");
    const type = cancel ? "CANCEL_GROUP_TEST" : "START_GROUP_TEST";
    const button = page.locator('.btn-test-group[data-group="shared-group"]');
    const trigger = member ? page.locator('.member-item[data-member="a-node-2"] .latency-badge') : button;
    const pending = h.hold(({ key }) => key === type, failed);
    await trigger.click();
    await pending.started;
    assert.equal(await button.isDisabled(), true);
    await page.locator("#btn-refresh").click();
    await messageSettled(page, "a", "GET_GROUP_TEST_STATE", 2);
    assert.equal(await button.isDisabled(), true);
    await trigger.dispatchEvent("click");
    assert.equal(h.messages.filter(({ key }) => key === type).length, 1);
    pending.release();
    await messageSettled(page, "a", type);
    await until(() => button.isEnabled());
    assert.equal(await button.evaluate((el) => el.classList.contains("testing")), cancel ? failed : !failed && !legacy);
    assert.equal(await page.locator(".toast.error").count(), failed ? 1 : 0);
    const mutation = h.messages.find(({ key }) => key === type);
    assert.equal(mutation.instanceId, "a");
    if (!cancel) assert.equal(mutation.memberName, member ? "a-node-2" : null);
    if (failed) {
      await trigger.click();
      await messageSettled(page, "a", type, 2);
      await until(() => button.isEnabled());
      assert.equal(await button.evaluate((el) => el.classList.contains("testing")), !cancel);
    }
    assert.equal(h.messages.filter(({ key, id }) => key === type && id !== "a").length, 0);
    await verify(h);
  } finally { await h.close(); }
}

try {
  for (const cancel of [true, false])
    for (const failed of [false, true, "reject"])
      for (const returnToA of [false, true])
        await staleGroupTask({ cancel, failed, returnToA });
  for (const cancel of [false, true])
    for (const failed of [false, true])
      await ordinaryGroupTask({ cancel, failed });
  await ordinaryGroupTask({ legacy: true });
  for (const failed of [false, true]) await ordinaryGroupTask({ member: true, failed });
  for (const failed of [false, true])
    for (const returnToA of [false, true])
      for (const tab of [false, true])
        await staleSiteCheck({ failed, returnToA, tab });
  for (const failed of [false, true]) {
    await staleSiteCheck({ failed, key: "connections" });
    await ordinarySiteCheck({ failed });
  }
  await ordinarySiteCheck({ unsupported: true });
  for (const failed of [false, true])
    for (const returnToA of [false, true])
      await staleOutboundMutation({ failed, returnToA });
  for (const mode of ["rule", "direct", "global"])
    for (const failed of [false, true])
      await ordinaryOutboundMutation({ mode, failed });
  for (const action of ["select", "auto"]) {
    for (const failed of [false, true]) {
      for (const returnToA of [false, true])
        await staleGroupMutation({ action, failed, returnToA });
      await ordinaryGroupMutation({ action, failed });
    }
    await ordinaryGroupMutation({ action, alt: true, redraw: true });
    await staleSelectionRefresh(action);
  }
  await oldMainResponse();
  await oldMainResponse({ failed: true });
  await oldMainResponse({ failed: true, pendingB: true });
  await oldMainResponse({ returnToA: true });
  await oldStorageRead(1);
  await oldStorageRead(2);
  await oldAuxiliaryResponses();
  await oldAuxiliaryResponses({ failed: true });
  await oldAuxiliaryResponses({ returnToA: true });
  await oldAuxiliaryResponses({ failed: true, returnToA: true });
  await serializedSelectionAndCoalescing();
  console.log("Dashboard lifetime browser checks passed (11 loading, 16 group mutation, 10 outbound mutation, 13 site check and 19 group task scenarios)");
} finally {
  await browser.close();
}
