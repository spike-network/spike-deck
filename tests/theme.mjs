import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const values = new Map(),
  events = {},
  controlEvents = {};
const control = {
  value: "system",
  addEventListener: (_, fn) => (controlEvents.change = fn),
};
const root = { dataset: {} };
const media = {
  matches: true,
  addEventListener: (_, fn) => (events.media = fn),
};
const storage = {
  getItem: (key) => values.get(key),
  setItem: (key, value) => values.set(key, value),
};
vm.runInNewContext(
  readFileSync(new URL("../theme.js", import.meta.url), "utf8"),
  {
    localStorage: storage,
    document: {
      documentElement: root,
      querySelectorAll: () => [control],
      addEventListener: (name, fn) => (events[name] = fn),
    },
    window: {
      matchMedia: () => media,
      addEventListener: (name, fn) => (events[name] = fn),
    },
  },
);
assert.equal(root.dataset.spikeTheme, "dark");
events.DOMContentLoaded();
control.value = "light";
controlEvents.change();
events.media();
assert.equal(root.dataset.spikeTheme, "light");
control.value = "system";
controlEvents.change();
media.matches = false;
events.media();
assert.equal(root.dataset.spikeTheme, "light");
values.set("spike.deck.theme", "dark");
events.storage({ key: "spike.deck.theme" });
assert.equal(root.dataset.spikeTheme, "dark");
assert.equal(control.value, "dark");
storage.setItem = () => {
  throw Error("blocked");
};
control.value = "light";
controlEvents.change();
events.media();
assert.equal(root.dataset.spikeTheme, "light");
for (const page of ["popup", "options", "tools"]) {
  const html = readFileSync(
    new URL(`../${page}.html`, import.meta.url),
    "utf8",
  );
  assert.ok(html.includes('src="theme.js"'));
  assert.equal(html.includes("data-spike-theme-control"), page === "options");
  assert.ok(
    readFileSync(new URL(`../${page}.css`, import.meta.url), "utf8").includes(
      '@import url("design-tokens.css")',
    ),
  );
}
const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");
for (const file of ["design-tokens.css", "theme.js", "theme.css"])
  assert.ok(makefile.includes(file));
console.log("shared theme and package tests passed");
