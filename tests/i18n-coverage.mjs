import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

import { translateForLanguage } from "../lib/i18n.js";

// Messages are keyed by their Chinese source text, so a literal that is
// missing from the table shows up untranslated without any error. This scans
// the sources for Chinese string literals and checks each has an English form.

const root = new URL("../", import.meta.url);
const cjk = /[一-鿿]/;
const literal = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

// Halves of a template literal that nests another template literal. The
// scanner splits them; the full message is covered by a pattern.
const SPLIT_TEMPLATE_PARTS = new Set(["子分组: ${member}${subSel ? ", " : \"\"} - 点击测试"]);

async function sourceFiles() {
  const top = (await readdir(root)).filter((name) => name.endsWith(".js"));
  const lib = (await readdir(new URL("lib/", root)))
    .filter((name) => name.endsWith(".js") && !name.startsWith("i18n"))
    .map((name) => `lib/${name}`);
  return [...top, ...lib].sort();
}

function hasEnglishForm(text) {
  const plain = text.replace(/<[^>]+>/g, "");
  // Interpolations are filled with a word and with a number, since patterns
  // may require either.
  return ["X1", "7"].some(
    (fill) => !cjk.test(translateForLanguage(plain.replace(/\$\{[^}]*\}/g, fill), "en")),
  );
}

const missing = [];
for (const file of await sourceFiles()) {
  const lines = (await readFile(new URL(file, root), "utf8")).split("\n");
  lines.forEach((line, index) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    for (const match of line.matchAll(literal)) {
      const text = match[1] ?? match[2] ?? match[3];
      if (!cjk.test(text) || SPLIT_TEMPLATE_PARTS.has(text)) continue;
      if (!hasEnglishForm(text)) missing.push(`${file}:${index + 1}: ${text}`);
    }
  });
}

assert.deepEqual(missing, [], `Chinese literals without an English message:\n${missing.join("\n")}`);

assert.equal(translateForLanguage("更新避开状态失败: boom", "en"), "Failed to update avoidance: boom");
assert.equal(translateForLanguage("下载超时", "en"), "Download timed out");

console.log("i18n coverage checks passed");
