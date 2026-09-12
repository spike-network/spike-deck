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

const target = { host: "www.example.test", port: 443, protocol: "TCP" };
const nativeRoute = {
  schema_version: 1,
  ok: true,
  revision: 7,
  context: target,
  matched_rule: { id: "DOMAIN-SUFFIX#4", kind: "DOMAIN-SUFFIX", index: 4, value: "example.test" },
  rule_policy: "Proxy",
  resolution: {
    policy_chain: ["Proxy", "Edge"],
    groups: [{ name: "Proxy", kind: "select", selected: "Edge", stage: "policy", basis: "manual" }],
    underlying_chain: [],
    final_node: "Edge",
    outbound_type: "shadowsocks",
  },
};
const summary = summarizeCurrentSite(
  target,
  nativeRoute,
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
assert.equal(summary.resolutionError, null);
const summarize = (route) => summarizeCurrentSite(target, route, {});
for (const action of ["DIRECT", "REJECT"]) {
  const result = summarize({ ...nativeRoute, rule_policy: action, resolution: {
    policy_chain: [action], groups: [], underlying_chain: [], builtin_action: action.toLowerCase(),
  } });
  assert.equal(result.expectedPolicy, action);
  assert.equal(result.resolutionError, null);
}
assert.equal(summarize({ ...nativeRoute, policy_chain: ["Stale"], resolution: {
  ...nativeRoute.resolution, policy_chain: ["Proxy", "Edge", "Transport"], underlying_chain: ["Transport"],
} }).expectedPolicy, "Proxy → Edge → Transport");
assert.equal(summarize({ ...nativeRoute, resolution: { policy_chain: [] } }).expectedPolicy, "Proxy");
const failed = summarize({ ...nativeRoute, ok: false, resolution: {
  policy_chain: ["Proxy"], groups: [], underlying_chain: [], error: "mock resolution failure",
} });
assert.equal(failed.expectedPolicy, "Proxy");
assert.equal(failed.resolutionError, "mock resolution failure");
assert.equal(summarize({ ok: false }).resolutionError, "线路解析失败");
assert.equal(summarize({}).expectedPolicy, "未返回线路");
assert.equal(summarize({ policy_chain: ["Legacy", "Edge"] }).expectedPolicy, "Legacy → Edge");

const html = readFileSync(new URL("../popup.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../popup.css", import.meta.url), "utf8");
const source = readFileSync(new URL("../popup.js", import.meta.url), "utf8");
assert.match(source, /summary\.resolutionError \? "预期（解析失败）："/);
assert.match(source, /el\("span", \{ className: "current-site-warning" \}, summary\.resolutionError\)/);
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
const inspectBinding = source.match(/btnCurrentSiteCheck\.addEventListener\("click", async \(\) => \{[\s\S]*?\n  \}\);/)[0];
for (const route of [nativeRoute, { ...nativeRoute, ok: false, resolution: {
  ...nativeRoute.resolution, error: "mock resolution failure",
} }]) {
  let inspect, rendered;
  const checkButton = { disabled: false, addEventListener: (_, callback) => { inspect = callback; } };
  vm.runInNewContext(inspectBinding, {
    currentSiteOperation: null,
    captureInstanceRequest: () => ({ instance: {}, isCurrent: () => true }),
    btnCurrentSiteCheck: checkButton,
    currentSiteHost: {},
    currentSiteResult: { replaceChildren: (...children) => { rendered = children; } },
    chrome: { tabs: { query: async () => [{ url: "https://www.example.test/" }] } },
    SpikeApiClient: { explainRoute: async () => route, getConnections: async () => ({}) },
    activeTabTarget,
    summarizeCurrentSite,
    el: (tag, attributes, text) => ({ tag, attributes, text }),
  });
  await inspect();
  assert.equal(checkButton.disabled, false);
  assert.ok(rendered.some((node) => node.text === "Proxy → Edge"));
  assert.equal(rendered.some((node) => node.text === "mock resolution failure"), !route.ok);
  assert.equal(rendered[0].text, route.ok ? "预期：" : "预期（解析失败）：");
}
console.log("current site tests passed");
