import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const svg = readFileSync(new URL("../icons/icon.svg", import.meta.url), "utf8");
assert.ok(svg.includes("#65d1c2"));
assert.doesNotMatch(svg, /linearGradient|feGaussianBlur/);
for (const size of [16, 48, 128]) {
  const png = readFileSync(new URL(`../icons/icon${size}.png`, import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
}
const css = readFileSync(new URL("../popup.css", import.meta.url), "utf8");
assert.match(css, /\.logo\s*\{[^}]*width: 32px;[^}]*height: 32px;/);
assert.match(css, /\.title\s*\{[^}]*font-size: 14px;[^}]*line-height: 18px;/);
console.log("brand asset tests passed");
