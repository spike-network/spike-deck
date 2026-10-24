export function providerTaskResults(task) {
  return Array.isArray(task?.providerResults) ? task.providerResults : [];
}

export function providerTaskResult(task, providerId) {
  return providerTaskResults(task).find((result) => result.providerId === providerId) || null;
}

export function providerTaskProgress(task) {
  const results = task?.providerId
    ? providerTaskResults(task).filter((result) => result.providerId === task.providerId)
    : providerTaskResults(task);
  return {
    completed: results.filter((result) => !["pending", "running"].includes(result.status)).length,
    failed: results.filter((result) => result.status === "failed").length,
    total: results.length,
  };
}

export function summarizeProviderRefreshError(error, maximumLength = 72) {
  const message = String(error || "未知错误").replace(/\s+/g, " ").trim();
  const http = message.match(/\bHTTP\s+\d{3}\b[^;]*/i);
  if (http) return truncate(http[0], maximumLength);
  const timeout = message.match(/timed out after\s+([^:;,]+)/i);
  if (timeout) return `下载超时（${timeout[1].trim()}）`;
  if (/deadline has elapsed/i.test(message)) return "下载超时";
  const causes = message.split(/:\s+/).filter(Boolean);
  return truncate(causes.at(-1) || message, maximumLength);
}

function truncate(value, maximumLength) {
  const text = String(value);
  return text.length <= maximumLength
    ? text
    : `${text.slice(0, Math.max(1, maximumLength - 1)).trimEnd()}…`;
}

// Inventory state is authoritative; task results describe requests, not rows.
export function providerRefreshState(provider) {
  return ["idle", "queued", "downloading", "activating"].includes(provider?.refresh_state)
    ? provider.refresh_state : provider?.refreshing || provider?.status === "refreshing" ? "downloading" : "idle";
}

export function observeProviderActivations(previous, providers, now = Date.now()) {
  const next = new Map();
  for (const provider of providers) {
    const candidate = previous.get(provider.id);
    const old = candidate?.source === provider.source ? candidate : null;
    const state = providerRefreshState(provider);
    const activation = provider.last_successful_activation_unix_ms ?? provider.last_updated_unix;
    const updatedUntil = old && old.state !== "idle" && state === "idle" && !provider.last_refresh_error && activation != null && activation > (old.activation ?? -Infinity)
      ? now + 3000 : old?.updatedUntil || 0;
    next.set(provider.id, { state, activation, updatedUntil, source: provider.source });
  }
  return next;
}
