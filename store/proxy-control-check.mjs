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
const profile = await mkdtemp(join(tmpdir(), "deck-proxy-browser-"));
const servers = [];
let context;
let held;
let sequence = 0;
const unavailable = new Set();

async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "condition did not become true");
    await delay(20);
  }
}

async function listen(handler) {
  const server = http.createServer(handler);
  server.on("connect", (_, socket) => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

function hold(id, failed = false) {
  const gate = Promise.withResolvers();
  held = { id, failed, entered: false, release: gate.resolve, promise: gate.promise };
  return held;
}

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
  const ports = {};
  for (const id of ["a", "b"]) {
    ports[id] = await listen((request, response) => {
      let hostname;
      try {
        hostname = new URL(request.url).hostname;
      } catch {
        /* Reject non-proxy requests. */
      }
      if (hostname !== "proxy-target.example.test") {
        response.writeHead(502);
        response.end("blocked by local fixture");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      response.end(`proxy-${id}`);
    });
  }
  const apiPort = await listen(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    const id = path.split("/")[1];
    if (!path.endsWith("/spike/status") || !(id in ports)) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "mock endpoint unavailable" }));
      return;
    }
    const pending = held?.id === id && !held.entered ? held : null;
    if (pending) {
      pending.entered = true;
      await pending.promise;
    }
    const failed = pending?.failed || unavailable.has(id);
    response.writeHead(failed ? 503 : 200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        failed
          ? { error: "mock late status failure" }
          : {
              listeners: [{ kind: "mixed", address: `127.0.0.1:${ports[id]}` }],
            },
      ),
    );
  });
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 10000 }));
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
    });
  }, apiPort);
  const client = await context.newPage();
  await client.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const reconcile = () =>
    client.evaluate(() => chrome.runtime.sendMessage({ type: "UPDATE_PROXY_SETTING" }));
  const setting = () => worker.evaluate(() => chrome.proxy.settings.get({ incognito: false }));
  const intent = (values) => worker.evaluate((values) => chrome.storage.local.set(values), values);
  const waitEndpoint = async (id) => {
    await until(async () => {
      const current = await setting();
      return (
        current.levelOfControl === "controlled_by_this_extension" &&
        current.value.rules?.singleProxy?.port === ports[id]
      );
    });
    const page = await context.newPage();
    try {
      await page.goto(`http://proxy-target.example.test/check-${++sequence}`, { timeout: 10000 });
      assert.equal(await page.locator("body").textContent(), `proxy-${id}`);
    } finally {
      await page.close();
    }
  };
  const released = async () => {
    await until(async () => (await setting()).levelOfControl !== "controlled_by_this_extension");
    assert.equal(
      (await worker.evaluate(() => chrome.storage.local.get("enableProxyMode"))).enableProxyMode,
      false,
    );
  };
  await reconcile();
  await intent({ enableProxyMode: true });
  await reconcile();
  await waitEndpoint("a");

  // Pending A health cannot undo a newer B route, on either success or failure.
  for (const failed of [false, true]) {
    await intent({ enableProxyMode: false });
    await reconcile();
    await released();
    const pending = hold("a", failed);
    await intent({ activeInstanceId: "a", enableProxyMode: true });
    await client.evaluate(() => {
      globalThis.__oldProbe = chrome.runtime.sendMessage({ type: "UPDATE_PROXY_SETTING" });
    });
    await until(() => pending.entered);
    await intent({ activeInstanceId: "b" });
    await reconcile();
    await waitEndpoint("b");
    pending.release();
    const old = await client.evaluate(() => globalThis.__oldProbe);
    assert.equal(
      (await setting()).value.rules?.singleProxy?.port,
      ports.b,
      "Late A response changed the actual Chrome endpoint",
    );
    assert.equal(old.superseded, true);
    await waitEndpoint("b");
  }

  // Disable while status is unresolved: clear happens without waiting for HTTP.
  await intent({ enableProxyMode: false });
  await reconcile();
  const pending = hold("a");
  await intent({ activeInstanceId: "a", enableProxyMode: true });
  await client.evaluate(() => {
    globalThis.__oldProbe = chrome.runtime.sendMessage({ type: "UPDATE_PROXY_SETTING" });
  });
  await until(() => pending.entered);
  await intent({ enableProxyMode: false });
  await reconcile();
  await released();
  pending.release();
  await client.evaluate(() => globalThis.__oldProbe);
  await released();

  // Delay the real Chrome set call; its matching real clear must run afterwards.
  await worker.evaluate(() => {
    const set = chrome.proxy.settings.set.bind(chrome.proxy.settings);
    const clear = chrome.proxy.settings.clear.bind(chrome.proxy.settings);
    globalThis.__writeOrder = [];
    globalThis.__setStarted = false;
    globalThis.__restoreProxyApis = () => {
      chrome.proxy.settings.set = set;
      chrome.proxy.settings.clear = clear;
    };
    chrome.proxy.settings.set = async (...args) => {
      globalThis.__setStarted = true;
      await new Promise((resolve) => {
        globalThis.__releaseSet = resolve;
      });
      await set(...args);
      globalThis.__writeOrder.push("set");
    };
    chrome.proxy.settings.clear = async (...args) => {
      await clear(...args);
      globalThis.__writeOrder.push("clear");
    };
  });
  await intent({ enableProxyMode: true });
  await until(() => worker.evaluate(() => globalThis.__setStarted));
  await intent({ enableProxyMode: false });
  await client.evaluate(() => {
    globalThis.__disable = chrome.runtime.sendMessage({ type: "UPDATE_PROXY_SETTING" });
  });
  await worker.evaluate(() => globalThis.__releaseSet());
  await client.evaluate(() => globalThis.__disable);
  await released();
  assert.deepEqual(await worker.evaluate(() => globalThis.__writeOrder), ["set", "clear"]);
  await worker.evaluate(() => globalThis.__restoreProxyApis());

  // A mismatched endpoint owned by this extension is repaired, not called healthy.
  await intent({ activeInstanceId: "b", enableProxyMode: true });
  await reconcile();
  await waitEndpoint("b");
  await worker.evaluate(async (port) => {
    await chrome.proxy.settings.set({
      scope: "regular",
      value: {
        mode: "fixed_servers",
        rules: {
          singleProxy: { scheme: "http", host: "127.0.0.1", port },
          bypassList: ["127.0.0.1", "localhost", "::1"],
        },
      },
    });
  }, ports.a);
  await reconcile();
  await waitEndpoint("b");
  await intent({ enableProxyMode: false });
  await reconcile();
  await released();

  // A current failure retains the user's enabled intent so health recovery can work.
  for (const [pageName, checkboxId] of [
    ["options", "pref-control-proxy"],
    ["popup", "toggle-chrome-proxy"],
  ]) {
    await intent({ activeInstanceId: "a", enableProxyMode: false });
    await reconcile();
    const view = await context.newPage();
    view.setDefaultTimeout(10000);
    await view.goto(`chrome-extension://${new URL(worker.url()).host}/${pageName}.html`);
    if (pageName === "options")
      await view.waitForFunction(() => document.querySelector("#inst-name").value === "a");
    else
      await view.waitForFunction(() =>
        document.querySelector("#status-dot").classList.contains("offline"),
      );
    unavailable.add("a");
    if (pageName === "popup") await view.locator("#proxy-toggle-wrapper .switch-label").click();
    else await view.locator(`#${checkboxId}`).check();
    await until(() =>
      worker.evaluate(
        async () =>
          (await chrome.storage.local.get("proxyReleasedForUnhealthy"))
            .proxyReleasedForUnhealthy === true,
      ),
    );
    await until(async () => !(await view.locator(`#${checkboxId}`).isDisabled()));
    assert.equal(await view.locator(`#${checkboxId}`).isChecked(), true);
    assert.equal(
      (await worker.evaluate(() => chrome.storage.local.get("enableProxyMode"))).enableProxyMode,
      true,
    );
    assert.notEqual((await setting()).levelOfControl, "controlled_by_this_extension");
    await view.close();
    await intent({ enableProxyMode: false });
    await reconcile();
    unavailable.delete("a");
  }
  await released();
  console.log("Real Chromium proxy ownership, endpoint, delayed write and recovery checks passed");
} finally {
  held?.release();
  if (context) await context.close();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(profile, { recursive: true, force: true });
}
