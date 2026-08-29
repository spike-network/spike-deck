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
  messageMatches,
  resolvePreferredLanguage,
  setCurrentLanguage,
  translateForLanguage,
} = await import("../lib/i18n.js");

assert.equal(resolvePreferredLanguage("zh-Hans"), "zh-CN");
assert.equal(resolvePreferredLanguage("zh-TW"), "zh-CN");
assert.equal(resolvePreferredLanguage("en-GB"), "en");
assert.equal(translateForLanguage("外部资源", "en"), "Resources");
assert.equal(translateForLanguage("首个健康", "en"), "First available");
assert.equal(translateForLanguage("运行日志", "en"), "Runtime logs");
assert.equal(translateForLanguage("重载预览", "en"), "Reload preview");
assert.equal(translateForLanguage("External value", "en"), "External value");
assert.equal(translateForLanguage("3 分钟前", "en"), "3 min ago");
assert.equal(translateForLanguage("Peer", "zh-CN"), "对端");
assert.equal(translateForLanguage("Terminate connection #7?", "zh-CN"), "终止连接 #7？");
assert.equal(messageMatches("Updating modules…", "正在更新模块…"), true);

assert.equal(await initializeI18n(), "zh-CN");
assert.equal(stored[UI_LANGUAGE_KEY], "zh-CN");
assert.equal(getCurrentLanguage(), "zh-CN");
assert.equal(await setCurrentLanguage("en"), "en");
assert.equal(stored[UI_LANGUAGE_KEY], "en");
await assert.rejects(() => setCurrentLanguage("fr"), /Unsupported UI language/);

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

const makefile = await readFile(new URL("../Makefile", import.meta.url), "utf8");
assert.match(makefile, /\n\t_locales\n/);

console.log("i18n tests passed");
