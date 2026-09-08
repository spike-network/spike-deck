import assert from 'node:assert/strict';
import { badgeTraffic, formatBadgeRate, formatByteCount, formatRate, trafficTitle, formatCompactByteCount } from '../lib/format-rate.js';

assert.equal(formatCompactByteCount(555), '555B');
assert.equal(formatCompactByteCount(1.2 * 1024), '1.2KB');
assert.equal(formatCompactByteCount(164.9 * 1024 ** 2), '165MB');
assert.equal(formatCompactByteCount(99.99 * 1024), '100KB');
assert.equal(formatCompactByteCount(1.2 * 1024 ** 3), '1.2GB');
for (const value of [0, -1, NaN, Infinity, 999.5, 1023, 1024, 99.94 * 1024, 99.99 * 1024, 999.5 * 1024, 1024 ** 4, Number.MAX_VALUE]) {
  assert.ok(formatCompactByteCount(value).length <= 6);
}

assert.equal(formatByteCount(0), '0 B');
assert.equal(formatByteCount(512), '512 B');
assert.equal(formatByteCount(1536), '1.5 KB');
assert.equal(formatByteCount(1024 * 1024), '1.0 MB');
assert.equal(formatRate(1536), '1.5 KB/s');

assert.equal(formatBadgeRate(0), '0');
assert.equal(formatBadgeRate(800), '800');
assert.equal(formatBadgeRate(1536), '1.5K');
assert.equal(formatBadgeRate(12 * 1024), '12K');
assert.equal(formatBadgeRate(1.2 * 1024 * 1024), '1.2M');
assert.equal(formatBadgeRate(12 * 1024 * 1024), '12M');

assert.equal(
  trafficTitle({ download_bytes_per_second: 1536, upload_bytes_per_second: 512 }),
  '↓ 1.5 KB/s  ↑ 512 B/s'
);

// Badge shows the dominant direction; upload wins get a distinct amber color.
assert.deepEqual(badgeTraffic(null), null);
assert.deepEqual(badgeTraffic({}), null);
assert.deepEqual(
  badgeTraffic({ download_bytes_per_second: 0, upload_bytes_per_second: 0 }),
  null
);
assert.deepEqual(
  badgeTraffic({ download_bytes_per_second: 1536, upload_bytes_per_second: 512 }),
  { text: '1.5K', color: '#0f766e' }
);
assert.deepEqual(
  badgeTraffic({ download_bytes_per_second: 1024, upload_bytes_per_second: 2048 }),
  { text: '2.0K', color: '#D97706' }
);
// Tie falls back to download.
assert.deepEqual(
  badgeTraffic({ download_bytes_per_second: 4096, upload_bytes_per_second: 4096 }),
  { text: '4.0K', color: '#0f766e' }
);

console.log('format-rate tests passed');
