import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

// UI text lives in the message catalogs (lib/locales) and is referenced by key.
// A Chinese string literal anywhere else in the scripts is text that bypasses
// the catalogs and would not follow a language switch.

const root = new URL("../", import.meta.url);
const cjk = /[\u4e00-\u9fff]/;
const literal = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

async function sourceFiles() {
  const top = (await readdir(root)).filter((name) => name.endsWith(".js"));
  const lib = (await readdir(new URL("lib/", root)))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `lib/${name}`);
  return [...top, ...lib].sort();
}

const hardcoded = [];
for (const file of await sourceFiles()) {
  const lines = (await readFile(new URL(file, root), "utf8")).split("\n");
  lines.forEach((line, index) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    for (const match of line.matchAll(literal)) {
      const text = match[1] ?? match[2] ?? match[3];
      if (cjk.test(text)) hardcoded.push(`${file}:${index + 1}: ${text}`);
    }
  });
}

assert.deepEqual(hardcoded, [], `Chinese literals outside the message catalogs:\n${hardcoded.join("\n")}`);

console.log("i18n coverage checks passed");
