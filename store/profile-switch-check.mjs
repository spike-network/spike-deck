import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { fixture, installChromeMock, now } from "./fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "http://deck.example.test";
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const browser = await chromium.launch({ headless: true });

async function scenario({
  stage = "check",
  error = false,
  returnToA = false,
  normal = false,
  newPending = false,
}) {
  const context = await browser.newContext({
    viewport: { width: 415, height: 800 },
    locale: "en-US",
    serviceWorkers: "block",
  });
  const gate = Promise.withResolvers();
  const arrived = Promise.withResolvers();
  const nextGate = Promise.withResolvers();
  const nextArrived = Promise.withResolvers();
  const requests = [];
  const errors = [];
  let held = false;
  let nextHeld = false;
  try {
    const payloads = fixture();
    payloads.api = JSON.parse(await readFile(resolve(root, "tests/fixtures/control-api-v1.json")));
    payloads.profiles = { profiles: ["example", "target"] };
    await context.addInitScript(installChromeMock, { theme: "dark", language: "en", now });
    await context.addInitScript(() => {
      chrome.storage.local.set({
        instances: ["a", "b"].map((id) => ({
          id,
          name: id.toUpperCase(),
          baseUrl: `http://${id}.example.test`,
          secret: "",
        })),
        activeInstanceId: "a",
      });
      const send = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = (message) =>
        message.type === "UPDATE_PROXY_SETTING" ? Promise.resolve({ ok: true }) : send(message);
      window.__settledOperations = 0;
      const nativeFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        if (/\/profiles\/(check|switch)$/.test(String(args[0]))) {
          const json = response.json.bind(response);
          response.json = async () => {
            try {
              return await json();
            } finally {
              setTimeout(() => {
                window.__settledOperations += 1;
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
          await route.fulfill({ body: await readFile(path), contentType: types[extname(path)] });
          return;
        }
        assert.ok(
          ["a.example.test", "b.example.test"].includes(url.hostname),
          "Unexpected external request",
        );
        const key = url.pathname.slice("/spike/".length);
        if (["profiles/check", "profiles/switch"].includes(key)) {
          requests.push({ host: url.hostname, key, body: route.request().postDataJSON() });
          assert.equal(route.request().method(), "POST");
          if (
            !normal &&
            !held &&
            url.hostname === "a.example.test" &&
            key === `profiles/${stage}`
          ) {
            held = true;
            arrived.resolve();
            await gate.promise;
            await route.fulfill({
              json: error ? { error: "mock old operation failure" } : { ok: true },
            });
            return;
          }
          if (held && newPending && !nextHeld && key === "profiles/check") {
            nextHeld = true;
            nextArrived.resolve();
            await nextGate.promise;
          }
          await route.fulfill({ json: { ok: true } });
          return;
        }
        assert.ok(Object.hasOwn(payloads, key), `Missing fixture: ${key}`);
        await route.fulfill({ json: payloads[key] });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/popup.html`);
    await page.waitForFunction(
      () =>
        document.querySelector("#status-dot").classList.contains("online") &&
        document.querySelector("#profile-select").options.length === 2,
    );
    const startSwitch = async () => {
      await page.locator("#btn-quick-profile").click();
      await page.locator("#profile-select").selectOption("target");
      await page.locator("#btn-profile-switch").click();
    };
    const changeInstance = async (id) => {
      await page.locator("#btn-quick-instance").click();
      await page.locator("#instance-select").selectOption(id);
      await page.waitForFunction(
        (id) =>
          document.querySelector("#quick-instance-value").textContent === id.toUpperCase() &&
          document.querySelector("#status-dot").classList.contains("online"),
        id,
      );
    };
    await startSwitch();
    if (normal) {
      await page.waitForFunction(() => document.querySelector(".toast.success"));
      assert.deepEqual(
        requests.map(({ host, key }) => [host, key]),
        [
          ["a.example.test", "profiles/check"],
          ["a.example.test", "profiles/switch"],
        ],
      );
      assert.equal(await page.locator("#btn-profile-switch").isDisabled(), false);
    } else {
      await Promise.race([
        arrived.promise,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("operation not held")), 10000);
          timer.unref();
        }),
      ]);
      assert.equal(await page.locator("#btn-profile-switch").isDisabled(), true);
      await changeInstance("b");
      if (returnToA) await changeInstance("a");
      // A new operation must remain independently usable while A's old request is pending.
      await startSwitch();
      if (newPending) await nextArrived.promise;
      else await page.waitForFunction(() => document.querySelector(".toast.success"));
      const before = await page.locator(".toast-host").textContent();
      const selected = await page.locator("#profile-select").inputValue();
      const completed = await page.evaluate(() => window.__settledOperations);
      gate.resolve();
      await page.waitForFunction((completed) => window.__settledOperations > completed, completed);
      assert.equal(await page.locator(".toast-host").textContent(), before);
      assert.equal(await page.locator("#profile-select").inputValue(), selected);
      assert.equal(await page.locator("#btn-profile-switch").isDisabled(), newPending);
      if (newPending) {
        nextGate.resolve();
        await page.waitForFunction(() => document.querySelector(".toast.success"));
        assert.equal(await page.locator("#btn-profile-switch").isDisabled(), false);
      }
      const aSwitches = requests.filter(
        ({ host, key }) => host === "a.example.test" && key === "profiles/switch",
      );
      assert.equal(aSwitches.length, Number(stage === "switch") + Number(returnToA));
      assert.equal(
        requests.filter(({ host, key }) => host === "b.example.test" && key === "profiles/switch")
          .length,
        Number(!returnToA),
      );
    }
    for (const request of requests) assert.equal(request.body.name, "target");
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__screenshotErrors), []);
  } finally {
    gate.resolve();
    nextGate.resolve();
    await context.close();
  }
}

try {
  await scenario({ normal: true });
  for (const stage of ["check", "switch"]) {
    for (const error of [false, true]) {
      await scenario({ stage, error });
      await scenario({ stage, error, returnToA: true });
    }
    await scenario({ stage, error: true, newPending: true });
  }
  console.log("Profile switch browser checks passed (11 scenarios)");
} finally {
  await browser.close();
}
