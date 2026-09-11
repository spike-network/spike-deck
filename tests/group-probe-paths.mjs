import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDirectGroupProbeResult } from "../lib/group-selection.js";

const source = readFileSync(new URL("../popup.js", import.meta.url), "utf8");
const start = source.indexOf("  function ingestPersistedMemberInfo(");
const end = source.indexOf("  function setStatus(", start);
assert.ok(start >= 0 && end > start);
const samples = new Map();
const key = (group, member) => `${group}\0${member}`;
const { recordProbeResults: record, ingestPersistedMemberInfo: ingest } = new Function(
  "leafProbeResults", "probeResultKey", "isDirectGroupProbeResult",
  source.slice(start, end) + "\nreturn {recordProbeResults, ingestPersistedMemberInfo};")(samples, key, isDirectGroupProbeResult);
const direct = { member: "Leaf", paths: [["Outer", "Leaf"]], ok: true, latency_ms: 12, tested_at_unix_ms: 1 };
const nested = { member: "Leaf", paths: [["Outer", "Inner", "Leaf"]], ok: true, latency_ms: 90, tested_at_unix_ms: 2 };
record("Outer", [direct, nested]);
assert.equal(samples.get(key("Outer", "Leaf")).ms, 12);
record("Inner", [nested]);
assert.equal(samples.has(key("Inner", "Leaf")), false);
record("Legacy", [{ member: "Leaf", ok: true, latency_ms: 20 }]);
assert.equal(samples.get(key("Legacy", "Leaf")).ms, 20);
assert.equal(isDirectGroupProbeResult("Outer", { ...direct, paths: [] }), false);
assert.equal(isDirectGroupProbeResult("Outer", { ...direct, paths: null }), false);
assert.equal(isDirectGroupProbeResult("Outer", { ...direct, paths: [null] }), false);
assert.equal(isDirectGroupProbeResult("Outer", { ...direct, paths: [...nested.paths, ...direct.paths] }), true);
console.log("group probe path projection passed");

const info = { name: "Leaf", type: "socks5", udp: true };
const group = { name: "Outer", members: ["Leaf"] };
const history = { ...direct, latency_ms: 99, tested_at_unix_ms: 100 };
ingest([{ ...group, member_info: [info] }]);
assert.equal(samples.get(key("Outer", "Leaf")).ms, null);
assert.equal(samples.get(key("Outer", "Leaf")).ok, undefined);
record("Outer", [history]);
assert.equal(samples.get(key("Outer", "Leaf")).ms, null, "historical tasks cannot restore absent health");
ingest([{ ...group, member_info: [{ ...info, last_test_ok: true, last_test_ms: 31, last_test_at_unix_ms: 20 }] }]);
record("Outer", [history]);
assert.equal(samples.get(key("Outer", "Leaf")).ms, 31);
ingest([{ ...group, member_info: [{ ...info, last_test_ok: null, last_test_ms: null, last_udp_test_ok: true, last_udp_test_ms: 7 }] }]);
assert.equal(samples.get(key("Outer", "Leaf")).ok, null);
assert.equal(samples.get(key("Outer", "Leaf")).udpMs, 7);
assert.equal(samples.has(key("Legacy", "Leaf")), false, "removed groups leave the cache");
ingest([group]);
record("Outer", [history]);
assert.equal(samples.get(key("Outer", "Leaf")).ms, 99, "metadata-free legacy snapshots keep task fallback");
ingest([{ ...group, members: [] }]);
assert.equal(samples.size, 0, "removed members leave the cache");
console.log("authoritative group health invalidation and legacy fallback passed");
