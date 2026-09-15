import assert from "node:assert/strict";

import {
  providerRefreshError,
  providerTaskDisplayStatus,
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
assert.equal(providerTaskDisplayStatus(task, "pending"), "refreshing");
assert.equal(providerTaskDisplayStatus(task, "ready"), "refresh_succeeded");
assert.equal(providerTaskDisplayStatus(task, "failed-http"), "update_failed");
assert.equal(
  providerRefreshError(task, "failed-http", { error: "old failure" }),
  "source: HTTP 500 Internal Server Error",
);
assert.equal(providerRefreshError(task, "ready", { error: "old failure" }), "");
assert.equal(providerRefreshError(task, "pending", { error: "old failure" }), "");
assert.equal(
  summarizeProviderRefreshError("source: HTTP 500 Internal Server Error"),
  "HTTP 500 Internal Server Error",
);
assert.equal(
  summarizeProviderRefreshError("policy-path download timed out after 30s: deadline has elapsed"),
  "下载超时（30s）",
);

const failedTask = { ...task, status: "failed" };
assert.equal(providerTaskDisplayStatus(failedTask, "ready"), "refresh_succeeded");
assert.equal(providerTaskDisplayStatus(failedTask, "failed-timeout"), "update_failed");
assert.equal(
  providerTaskDisplayStatus({ ...task, status: "succeeded" }, "ready"),
  null,
);
const singleTask = { ...task, providerId: "ready" };
assert.equal(providerTaskDisplayStatus(singleTask, "pending"), null);
assert.equal(
  providerRefreshError(singleTask, "pending", { error: "retained failure" }),
  "retained failure",
);

console.log("provider refresh incremental view checks passed");
