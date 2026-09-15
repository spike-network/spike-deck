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
    completed: results.filter((result) => result.status !== "pending").length,
    failed: results.filter((result) => result.status === "failed").length,
    total: results.length,
  };
}

export function providerTaskDisplayStatus(task, providerId) {
  if (task?.providerId && task.providerId !== providerId) return null;
  const result = providerTaskResult(task, providerId);
  if (!result) return null;
  if (task?.status === "succeeded") return null;
  if (result.status === "failed") return "update_failed";
  if (result.status === "succeeded") return "refresh_succeeded";
  if (result.status === "skipped" && task?.status !== "running") return "skipped";
  if (result.status === "pending" && task?.status === "running") return "refreshing";
  return null;
}

export function providerRefreshError(task, providerId, persistedFailure) {
  if (task?.providerId && task.providerId !== providerId)
    return persistedFailure?.error ? String(persistedFailure.error) : "";
  const result = providerTaskResult(task, providerId);
  if (result?.status === "failed" && result.error) return String(result.error);
  if (result?.status === "succeeded") return "";
  if (task?.status === "running" && result?.status === "pending") return "";
  return persistedFailure?.error ? String(persistedFailure.error) : "";
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
