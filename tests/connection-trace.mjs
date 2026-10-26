import assert from 'node:assert/strict';
import test from 'node:test';
import { formatConnectionTrace, connectionDetailFields } from '../lib/connection-trace.js';

test('formats rule, DNS, selected route, and underlying route', () => {
  assert.equal(
    formatConnectionTrace({
      rule: 'FINAL#3',
      dns: { mode: 'resolved', addresses: ['192.0.2.7'] },
      route: {
        policy_chain: ['Proxy', 'Exit', 'Relay', 'Hop'],
        underlying_chain: ['Relay', 'Hop']
      }
    }),
    'FINAL#3 · DNS resolved (192.0.2.7) · Proxy → Exit → Relay → Hop · underlying Relay → Hop'
  );
});

test('details retain ordered group decisions, process identity and individual phases', () => {
  const fields = connectionDetailFields({ started_unix_ms: 1700000000000, duration_ms: 600,
    process: {name:'mock-service', pid:0, path:'/mock-bin/mock-service', lookup:'matched'},
    decision_trace:{route:{group_steps:[
      {group:'Mock Outer',selected:'Mock Inner',stage:'selected',manual:true},
      {group:'Mock Inner',selected:'Mock Leaf',stage:'fallback'}]}},
    timeline:[{elapsed_us:0,phase:'rule_dns',duration_us:0,category:'route',message:'mock route'},
      {elapsed_us:1234,phase:'establish',duration_us:1234,category:'connect',message:'mock connected'}]
  });
  const get = label => fields.find(field => field.label === label)?.value;
  assert.equal(get('PID'),'0');
  assert.equal(get('Path'),'/mock-bin/mock-service');
  assert.match(get('Group decisions'),/Mock Outer → Mock Inner.*Pinned\nMock Inner → Mock Leaf/);
  assert.match(get('Phase timings'),/DNS\): 0.0 ms\nEstablishing outbound connection: 1.2 ms/);
  assert.match(get('Event timeline'),/\(\+1234 µs\) \[connect\] mock connected/);
  assert.equal(get('Connection lifetime'),'600 ms');
});

test('legacy rows explicitly distinguish missing phase and event observations', () => {
  const fields = connectionDetailFields({});
  assert.deepEqual(fields, [
    {label:'Phase timings',value:'Phase timings unavailable'},
    {label:'Event timeline',value:'Event timeline unavailable'}
  ]);
});

test('localized phase labels never translate user process or policy names', () => {
  const fields = connectionDetailFields({process:{name:'Active'},
    decision_trace:{route:{group_steps:[{group:'Pinned',selected:'Active',manual:true}]}},
    timeline:[{phase:'active',duration_us:1000,elapsed_us:1000,category:'mock',message:'mock event'}]
  }, value => ({Active:'活动',Pinned:'已固定'})[value] || value);
  assert.equal(fields.find(field => field.label === 'Process').value, 'Active');
  assert.equal(fields.find(field => field.label === 'Group decisions').value, 'Pinned → Active · 已固定');
  assert.equal(fields.find(field => field.label === 'Phase timings').value, '活动: 1.0 ms');
});

test('keeps older connection payloads readable', () => {
  assert.equal(formatConnectionTrace(undefined), '—');
});
