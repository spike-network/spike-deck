import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
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

const html = readFileSync(new URL("../popup.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../popup.css", import.meta.url), "utf8");
const source = readFileSync(new URL("../popup.js", import.meta.url), "utf8");
assert.match(html, /id="current-site-panel"[^>]*\bhidden\b/);
assert.match(css, /\.current-site-panel\[hidden\]\s*\{\s*display: none;/);
const header = html.split('<div class="header-actions">')[1].split('</header>')[0];
const order = ['id="btn-refresh"', 'id="btn-current-site-toggle"', 'id="btn-refresh-providers"', 'id="btn-modules"', 'href="tools.html"', 'id="btn-embedded-ui"', 'id="btn-options"'];
assert.deepEqual(order.map((marker) => header.indexOf(marker)), order.map((marker) => header.indexOf(marker)).sort((a, b) => a - b));
assert.ok(order.every((marker) => header.includes(marker)));
const panel = { hidden: true };
let toggle, expanded, checks = 0;
const binding = source.match(/btnCurrentSiteToggle\.addEventListener\("click", \(\) => \{[\s\S]*?\n  \}\);/)[0];
vm.runInNewContext(binding, {
  currentSitePanel: panel,
  btnCurrentSiteToggle: {
    addEventListener: (_, callback) => { toggle = callback; },
    setAttribute: (_, value) => { expanded = value; },
  },
  btnCurrentSiteCheck: { click: () => { checks++; } },
});
toggle();
assert.equal(panel.hidden, false);
assert.equal(expanded, "true");
assert.equal(checks, 1);
toggle();
assert.equal(panel.hidden, true);
assert.equal(expanded, "false");
assert.equal(checks, 1);
console.log("current site tests passed");
