function singleLine(value, fallback = "") {
  const text = String(value ?? fallback);
  return text.replace(/[\r\n\t]+/g, " ").trim();
}

function fieldValue(value) {
  if (typeof value === "string") return singleLine(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatRuntimeLogEntry(entry) {
  const timestamp = Number(entry?.occurred_at_unix_ms);
  const occurredAt = Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : "unknown-time";
  const level = singleLine(entry?.level, "INFO").toUpperCase().padEnd(5);
  const target = singleLine(entry?.target);
  const message = singleLine(entry?.message);
  const fields =
    entry?.fields && typeof entry.fields === "object" && !Array.isArray(entry.fields)
      ? Object.keys(entry.fields)
          .sort()
          .map((key) => `${key}=${fieldValue(entry.fields[key])}`)
          .join(" ")
      : "";
  const source = target ? `${target}: ` : "";
  const suffix = fields ? ` ${fields}` : "";
  return `${occurredAt} ${level} ${source}${message}${suffix}`.trimEnd();
}

export function formatRuntimeLogs(entries) {
  return Array.isArray(entries)
    ? entries.map(formatRuntimeLogEntry).join("\n")
    : "";
}

export function filterRuntimeLogs(entries, includeKeyword, excludeKeyword = "") {
  const logs = Array.isArray(entries) ? entries : [];
  const includeNeedle = String(includeKeyword ?? "").trim().toLocaleLowerCase();
  const excludeNeedle = String(excludeKeyword ?? "").trim().toLocaleLowerCase();
  if (!includeNeedle && !excludeNeedle) return logs;
  return logs.filter((entry) => {
    const haystack = formatRuntimeLogEntry(entry).toLocaleLowerCase();
    return (
      (!includeNeedle || haystack.includes(includeNeedle)) &&
      (!excludeNeedle || !haystack.includes(excludeNeedle))
    );
  });
}

function runtimeLogTime(entry) {
  const occurredAt = Number(entry?.occurred_at_unix_ms);
  if (Number.isFinite(occurredAt)) return occurredAt;
  const sequence = Number(entry?.sequence);
  return Number.isFinite(sequence) ? sequence : 0;
}

export function sortRuntimeLogs(entries, direction = "asc") {
  const logs = Array.isArray(entries) ? [...entries] : [];
  const multiplier = direction === "desc" ? -1 : 1;
  return logs.sort(
    (left, right) =>
      (runtimeLogTime(left) - runtimeLogTime(right)) * multiplier,
  );
}
