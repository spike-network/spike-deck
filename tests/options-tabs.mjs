import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeOptionsTabs } from "../lib/options-tabs.js";

const nodes = new Map();
for (const id of ["tab-global", "tab-instances", "options-global", "options-instances"]) {
  nodes.set(id, {
    handlers: {},
    attributes: {},
    hidden: false,
    focused: false,
    addEventListener(event, callback) {
      this.handlers[event] = callback;
    },
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
    focus() {
      this.focused = true;
    },
  });
}
let hashChange;
const window = {
  location: { hash: "#instances" },
  history: {
    replaceState(_, __, hash) {
      window.location.hash = hash;
    },
  },
  addEventListener(_, callback) {
    hashChange = callback;
  },
};
initializeOptionsTabs({ getElementById: (id) => nodes.get(id) }, window);
const globalTab = nodes.get("tab-global");
const instancesTab = nodes.get("tab-instances");
const globalPanel = nodes.get("options-global");
const instancesPanel = nodes.get("options-instances");
assert.equal(globalPanel.hidden, true);
assert.equal(instancesPanel.hidden, false);
assert.equal(instancesTab.tabIndex, 0);
instancesPanel.draft = "unsaved name";
globalTab.handlers.click();
assert.equal(window.location.hash, "#global");
assert.equal(globalPanel.hidden, false);
assert.equal(instancesPanel.hidden, true);
let prevented = false;
globalTab.handlers.keydown({
  key: "ArrowRight",
  preventDefault() {
    prevented = true;
  },
});
assert.equal(prevented, true);
assert.equal(instancesPanel.hidden, false);
assert.equal(instancesPanel.draft, "unsaved name");
assert.equal(instancesTab.focused, true);
assert.equal(instancesTab.attributes["aria-selected"], "true");
for (const key of ["Home", "ArrowRight", "End", "ArrowLeft"]) {
  const tab = window.location.hash === "#global" ? globalTab : instancesTab;
  tab.handlers.keydown({ key, preventDefault() {} });
}
assert.equal(window.location.hash, "#global");
window.location.hash = "#unknown";
hashChange();
assert.equal(globalPanel.hidden, false);

const html = readFileSync(new URL("../options.html", import.meta.url), "utf8");
const globalContent = html.split('id="options-global"')[1].split('id="options-instances"')[0];
const instanceContent = html.split('id="options-instances"')[1];
for (const id of [
  "pref-language",
  "pref-control-proxy",
  "pref-popup-shortcut",
  "pref-health-interval",
  "pref-traffic-interval",
  "pref-expand-mode",
  "pref-hidden-mode",
  "pref-disconnect-affected-connections",
  "pref-collapse-after-selection",
]) {
  assert.ok(globalContent.includes(`id="${id}"`));
  assert.ok(!instanceContent.includes(`id="${id}"`));
}
assert.ok(globalContent.includes("data-spike-theme-control"));
for (const id of ["instances-container", "instance-form", "profile-export-text"]) {
  assert.ok(instanceContent.includes(`id="${id}"`));
  assert.ok(!globalContent.includes(`id="${id}"`));
}
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length);
console.log("options tab tests passed");
