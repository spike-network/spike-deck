import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../popup.css", import.meta.url), "utf8");

assert.doesNotMatch(css, /\.btn-toggle-hidden\.smart\s*\{/);
assert.match(
  css,
  /\.btn-section-action,\s*\.btn-toggle-hidden\s*\{[\s\S]*?color:\s*var\(--text-muted\);/,
);

console.log("hidden group color tests passed");
