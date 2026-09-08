import assert from "node:assert/strict";
import { fixture, installChromeMock, now } from "../store/fixture.mjs";

for (const stress of [false, true]) {
  const data = fixture(stress);
  assert.equal(data.status.groups, data.groups.groups.length);
  assert.ok(data.profiles.profiles.every((name) => typeof name === "string"));
  for (const group of data.groups.groups) {
    assert.ok(group.members.includes(group.selected));
    assert.deepEqual(
      group.member_info.map((member) => member.name),
      group.members,
    );
    assert.ok(
      group.member_info.every((member) => member.last_test_at_unix_ms === now),
    );
  }
}

const originalNow = Date.now;
globalThis.localStorage = { setItem() {} };
globalThis.location = { origin: "http://deck.example.test" };
globalThis.window = {};
try {
  installChromeMock({ theme: "dark", language: "en", now });
  const { chrome } = window;
  const first = await chrome.storage.local.get("instances");
  first.instances[0].name = "Changed";
  assert.equal(
    (await chrome.storage.local.get("instances")).instances[0].name,
    "Demo",
  );
  let callbackTabs;
  const tabs = await chrome.tabs.query({}, (value) => {
    callbackTabs = value;
  });
  assert.equal(tabs[0].height, 800);
  assert.deepEqual(tabs, callbackTabs);
  await assert.rejects(
    chrome.runtime.sendMessage({ type: "UNEXPECTED" }),
    /Unmocked/,
  );
  assert.equal(Date.now(), now);
} finally {
  Date.now = originalNow;
  delete globalThis.localStorage;
  delete globalThis.location;
  delete globalThis.window;
}
console.log("store fixture tests passed");
