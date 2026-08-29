import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../popup.css", import.meta.url), "utf8");
const sizing = readFileSync(
  new URL("../popup-max-height.js", import.meta.url),
  "utf8",
);

assert.match(css, /body\s*\{[\s\S]*?height:\s*var\(--popup-max-height, 600px\);/);
assert.match(css, /body\s*\{[\s\S]*?overflow-y:\s*scroll;/);
assert.match(css, /scrollbar-gutter:\s*stable;/);
assert.match(css, /html\s*\{[\s\S]*?overflow:\s*hidden;/);
assert.match(css, /html\.popup-sizing\s*\{[\s\S]*?visibility:\s*hidden;/);
assert.match(sizing, /const MAX_PX = 600;/);
assert.match(sizing, /requestAnimationFrame\(reveal\);/);

console.log("popup layout tests passed");
