import assert from "node:assert/strict";

import {
  providerRefreshState,
  observeProviderActivations,
  providerTaskProgress,
  summarizeProviderRefreshError,
} from "../lib/provider-refresh-view.js";

const task = {
  status: "running",
  providerResults: [
    { providerId: "pending", status: "pending", error: null },
    { providerId: "ready", status: "succeeded", error: null },
    { providerId: "failed-http", status: "failed", error: "source: HTTP 500 Internal Server Error" },
    {
      providerId: "failed-timeout",
      status: "failed",
      error: "policy-path download timed out after 30s: deadline has elapsed",
    },
  ],
};

assert.deepEqual(providerTaskProgress(task), { completed: 3, failed: 2, total: 4 });
assert.equal(
  summarizeProviderRefreshError("source: HTTP 500 Internal Server Error"),
  "HTTP 500 Internal Server Error",
);
assert.equal(
  summarizeProviderRefreshError("policy-path download timed out after 30s: deadline has elapsed"),
  "下载超时（30s）",
);

console.log("provider refresh incremental view checks passed");

assert.equal(providerRefreshState({ refresh_state: "queued", refreshing: false }), "queued");
assert.equal(providerRefreshState({ refreshing: true }), "downloading");
let observed = observeProviderActivations(new Map(), [{ id: "a", refresh_state: "downloading", last_successful_activation_unix_ms: 5 }], 100);
observed = observeProviderActivations(observed, [{ id: "a", refresh_state: "activating", last_successful_activation_unix_ms: 5 }], 200);
assert.equal(observed.get("a").updatedUntil, 0);
observed = observeProviderActivations(observed, [{ id: "a", refresh_state: "idle", last_successful_activation_unix_ms: 6 }], 300);
assert.equal(observed.get("a").updatedUntil, 3300);
assert.equal(observeProviderActivations(observed, [], 400).size, 0);
assert.deepEqual(providerTaskProgress({ providerResults: [{ status: "running", joined: true }, { status: "succeeded" }] }), { completed: 1, failed: 0, total: 2 });
const failed = observeProviderActivations(new Map([["b", { state: "downloading", activation: 1 }]]), [{ id: "b", refresh_state: "idle", last_successful_activation_unix_ms: 1, last_refresh_error: "mock error" }], 400);
assert.equal(failed.get("b").updatedUntil, 0);

assert.equal(observeProviderActivations(new Map([["a", { source: "old", state: "downloading", activation: 1 }]]), [{ id: "a", source: "new", refresh_state: "idle", last_successful_activation_unix_ms: 2 }], 400).get("a").updatedUntil, 0);
