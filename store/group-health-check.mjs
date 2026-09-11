import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { fixture, installChromeMock, now } from "./fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "http://deck.example.test";
const baseline = process.env.DECK_BASELINE_REF;
if (baseline) assert.match(baseline, /^[a-f0-9]{7,40}$/);
const baselinePopup = baseline && execFileSync("rtk", ["proxy", "git", "show", `${baseline}:popup.js`], { cwd: root });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const info = { name: "Leaf", type: "socks5", udp: true };
let memberInfo = [{ ...info, last_test_ok: true, last_test_ms: 17, last_test_at_unix_ms: 10 }];
let selected = "Leaf";
let reads = 0;
let settled = 0;
let active = 0;
let maxActive = 0;
let fail = false;
let hold = false;
const held = [];
const errors = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 415, height: 800 }, locale: "en-US", serviceWorkers: "block" });
const api = JSON.parse(await readFile(resolve(root, "tests/fixtures/control-api-v1.json")));
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "asynchronous condition timed out");
    await delay(20);
  }
}
try {
  await context.addInitScript(installChromeMock, { theme: "dark", language: "en", now });
  await context.addInitScript(() => {
    const listeners = [];
    chrome.runtime.onMessage = { addListener(listener) { listeners.push(listener); } };
    window.notifyTasks = (tasks) => listeners.forEach((listener) => listener({ type: "GROUP_TEST_STATE_CHANGED", instanceId: "fixture", tasks }));
    void chrome.storage.local.set({ groupExpandMode: "expand-all", collapseGroupAfterSelection: false });
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    try {
      assert.equal(url.origin, origin, "unexpected external request");
      if (!url.pathname.startsWith("/spike/")) {
        const path = resolve(root, `.${url.pathname}`);
        assert.ok(path.startsWith(root));
        return await route.fulfill({ contentType: types[extname(path)], body: url.pathname === "/popup.js" && baselinePopup || await readFile(path) });
      }
      const key = url.pathname.slice("/spike/".length);
      if (route.request().method() === "PUT" && key === "groups/Outer/select") {
        selected = JSON.parse(route.request().postData()).member;
        return await route.fulfill({ json: { ok: true } });
      }
      const payloads = fixture();
      payloads.api = api;
      payloads.groups.groups = [{ name: "Outer", kind: "select", selected, members: ["Leaf", "Other"], member_info: structuredClone(memberInfo) }];
      assert.ok(Object.hasOwn(payloads, key), `missing fixture ${key}`);
      if (key === "groups") {
        reads++;
        active++;
        maxActive = Math.max(maxActive, active);
        const failed = fail;
        if (hold) {
          const gate = Promise.withResolvers();
          held.push(gate);
          await gate.promise;
        }
        try {
          await route.fulfill({ status: failed ? 503 : 200, json: failed ? { error: "mock unavailable" } : payloads.groups });
        } finally { active--; settled++; }
      } else await route.fulfill({ json: payloads[key] });
    } catch (error) {
      errors.push(error.message);
      await route.abort();
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/popup.html`);
  const badge = page.locator('.member-item[data-group="Outer"][data-member="Leaf"] .latency-badge');
  await until(async () => await badge.textContent() === "17ms");
  const history = { member: "Leaf", paths: [["Outer", "Leaf"]], ok: true, latency_ms: 99, tested_at_unix_ms: 100 };
  let task = { id: 7, task_namespace: "mock-process", group: "Outer", status: "completed", completed: 1, total: 20, update_sequence: 2, results: [history] };
  const notify = () => page.evaluate((tasks) => window.notifyTasks(tasks), [task]);
  memberInfo = [info];
  await notify();
  await until(async () => !(await badge.textContent()).includes("ms"));
  await notify();
  assert.ok(!(await badge.textContent()).includes("ms"), "old task must not resurrect invalidated health");

  memberInfo = [{ ...info, last_test_ok: true, last_test_ms: 31, last_test_at_unix_ms: 20 }];
  task = { ...task, id: 8, status: "running", completed: 1 };
  await notify();
  await until(async () => await badge.textContent() === "31ms");
  fail = true;
  const failedAt = settled;
  task = { ...task, completed: 2, update_sequence: 3 };
  await notify();
  await until(() => settled > failedAt);
  await delay(50);
  assert.equal(await badge.textContent(), "31ms", "transient query failure preserves last-good health");
  fail = false;
  memberInfo = [info];
  await notify();
  await until(async () => !(await badge.textContent()).includes("ms"));

  // Notifications while a read is blocked coalesce into one follow-up snapshot.
  hold = true;
  const beforeBurst = reads;
  task = { ...task, completed: 3, update_sequence: 4 };
  await notify();
  await until(() => held.length === 1);
  for (let completed = 4; completed <= 15; completed++) {
    task = { ...task, completed, update_sequence: completed + 1 };
    await notify();
  }
  assert.equal(reads, beforeBurst + 1);
  memberInfo = [{ ...info, last_test_ok: true, last_test_ms: 42, last_test_at_unix_ms: 30 }];
  hold = false;
  held.shift().resolve();
  await until(async () => await badge.textContent() === "42ms");
  assert.equal(reads, beforeBurst + 2);
  assert.equal(maxActive, 1, "progress queries are single-flight");

  // A pre-selection snapshot cannot overwrite a newer post-selection read.
  hold = true;
  task = { ...task, completed: 16, update_sequence: 17 };
  await notify();
  await until(() => held.length === 1);
  hold = false;
  memberInfo = [info];
  await page.locator('.member-item[data-member="Other"] .member-name').click();
  await until(async () => !(await badge.textContent()).includes("ms"));
  const beforeRelease = settled;
  held.shift().resolve();
  await until(() => settled > beforeRelease);
  await delay(50);
  assert.ok(!(await badge.textContent()).includes("ms"));
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__screenshotErrors), []);
  console.log("Mounted popup: current health authority, late task, failure/retry, bounded progress reads and selection race passed");
} finally {
  for (const gate of held) gate.resolve();
  await context.close();
  await browser.close();
}
