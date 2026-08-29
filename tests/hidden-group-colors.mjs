import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../popup.css", import.meta.url), "utf8");

assert.doesNotMatch(css, /\.btn-toggle-hidden\.smart\s*\{/);
assert.match(
  css,
  /\.btn-section-action,\s*\.btn-toggle-hidden\s*\{[\s\S]*?color:\s*var\(--text-muted\);/,
);
assert.match(
  css,
  /\.hidden-kind-badge\s*\{[\s\S]*?background:\s*rgba\(255, 255, 255, 0\.05\);[\s\S]*?color:\s*var\(--text-dim\);/,
);

console.log("hidden group color tests passed");
