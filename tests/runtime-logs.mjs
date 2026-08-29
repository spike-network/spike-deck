import assert from "node:assert/strict";

import {
  formatRuntimeLogEntry,
  formatRuntimeLogs,
} from "../lib/runtime-logs.js";

const entry = {
  occurred_at_unix_ms: 0,
  level: "debug",
  target: "runtime::group",
  message: "selected\nmember",
  fields: { z: true, a: "Node A" },
};

assert.equal(
  formatRuntimeLogEntry(entry),
  "1970-01-01T00:00:00.000Z DEBUG runtime::group: selected member a=Node A z=true",
);
assert.equal(formatRuntimeLogs([entry, entry]).split("\n").length, 2);
assert.equal(formatRuntimeLogs(null), "");

console.log("runtime log tests passed");
