import assert from "node:assert/strict";
import { activeTabTarget, summarizeCurrentSite } from "../lib/current-site.js";

assert.deepEqual(activeTabTarget({ url: "https://www.example.test/path" }), {
  host: "www.example.test",
  port: 443,
  protocol: "TCP",
});
assert.equal(activeTabTarget({ url: "chrome://extensions" }), null);

const summary = summarizeCurrentSite(
  { host: "www.example.test", port: 443, protocol: "TCP" },
  { policy_chain: ["Proxy", "Edge"], matched_rule: { id: "DOMAIN-SUFFIX#4" } },
  {
    live: [{ host: "www.example.test", port: 443, policy: "Old Edge" }],
    recent: [{ host: "other.example.test", port: 443, policy: "Other" }],
  },
);
assert.equal(summary.expectedPolicy, "Proxy → Edge");
assert.equal(summary.rule, "DOMAIN-SUFFIX#4");
assert.equal(summary.actualPolicy, "Old Edge");
assert.equal(summary.connectionCount, 1);
assert.equal(summary.reused, true);

console.log("current site tests passed");
