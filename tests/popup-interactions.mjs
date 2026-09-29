import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  nextNavigationIndex,
  splitMatchSegments,
} from "../lib/popup-interactions.js";

assert.equal(nextNavigationIndex(0, "ArrowDown", 3), 1);
assert.equal(nextNavigationIndex(2, "ArrowDown", 3), 2);
assert.equal(nextNavigationIndex(2, "ArrowUp", 3), 1);
assert.equal(nextNavigationIndex(1, "Home", 3), 0);
assert.equal(nextNavigationIndex(1, "End", 3), 2);
assert.equal(nextNavigationIndex(0, "ArrowDown", 0), -1);

assert.deepEqual(splitMatchSegments("Hong Kong Relay", "kong"), [
  { text: "Hong ", match: false },
  { text: "Kong", match: true },
  { text: " Relay", match: false },
]);
assert.deepEqual(splitMatchSegments("Alpha alpha", "ALPHA"), [
  { text: "Alpha", match: true },
  { text: " ", match: false },
  { text: "alpha", match: true },
]);
assert.deepEqual(splitMatchSegments("unchanged", ""), [
  { text: "unchanged", match: false },
]);

const interactionCss = readFileSync(
  new URL("../interaction.css", import.meta.url),
  "utf8",
);
assert.match(
  interactionCss,
  /\.popup-page \.interaction-banner\[hidden\][\s\S]*?display:\s*none;/,
);

console.log("popup interaction tests passed");
