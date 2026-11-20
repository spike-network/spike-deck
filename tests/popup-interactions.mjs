import "./helpers/lang-zh-cn.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  installTaskHub,
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

// Task hub: driven by setTaskRunning, no DOM scraping and no observers.
function fakeElement(id = "") {
  return {
    id,
    hidden: true,
    className: "",
    children: [],
    listeners: {},
    replaceCount: 0,
    set innerHTML(html) {
      this.text = html.replace(/<[^>]*>/g, "");
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.replaceCount += 1;
      this.children = nodes;
    },
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
  };
}

function hubHarness() {
  const hub = fakeElement("runtime-task-hub");
  const list = fakeElement("runtime-task-list");
  const clicks = [];
  const controls = ["providers-panel", "modules-panel"].map((panelId) => ({
    getAttribute: () => panelId,
    click: () => clicks.push(panelId),
  }));
  globalThis.MutationObserver = class {
    constructor() {
      throw new Error("task hub must not use MutationObserver");
    }
  };
  globalThis.document = {
    createElement: () => fakeElement(),
    getElementById: (id) =>
      ({
        "runtime-task-hub": hub,
        "runtime-task-list": list,
        "providers-panel": { id: "providers-panel" },
        "modules-panel": { id: "modules-panel" },
      })[id] || null,
    querySelectorAll: () => controls,
    querySelector() {
      throw new Error("task hub must not query the DOM for state");
    },
  };
  return { hub, list, clicks, setTaskRunning: installTaskHub() };
}

{
  const { hub, list, clicks, setTaskRunning } = hubHarness();
  const labels = () => list.children.map((row) => row.text);
  assert.equal(hub.hidden, true);
  assert.deepEqual(labels(), []);

  setTaskRunning("providers", true);
  assert.equal(hub.hidden, false);
  assert.deepEqual(labels(), ["资源更新 · 运行中"]);
  assert.equal(list.children[0].className, "runtime-task-item");
  assert.equal(list.children[0].children[0].className, "btn-task-action");
  assert.equal(list.children[0].children[0].textContent, "查看");
  list.children[0].children[0].listeners.click();
  assert.deepEqual(clicks, ["providers-panel"]);

  const renders = list.replaceCount;
  setTaskRunning("providers", true);
  assert.equal(list.replaceCount, renders, "unchanged value must not re-render");

  setTaskRunning("modules", true);
  assert.deepEqual(labels(), ["资源更新 · 运行中", "模块更新 · 运行中"]);
  list.children[1].children[0].listeners.click();
  assert.deepEqual(clicks, ["providers-panel", "modules-panel"]);

  setTaskRunning("providers", false);
  assert.deepEqual(labels(), ["模块更新 · 运行中"]);
  assert.equal(hub.hidden, false);

  const before = list.replaceCount;
  setTaskRunning("bogus", true);
  setTaskRunning("providers", false);
  assert.equal(list.replaceCount, before);
  assert.deepEqual(labels(), ["模块更新 · 运行中"]);

  setTaskRunning("modules", false);
  assert.deepEqual(labels(), []);
  assert.equal(hub.hidden, true);
}

{
  // Missing hub elements: setTaskRunning stays a callable no-op.
  globalThis.document = { getElementById: () => null };
  const setTaskRunning = installTaskHub();
  assert.equal(typeof setTaskRunning, "function");
  setTaskRunning("providers", true);
}

console.log("popup interaction tests passed");
