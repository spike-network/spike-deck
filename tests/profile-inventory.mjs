import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SpikeApiClient } from "../lib/spike-client.js";

const source = readFileSync(new URL("../popup.js", import.meta.url), "utf8");
const start = source.indexOf("  async function refreshProfileControls(");
const end = source.indexOf("\n  async function switchActiveProfile", start);
assert.ok(start >= 0 && end > start);
const select = { children: [], value: "", disabled: true,
  replaceChildren(...children) { this.children = children; this.value = children[0]?.value || ""; } };
const badge = { hidden: true }, error = { hidden: true }, retry = {}, change = {};
let fail = false, names = ["mock-current", "mock-alternate"], held;
const calls = [];
const api = {
  profileStem: SpikeApiClient.profileStem,
  parseManagedProfile: SpikeApiClient.parseManagedProfile,
  getProfiles: async () => {
    calls.push("list");
    if (held) return held.promise;
    if (fail) throw new Error("mock-secret must not appear in feedback");
    return { profiles: names };
  },
  getCurrentProfile: async () => ({ profile: "#!MANAGED-CONFIG https://example.test/mock-profile interval=3600\n[General]\n" }),
};
const refresh = new Function("SpikeApiClient", "el", "profileSelect", "managedBadge", "profileListError", "btnProfileRetry", "btnProfileSwitch", "updateQuickSummaries", `
let profileInventoryInstance = null, profileInventoryStem = '', profileInventoryFailed = true, profileInventoryRead = 0;
let profileSwitchOperation = null;
${source.slice(start, end)}
return refreshProfileControls;
`)(api, (_tag, attrs, text) => ({ value: attrs.value, text }), select, badge, error, retry, change, () => {});
const instance = { id: "mock-a", baseUrl: "https://example.test" };
const scope = { instance, isCurrent: () => true };
await refresh({ profile: "mock-current.conf" }, scope);
assert.deepEqual(select.children.map((item) => item.value), names);
assert.equal(badge.hidden, false);
fail = true;
await refresh({ profile: "mock-current.conf" }, scope);
assert.equal(error.hidden, false);
assert.equal(select.disabled, true);
assert.equal(change.disabled, true);
assert.equal(retry.disabled, false);
assert.deepEqual(select.children.map((item) => item.value), names);
assert.equal(badge.hidden, false, "same-profile failures retain the last successful badge");
fail = false;
await refresh({ profile: "mock-current.conf" }, scope);
assert.equal(error.hidden, true);
assert.equal(select.disabled, false);
assert.equal(change.disabled, false);

held = Promise.withResolvers();
const delayed = refresh({ profile: "mock-current.conf" }, scope);
const pending = held;
held = null;
names = ["mock-current", "mock-newer"];
await refresh({ profile: "mock-current.conf" }, scope);
pending.resolve({ profiles: ["mock-stale"] });
await delayed;
assert.deepEqual(select.children.map((item) => item.value), names, "late same-instance reads cannot replace newer data");

fail = true;
await refresh({ profile: "mock-current.conf" }, { instance: { id: "mock-b" }, isCurrent: () => true });
assert.deepEqual(select.children.map((item) => item.value), ["mock-current"], "failed instance changes do not retain another instance's list");
assert.equal(badge.hidden, true);
assert.equal(error.hidden, false);
assert.ok(calls.every((call) => call === "list"), "recovery performs no mutation");
console.log("Popup profile inventory retains scoped data, exposes failure/retry and rejects stale reads");
