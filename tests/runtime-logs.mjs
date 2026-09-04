import assert from "node:assert/strict";

import {
  filterRuntimeLogs,
  formatRuntimeLogEntry,
  formatRuntimeLogs,
  sortRuntimeLogs,
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
assert.deepEqual(filterRuntimeLogs([entry], "RUNTIME"), [entry]);
assert.deepEqual(filterRuntimeLogs([entry], "node a"), [entry]);
assert.deepEqual(filterRuntimeLogs([entry], "missing"), []);
assert.deepEqual(filterRuntimeLogs([entry], "  "), [entry]);
assert.deepEqual(filterRuntimeLogs([entry], "runtime", "node a"), []);
assert.deepEqual(filterRuntimeLogs([entry], "runtime", "missing"), [entry]);
assert.deepEqual(filterRuntimeLogs([entry], "", "DEBUG"), []);

const newerEntry = { ...entry, sequence: 2, occurred_at_unix_ms: 2 };
const olderEntry = { ...entry, sequence: 1, occurred_at_unix_ms: 1 };
assert.deepEqual(sortRuntimeLogs([newerEntry, olderEntry], "asc"), [
  olderEntry,
  newerEntry,
]);
assert.deepEqual(sortRuntimeLogs([olderEntry, newerEntry], "desc"), [
  newerEntry,
  olderEntry,
]);
assert.deepEqual(sortRuntimeLogs(null, "desc"), []);

console.log("runtime log tests passed");
