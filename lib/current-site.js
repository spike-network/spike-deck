function normalizeHost(value) {
  return String(value || "").trim().replace(/\.$/, "").toLowerCase();
}

export function activeTabTarget(tab) {
  try {
    const url = new URL(tab?.url || "");
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return {
      host: normalizeHost(url.hostname),
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      protocol: "TCP",
    };
  } catch {
    return null;
  }
}

function connectionMatches(row, target) {
  return normalizeHost(row?.host) === target.host &&
    (!row?.port || Number(row.port) === target.port);
}

function compactPolicy(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(" → ");
  if (value && typeof value === "object") {
    return compactPolicy(value.chain || value.policy_chain || value.policy || value.name);
  }
  return String(value || "").trim();
}

function routePolicy(route) {
  return compactPolicy(
    route?.policy_chain ||
      route?.chain ||
      route?.policy ||
      route?.selected_policy ||
      route?.decision_trace,
  ) || "未返回线路";
}

function routeRule(route) {
  const rule = route?.matched_rule || route?.rule;
  if (typeof rule === "string") return rule;
  return String(rule?.id || rule?.raw || rule?.type || "未匹配");
}

export function summarizeCurrentSite(target, route, connections) {
  const live = Array.isArray(connections?.live) ? connections.live : [];
  const recent = Array.isArray(connections?.recent) ? connections.recent : [];
  const matching = [...live, ...recent].filter((row) => connectionMatches(row, target));
  const policies = Array.from(new Set(matching.map((row) =>
    compactPolicy(row?.decision_trace) || compactPolicy(row?.policy),
  ).filter(Boolean)));
  return {
    expectedPolicy: routePolicy(route),
    rule: routeRule(route),
    actualPolicy: policies.length ? policies.join(" / ") : "暂无匹配连接",
    connectionCount: matching.length,
    reused: live.some((row) => connectionMatches(row, target)),
  };
}
