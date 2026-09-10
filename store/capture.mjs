import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  open,
} from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { fixture, installChromeMock, now } from "./fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const output = resolve(
  process.env.SCREENSHOT_OUTPUT ||
    resolve(root, "dist", check ? "ui-check" : "screenshots"),
);
const origin = "http://deck.example.test";
const scenes = [
  { name: "groups", page: "popup", ready: ".group-card" },
  {
    name: "groups-tooltip",
    page: "popup",
    hover: ".group-name",
    ready: ".ui-tooltip.visible",
  },
  {
    name: "mode",
    page: "popup",
    click: "#btn-quick-outbound",
    ready: "#outbound-mode-card",
  },
  {
    name: "profile",
    page: "popup",
    click: "#btn-quick-profile",
    ready: "#quick-panel-profile",
  },
  {
    name: "providers",
    page: "popup",
    click: "#btn-refresh-providers",
    ready: ".provider-source",
  },
  { name: "global", page: "options", ready: "#options-global" },
  {
    name: "instances",
    page: "options",
    click: "#tab-instances",
    ready: "#options-instances",
  },
];
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

async function capture(browser, scene, theme, language, width, staging) {
  const popup = scene.page === "popup";
  const context = await browser.newContext({
    viewport: { width, height: popup ? 600 : 720 },
    deviceScaleFactor: 1,
    locale: language,
    timezoneId: "UTC",
    colorScheme: theme,
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  const errors = [];
  try {
    const payloads = fixture(check);
    payloads.api = JSON.parse(
      await readFile(resolve(root, "tests/fixtures/control-api-v1.json")),
    );
    await context.addInitScript(installChromeMock, { theme, language, now });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      try {
        assert.equal(url.origin, origin, "External request blocked");
        const method = url.pathname === "/spike/dns/delay" ? "POST" : "GET";
        assert.equal(
          request.method(),
          method,
          `Unmocked method: ${url.pathname}`,
        );
        if (url.pathname.startsWith("/spike/")) {
          const key = url.pathname.slice(7);
          assert.ok(
            Object.hasOwn(payloads, key),
            `Missing API fixture: ${key}`,
          );
          await route.fulfill({ json: payloads[key] });
        } else {
          const path = decodeURIComponent(url.pathname).slice(1);
          assert.match(
            path,
            /^(popup[^/]*\.(html|js|css)|options\.(html|js|css)|interaction\.css|theme\.(css|js)|design-tokens\.css|lib\/[\w-]+\.js|icons\/[\w.-]+|_locales\/[\w-]+\/messages\.json)$/,
          );
          await route.fulfill({
            body: await readFile(resolve(root, path)),
            contentType: types[extname(path)],
          });
        }
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`${origin}/${scene.page}.html`);
    if (popup) {
      await page.locator(".group-card").first().waitFor();
      await page.waitForFunction(() =>
        document.querySelector("#status-dot").classList.contains("online"),
      );
      await page.waitForFunction(() =>
        document.querySelector("#traffic-total").textContent.includes("/"),
      );
    } else {
      await page.waitForFunction(
        () => document.querySelector("#inst-name").value === "Demo",
      );
    }
    if (scene.click) await page.locator(scene.click).click();
    if (scene.hover) await page.locator(scene.hover).first().hover();
    await page.locator(scene.ready).first().waitFor();
    if (scene.name === "groups")
      await page.locator(".group-header").first().click();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode()));
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    });
    const layout = await page.evaluate(() => {
      const visible = (e) => e.getClientRects().length > 0;
      const rect = (e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      return {
        width: document.documentElement.scrollWidth,
        theme: document.documentElement.dataset.spikeTheme,
        body: rect(document.body),
        toolbar: [...document.querySelectorAll(".header-actions > *")].map(
          rect,
        ),
        clippedTraffic: [...document.querySelectorAll(".traffic-row > span")]
          .filter(visible)
          .filter((e) => e.scrollWidth > e.clientWidth + 1)
          .map((e) => e.id),
      };
    });
    assert.equal(layout.theme, theme);
    assert.ok(
      layout.width <= width,
      `Horizontal overflow: ${layout.width} > ${width}`,
    );
    if (popup) {
      assert.equal(layout.body.width, 415);
      assert.equal(layout.body.height, 600);
      assert.equal(
        new Set(layout.toolbar.map((r) => r.y)).size,
        1,
        "Toolbar wrapped",
      );
      assert.deepEqual(layout.clippedTraffic, [], "Traffic text clipped");
    }
    if (check && language === "en") {
      const untranslated = await page.evaluate(() => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        const result = [];
        let node;
        while ((node = walker.nextNode())) {
          const element = node.parentElement;
          if (
            !element ||
            !element.getClientRects().length ||
            element.closest(
              'pre, code, script, style, textarea, [data-i18n-ignore], option[value="zh-CN"]',
            )
          )
            continue;
          if (/\p{Script=Han}/u.test(node.data)) result.push(node.data.trim());
        }
        return result;
      });
      assert.deepEqual(untranslated, [], "Untranslated fixture UI text");
    }
    const raw = await page.screenshot({
      animations: "disabled",
      caret: "hide",
    });
    errors.push(...(await page.evaluate(() => window.__screenshotErrors)));
    assert.deepEqual(errors, [], "Page or fixture errors");
    const shot = PNG.sync.read(raw);
    assert.equal(shot.width, width);
    const colors = new Set();
    for (let i = 0; i < shot.data.length; i += 4)
      colors.add(shot.data.readUInt32BE(i));
    assert.ok(colors.size > 32, "Blank screenshot");
    let result = raw;
    if (!check) {
      const canvas = new PNG({ width: 1280, height: 800 });
      const color = theme === "dark" ? [24, 27, 29] : [237, 241, 242];
      for (let i = 0; i < canvas.data.length; i += 4)
        canvas.data.set([...color, 255], i);
      PNG.bitblt(
        shot,
        canvas,
        0,
        0,
        shot.width,
        shot.height,
        Math.floor((1280 - shot.width) / 2),
        Math.floor((800 - shot.height) / 2),
      );
      result = PNG.sync.write(canvas, {
        colorType: 2,
        inputColorType: 6,
        inputHasAlpha: true,
      });
      assert.equal(result[25], 2, "Store screenshots must be 24-bit RGB");
    }
    const name = `${scene.name}-${theme}-${language}-${width}.png`;
    await writeFile(resolve(staging, name), result);
    console.log(`OK ${name}`);
    return { name, ...layout };
  } finally {
    await context.close();
  }
}

await mkdir(dirname(output), { recursive: true });
const lock = await open(`${output}.lock`, "wx");
let staging;
let browser;
try {
  staging = await mkdtemp(`${output}.tmp-`);
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
  });
  const report = [];
  for (const theme of ["light", "dark"]) {
    for (const scene of scenes) {
      for (const language of check ? ["zh-CN", "en"] : ["zh-CN"]) {
        for (const width of scene.page === "popup"
          ? [415]
          : check
            ? [320, 1200]
            : [1200]) {
          report.push(
            await capture(browser, scene, theme, language, width, staging),
          );
        }
      }
    }
  }
  await writeFile(
    resolve(staging, "report.json"),
    JSON.stringify({ browser: browser.version(), check, report }, null, 2),
  );
  // Publish only a complete batch; preserve the old batch if publication fails.
  const backup = `${staging}.previous`;
  let hadPrevious = false;
  try {
    await rename(output, backup);
    hadPrevious = true;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  try {
    await rename(staging, output);
  } catch (e) {
    if (hadPrevious) await rename(backup, output);
    throw e;
  }
  if (hadPrevious) await rm(backup, { recursive: true });
  console.log(`Wrote ${report.length} screenshots to ${output}`);
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      if (staging) await rm(staging, { recursive: true, force: true });
    } finally {
      await lock.close();
      await rm(`${output}.lock`, { force: true });
    }
  }
}
