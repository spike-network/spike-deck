import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../popup.css", import.meta.url), "utf8");

assert.match(css, /--lat-slow:\s*#d97706;/);
assert.match(css, /--lat-error:\s*#ff453a;/);
assert.match(
  css,
  /\.latency-badge\.lat-slow\s*\{[\s\S]*?color:\s*var\(--lat-slow\);/,
);
assert.match(
  css,
  /\.latency-badge\.lat-error\s*\{[\s\S]*?color:\s*var\(--lat-error\);/,
);

console.log("latency color tests passed");
