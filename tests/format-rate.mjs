import assert from 'node:assert/strict';
import { formatBadgeRate, formatByteCount, formatRate, trafficTitle } from '../lib/format-rate.js';

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

console.log('format-rate tests passed');
