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
    groupExpandMode: "collapse-all",
    healthCheckInterval: 300,
    trafficRefreshInterval: 60,
  };
  const requests = [];
  const errors = [];
  const versions = { a: 1, b: 1 };
  const offline = new Set();
  const held = [];
  let snapshotReads = 0;
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
  await context.addInitScript(installChromeMock, { theme: "dark", language: "en", now });
  await context.addInitScript(() => {
    chrome.storage.local.get = window.__storageGet;
    chrome.storage.local.set = window.__storageSet;
    chrome.storage.local.remove = window.__storageRemove;
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (message) =>
      message.type === "UPDATE_PROXY_SETTING" ? Promise.resolve({ ok: true }) : send(message);
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
      payloads.status.profile = `${id}-${version}.conf`;
      payloads.status.listeners[0].address = `127.0.0.1:${id === "a" ? 6101 : 6102}`;
      payloads.groups.groups = [
        {
          name: `${id}-group-${version}`,
          kind: "select",
          selected: `${id}-node-1`,
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
      } else if (request.method === "PUT" && key.startsWith("groups/")) {
        await route.fulfill({ json: { ok: true } });
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
    await context.close();
  };
  return { context, storage, requests, errors, versions, offline, hold, open, close };
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

try {
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
  console.log("Dashboard lifetime browser checks passed (11 scenarios)");
} finally {
  await browser.close();
}
