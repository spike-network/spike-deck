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
assert.equal(translateForLanguage("包含关键字", "en"), "Include keyword");
assert.equal(translateForLanguage("排除关键字", "en"), "Exclude keyword");
assert.equal(translateForLanguage("时间降序", "en"), "Newest first");
assert.equal(translateForLanguage("清空当前视图", "en"), "Clear current view");
assert.equal(translateForLanguage("重载预览", "en"), "Reload preview");
assert.equal(translateForLanguage("External value", "en"), "External value");
assert.equal(translateForLanguage("3 分钟前", "en"), "3 min ago");
assert.equal(translateForLanguage("远程 · 1h", "en"), "Remote · 1h");
assert.equal(translateForLanguage("本地 · 1h", "en"), "Local · 1h");
assert.equal(
  translateForLanguage(
    "https://rules.example.test/a\n组: Demo\n来源: remote",
    "en",
  ),
  "https://rules.example.test/a\nGroup: Demo\nSource: remote",
);
assert.equal(translateForLanguage("Peer", "zh-CN"), "对端");
for (const source of [
  "现有连接：",
  " · 规则：DOMAIN-SUFFIX#216",
  " · 1 条",
  "检查失败：Mock error",
  "未匹配",
  "暂无匹配连接",
  "未配置 Spike 实例",
  "重新检查",
  "清除未知结果",
  "确认清除",
  "清除仅解除操作锁定，不会重放请求，也不代表上次更新成功。",
  "模块更新正在进行，本次请求未提交",
  "无法确认模块更新结果；请重新检查当前状态，勿重复提交",
  "暂时无法查询模块任务，正在重试",
  "模块更新失败，请检查当前模块和运行状态",
  "实例连接已更改，无法确认原模块任务的结果",
  "模块更新请求未被接受",
  "模块任务状态已改变，请重新检查",
]) {
  assert.doesNotMatch(translateForLanguage(source, "en"), /\p{Script=Han}/u);
}
for (const source of ["Time", "Severity", "Category", "Event"]) {
  assert.match(translateForLanguage(source, "zh-CN"), /\p{Script=Han}/u);
}
assert.equal(
  translateForLanguage("Terminate connection #7?", "zh-CN"),
  "终止连接 #7？",
);
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
