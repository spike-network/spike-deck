import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

import {
  MESSAGE_CATALOGS,
  SUPPORTED_UI_LANGUAGES,
  applyMessages,
  formatMessage,
  setMessage,
  setPlainText,
} from "../lib/i18n.js";

// Explicit message keys (lib/locales) must exist in every UI language, every
// key must be used, and _locales (manifest strings) must stay aligned.

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const catalogKeys = (language) => Object.keys(MESSAGE_CATALOGS[language]).sort();
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
// Keys are dotted ids under these namespaces, e.g. "options.form.save".
const namespaces = [...new Set(catalogKeys("en").map((key) => key.split(".")[0]))];
const keyLiteral = new RegExp(`["'\`]((?:${namespaces.join("|")})\\.[A-Za-z0-9.]+)["'\`]`, "g");

async function sourceFiles() {
  const top = (await readdir(root)).filter((name) => name.endsWith(".js"));
  const lib = (await readdir(new URL("lib/", root))).filter((name) => name.endsWith(".js")).map((name) => `lib/${name}`);
  return [...top, ...lib].sort();
}

async function htmlFiles() {
  return (await readdir(root)).filter((name) => name.endsWith(".html")).sort();
}

async function referencedKeys() {
  const refs = new Map();
  const add = (key, where) => {
    if (!refs.has(key)) refs.set(key, []);
    refs.get(key).push(where);
  };
  for (const file of await sourceFiles()) {
    const lines = (await read(file)).split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(keyLiteral)) {
        if (/\.(html|js|css|json|png)$/.test(match[1])) continue; // a file name, not a key
        add(match[1], `${file}:${index + 1}`);
      }
    });
  }
  for (const file of await htmlFiles()) {
    const html = await read(file);
    for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
      if (match[0].startsWith("data-i18n-params") || match[0].startsWith("data-i18n-ignore")) continue;
      add(match[1], file);
    }
  }
  return refs;
}

test("every UI language has exactly the same keys and placeholders", () => {
  assert.deepEqual(Object.keys(MESSAGE_CATALOGS).sort(), [...SUPPORTED_UI_LANGUAGES].sort());
  const english = catalogKeys("en");
  for (const language of SUPPORTED_UI_LANGUAGES) {
    const keys = catalogKeys(language);
    assert.deepEqual(
      keys.filter((key) => !english.includes(key)),
      [],
      `${language} has keys missing from en`,
    );
    assert.deepEqual(
      english.filter((key) => !keys.includes(key)),
      [],
      `${language} lacks keys present in en`,
    );
    for (const key of keys) {
      const text = MESSAGE_CATALOGS[language][key];
      assert.equal(typeof text, "string", `${language}:${key}`);
      assert.ok(text.trim(), `${language}:${key} is empty`);
      assert.deepEqual(placeholders(text), placeholders(MESSAGE_CATALOGS.en[key]), `${language}:${key} placeholders`);
    }
  }
  assert.ok(english.every((key) => /^[a-z]+(\.[A-Za-z0-9]+)+$/.test(key)), "keys are dotted identifiers");
});

test("every referenced key exists in every language and no key is orphaned", async () => {
  const refs = await referencedKeys();
  const missing = [];
  for (const [key, where] of refs) {
    for (const language of SUPPORTED_UI_LANGUAGES) {
      if (!Object.hasOwn(MESSAGE_CATALOGS[language], key)) missing.push(`${language}:${key} (${where.join(", ")})`);
    }
  }
  assert.deepEqual(missing, [], `referenced keys missing from a catalog:\n${missing.join("\n")}`);
  const orphans = catalogKeys("en").filter((key) => !refs.has(key));
  assert.deepEqual(orphans, [], `catalog keys referenced nowhere:\n${orphans.join("\n")}`);
});

test("message calls take literal keys so the scan above sees them", async () => {
  const dynamic = [];
  for (const file of await sourceFiles()) {
    if (file === "lib/i18n.js") continue;
    const lines = (await read(file)).split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(/\b(?:msg|formatMessage)\(\s*([^)\s][^,)]*)/g)) {
        if (!/^["'`]/.test(match[1])) dynamic.push(`${file}:${index + 1}: ${match[0]}`);
      }
      for (const match of line.matchAll(/\bsetMessage\(\s*[^,]+,\s*([^,)]+)/g)) {
        const arg = match[1].trim();
        // A ternary between two literal keys is still statically visible.
        if (!/^["'`]/.test(arg) && !/\?\s*["'`]/.test(line) && arg !== "key" && arg !== "state.key") {
          dynamic.push(`${file}:${index + 1}: ${match[0]}`);
        }
      }
    });
  }
  assert.deepEqual(dynamic, [], `non-literal message keys:\n${dynamic.join("\n")}`);
});

test("static HTML fallback text matches the zh-CN catalog", async () => {
  const drift = [];
  const normalize = (text) => text.replace(/\s+/g, " ").trim();
  for (const file of await htmlFiles()) {
    const html = await read(file);
    for (const match of html.matchAll(/<(\w+)\b[^>]*\sdata-i18n="([^"]+)"[^>]*>([^<]*)<\/\1>/g)) {
      const [, , key, inline] = match;
      const expected = MESSAGE_CATALOGS["zh-CN"][key];
      if (normalize(inline) && normalize(inline) !== normalize(expected ?? "")) {
        drift.push(`${file}: ${key}: ${normalize(inline)}`);
      }
    }
  }
  assert.deepEqual(drift, [], `HTML text differs from zh-CN catalog:\n${drift.join("\n")}`);
});

test("_locales languages are aligned with each other and with the manifest", async () => {
  const dirs = (await readdir(new URL("_locales/", root))).sort();
  assert.ok(dirs.includes("en") && dirs.includes("zh_CN"));
  const manifest = await read("manifest.json");
  const used = [...new Set([...manifest.matchAll(/__MSG_(\w+)__/g)].map((match) => match[1]))].sort();
  for (const dir of dirs) {
    const messages = JSON.parse(await read(`_locales/${dir}/messages.json`));
    const keys = Object.keys(messages).sort();
    assert.deepEqual(keys, used, `_locales/${dir} keys must equal the manifest's __MSG_ references`);
    for (const key of keys) {
      assert.ok(/^[A-Za-z0-9_@]+$/.test(key), `${dir}:${key} is a valid Chrome message name`);
      assert.ok(messages[key].message?.trim(), `${dir}:${key} has a message`);
    }
  }
});

test("formatMessage fills parameters, falls back to English and exposes missing keys", () => {
  assert.equal(formatMessage("options.form.editTitleNamed", { name: "Edge" }, "en"), "Edit instance: Edge");
  assert.equal(formatMessage("options.form.editTitleNamed", { name: "Edge" }, "zh-CN"), "编辑实例: Edge");
  assert.equal(formatMessage("options.form.editTitleNamed", {}, "en"), "Edit instance: {name}");
  assert.equal(formatMessage("common.cancel", undefined, "fr"), "Cancel");
  assert.equal(formatMessage("no.such.key", undefined, "en"), "no.such.key");
});

// Minimal element stand-in: enough for applyMessages / setMessage.
class FakeElement {
  constructor(attributes = {}, children = []) {
    this.attributes = new Map(Object.entries(attributes));
    this.children = children;
    this.textContent = "";
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  matches(selector) {
    return selector.split(",").some((part) => this.hasAttribute(part.trim().slice(1, -1)));
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

test("applyMessages renders keyed text and attributes; setMessage survives a re-render", () => {
  // No stored language in this process, so the browser language decides.
  globalThis.chrome = { i18n: { getUILanguage: () => "en-US" } };
  const label = new FakeElement({ "data-i18n": "options.form.save" });
  const input = new FakeElement({ "data-i18n-placeholder": "options.form.secret.placeholder" });
  const status = new FakeElement();
  const page = new FakeElement({}, [label, input, status]);
  applyMessages(page);
  assert.equal(label.textContent, MESSAGE_CATALOGS.en["options.form.save"]);
  assert.equal(input.getAttribute("placeholder"), MESSAGE_CATALOGS.en["options.form.secret.placeholder"]);

  setMessage(status, "options.form.testFailed", { error: "timeout" });
  assert.equal(status.textContent, "❌ Connection failed: timeout");
  status.textContent = "stale";
  applyMessages(page);
  assert.equal(status.textContent, "❌ Connection failed: timeout", "params are kept for re-rendering");

  setPlainText(status, "Core error");
  applyMessages(page);
  assert.equal(status.textContent, "Core error", "plain text is not overwritten");
  delete globalThis.chrome;
});

test("a keyed page initializes once without a document observer", async () => {
  const { initializeI18n } = await import("../lib/i18n.js");
  let observers = 0;
  const heading = new FakeElement({ "data-i18n": "options.title" });
  const html = new FakeElement({}, [heading]);
  html.classList = { remove(name) { html.removed = name; } };
  globalThis.document = { documentElement: html };
  globalThis.MutationObserver = class { constructor() { observers += 1; } observe() {} };
  globalThis.chrome = {
    i18n: { getUILanguage: () => "zh-CN" },
    storage: {
      local: { async get() { return { uiLanguage: "zh-CN" }; }, async set() {} },
      onChanged: { addListener() {} },
    },
  };
  try {
    assert.equal(await initializeI18n({ observe: false }), "zh-CN");
    assert.equal(observers, 0);
    assert.equal(heading.textContent, "SpikeDeck 设置");
    assert.equal(html.lang, "zh-CN");
    assert.equal(html.removed, "i18n-pending");
  } finally {
    delete globalThis.document;
    delete globalThis.MutationObserver;
    delete globalThis.chrome;
  }
});
