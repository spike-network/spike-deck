import assert from "node:assert/strict";
import { test } from "node:test";
import { coreError, requestErrorText, statusError } from "../lib/core-error.js";
import { MESSAGE_CATALOGS } from "../lib/i18n.js";
import { isRejectPolicy } from "../lib/group-selection.js";
import { SpikeApiClient } from "../lib/spike-client.js";

test("localizes the catalog with named arguments and preserves complete fallbacks", () => {
  assert.equal(Object.keys(MESSAGE_CATALOGS.en).filter(key => key.startsWith("core.")).length, 43);
  const code = "profile.group_member_unavailable";
  const args = { group: "Mock Group", member: "mock-node", extra: "ignored" };
  const english = "  Mock English chain  ";
  assert.equal(coreError(code, args, english, "zh-CN"), "策略组 Mock Group 引用了不可用的策略 mock-node");
  assert.equal(coreError(code, args, english, "en"), english);
  assert.equal(coreError(code, { group: "Mock Group" }, english, "zh-CN"), english);
  assert.equal(coreError(code, { group: "Mock Group", member: 4 }, english, "zh-CN"), english);
  assert.equal(coreError("mock.future", args, english, "zh-CN"), english);
  assert.equal(coreError(undefined, args, english, "zh-CN"), english);
  for (const [detail, given] of [
    ["profile.proxy_invalid", { proxy: "mock-node" }],
    ["profile.group_invalid", { group: "Mock Group" }],
    ["profile.ruleset_load_failed", { count: "2" }],
  ]) {
    assert.equal(coreError(detail, given, english, "zh-CN"),
      coreError(detail, given, undefined, "zh-CN") + ` (${english})`);
  }
  assert.equal(statusError({ error: english }), english);
  assert.equal(statusError({ udp_error: english }, "udp_error"), english);
});

test("HTTP error decoding keeps status, code, named args and the legacy English body", async (t) => {
  const instance = { baseUrl: "https://example.test" };
  for (const entry of [
    { status: 422, body: { ok: false, code: "profile.proxy_invalid",
      args: { proxy: "mock-node" }, error: "Mock invalid proxy: mock cause" } },
    { status: 401, body: { ok: false, code: "net.auth_failed", error: "Mock auth failure" } },
    { status: 400, body: { ok: false, error: "Mock old engine" } },
  ]) {
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(entry.body), { status: entry.status }));
    await assert.rejects(SpikeApiClient.getStatus(instance), error => {
      assert.equal(error.status, entry.status);
      assert.equal(error.code, entry.body.code);
      assert.deepEqual(error.args, entry.body.args);
      assert.equal(requestErrorText(error), entry.body.error);
      return true;
    });
    t.mock.restoreAll();
  }
});

test("only exact built-in reject names are reserved", () => {
  assert.equal(isRejectPolicy("REJECT-DROP"), true);
  assert.equal(isRejectPolicy("REJECT-NOVIDEO"), true);
  for (const name of ["reject", "Reject-x", "REJECT-X"]) assert.equal(isRejectPolicy(name), false);
});
