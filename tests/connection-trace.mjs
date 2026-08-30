import assert from 'node:assert/strict';
import test from 'node:test';
import { formatConnectionTrace } from '../lib/connection-trace.js';

test('formats rule, DNS, selected route, and underlying route', () => {
  assert.equal(
    formatConnectionTrace({
      rule: 'FINAL#3',
      dns: { mode: 'resolved', addresses: ['203.0.113.7'] },
      route: {
        policy_chain: ['Proxy', 'Exit', 'Relay', 'Hop'],
        underlying_chain: ['Relay', 'Hop']
      }
    }),
    'FINAL#3 · DNS resolved (203.0.113.7) · Proxy → Exit → Relay → Hop · underlying Relay → Hop'
  );
});

test('keeps older connection payloads readable', () => {
  assert.equal(formatConnectionTrace(undefined), '—');
});
