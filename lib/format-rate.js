/**
 * Shared process-traffic formatting for popup and toolbar badge.
 * Uses 1024-based units so UI and badge stay on the same scale.
 */

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

export function formatByteCount(bytes) {
  const value = Number.isFinite(bytes) ? Math.max(0, Number(bytes)) : 0;
  if (value < KIB) return `${Math.round(value)} B`;
  if (value < MIB) return `${(value / KIB).toFixed(1)} KB`;
  if (value < GIB) return `${(value / MIB).toFixed(1)} MB`;
  return `${(value / GIB).toFixed(1)} GB`;
}

export function formatRate(bytesPerSecond) {
  return `${formatByteCount(bytesPerSecond)}/s`;
}

/** Compact toolbar badge text. Chrome shows about four characters. */
export function formatBadgeRate(bytesPerSecond) {
  const value = Number.isFinite(bytesPerSecond) ? Math.max(0, Number(bytesPerSecond)) : 0;
  if (value < KIB) return String(Math.round(value));
  if (value < MIB) {
    const kib = value / KIB;
    return kib >= 10 ? `${Math.round(kib)}K` : `${kib.toFixed(1)}K`;
  }
  const mib = value / MIB;
  return mib >= 10 ? `${Math.round(mib)}M` : `${mib.toFixed(1)}M`;
}

export function trafficTitle(traffic) {
  const down = formatRate(traffic?.download_bytes_per_second);
  const up = formatRate(traffic?.upload_bytes_per_second);
  return `↓ ${down}  ↑ ${up}`;
}
