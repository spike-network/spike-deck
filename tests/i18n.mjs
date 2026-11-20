import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const stored = {};
const changeListeners = [];

globalThis.chrome = {
  i18n: {
    getUILanguage: () => "zh-Hans",
  },
  storage: {
    local: {
      async get(keys) {
        return Object.fromEntries(keys.map((key) => [key, stored[key]]));
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: stored[key], newValue: value };
          stored[key] = value;
        }
        for (const listener of changeListeners) listener(changes, "local");
      },
    },
    onChanged: {
      addListener(listener) {
        changeListeners.push(listener);
      },
    },
  },
};

const {
  UI_LANGUAGE_KEY,
  getCurrentLanguage,
  initializeI18n,
  onLanguageChange,
  resolvePreferredLanguage,
  setCurrentLanguage,
} = await import("../lib/i18n.js");

assert.equal(resolvePreferredLanguage("zh-Hans"), "zh-CN");
assert.equal(resolvePreferredLanguage("zh-TW"), "zh-CN");
assert.equal(resolvePreferredLanguage("en-GB"), "en");

assert.equal(await initializeI18n(), "zh-CN");
assert.equal(stored[UI_LANGUAGE_KEY], "zh-CN");
assert.equal(getCurrentLanguage(), "zh-CN");
assert.equal(await setCurrentLanguage("en"), "en");
assert.equal(stored[UI_LANGUAGE_KEY], "en");
await assert.rejects(() => setCurrentLanguage("fr"), /Unsupported UI language/);

{
  let changes = 0;
  onLanguageChange(() => {
    changes += 1;
  });
  await setCurrentLanguage("zh-CN");
  assert.equal(changes, 1);
  // A storage event that does not change the language is ignored.
  for (const listener of changeListeners) {
    listener({ [UI_LANGUAGE_KEY]: { newValue: "zh-CN" } }, "local");
  }
  assert.equal(changes, 1);
  await setCurrentLanguage("en");
  assert.equal(changes, 2);
}

for (const page of ["popup.html", "options.html", "tools.html"]) {
  const html = await readFile(new URL(`../${page}`, import.meta.url), "utf8");
  assert.match(html, /class="[^"]*i18n-pending/);
}
const optionsHtml = await readFile(
  new URL("../options.html", import.meta.url),
  "utf8",
);
assert.match(optionsHtml, /id="pref-language"/);
assert.match(optionsHtml, /value="zh-CN"/);
assert.match(optionsHtml, /value="en"/);
assert.match(
  optionsHtml,
  /<p[^>]*id="profile-export-status"[^>]*>尚未加载<\/p>/,
);
assert.match(
  optionsHtml,
  /<pre[^>]*id="profile-export-text"[^>]*hidden><\/pre>/,
);

const makefile = await readFile(
  new URL("../Makefile", import.meta.url),
  "utf8",
);
assert.match(makefile, /\n\t_locales\n/);

console.log("i18n tests passed");
