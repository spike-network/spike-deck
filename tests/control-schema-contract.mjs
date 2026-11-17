import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  GROUP_TEST_STATUSES,
  GROUP_TEST_TERMINAL_STATUSES,
  MODULE_UPDATE_STATUSES,
  OUTBOUND_MODES,
  PROVIDER_AVAILABILITIES,
  PROVIDER_FRESHNESS,
  PROVIDER_REFRESH_ITEM_STATUSES,
  PROVIDER_REFRESH_STATES,
  PROVIDER_REFRESH_TASK_STATUSES,
  READINESS_STATES,
  THROUGHPUT_TEST_STATUSES,
  THROUGHPUT_TEST_TERMINAL_STATUSES,
  validateControlApiInfo
} from '../lib/control-api-contract.js';
import { SpikeApiClient } from '../lib/spike-client.js';
import { routeContext } from '../lib/route-context.js';
import { activeTabTarget } from '../lib/current-site.js';
import { ThroughputSession } from '../lib/throughput.js';

// Contract tests against the Core-owned JSON Schema for the control API.
// They check what the extension sends (request bodies built by the real
// client code) and what it relies on in responses (enums it branches on,
// fields it reads, fields its validators require). An incompatible schema
// change fails here with the type and field named.

const coreDir = process.env.SPIKE_CORE_DIR
  ? pathToFileURL(`${process.env.SPIKE_CORE_DIR.replace(/\/+$/u, '')}/`)
  : new URL('../../spike-core/', import.meta.url);
const schemaUrl = new URL('crates/spike-control-types/control-types.schema.json', coreDir);
const fixtureUrl = new URL('./fixtures/control-api-v1.json', import.meta.url);
const skip = !existsSync(schemaUrl) && 'spike-core checkout not found; set SPIKE_CORE_DIR';
const schema = skip ? { $defs: {} } : JSON.parse(readFileSync(schemaUrl, 'utf8'));
const defs = schema.$defs;

// ---------------------------------------------------------------------------
// A small JSON Schema subset validator covering the keywords schemars emits.
// Unknown keywords are an error so a new schema construct is noticed rather
// than silently accepted.

const ANNOTATIONS = new Set(['description', 'title', 'default', 'format', '$schema']);
const ASSERTIONS = new Set([
  '$ref', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties',
  'items', 'prefixItems', 'minItems', 'maxItems', 'anyOf', 'oneOf', 'minimum', 'maximum'
]);

function resolveRef(ref) {
  const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/u.exec(ref);
  if (!match || !(match[1] in defs)) throw new Error(`unresolvable schema reference ${ref}`);
  return defs[match[1]];
}

function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(expected, value) {
  const actual = jsonType(value);
  return actual === expected || (expected === 'number' && actual === 'integer');
}

/**
 * @param {object|boolean} node schema node
 * @param {unknown} value instance
 * @param {string} at JSON pointer-ish path for messages
 * @param {{strict?: boolean}} options strict: reject properties the schema does not declare
 */
function validate(node, value, at = '$', options = {}) {
  if (node === true) return [];
  if (node === false) return [`${at}: no value is allowed`];
  const errors = [];
  for (const keyword of Object.keys(node)) {
    if (!ANNOTATIONS.has(keyword) && !ASSERTIONS.has(keyword)) {
      errors.push(`${at}: unsupported schema keyword "${keyword}"`);
    }
  }
  if (node.$ref) errors.push(...validate(resolveRef(node.$ref), value, at, options));
  if (node.type !== undefined) {
    const types = [node.type].flat();
    if (!types.some((type) => typeMatches(type, value))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${jsonType(value)}`);
      return errors;
    }
  }
  if (node.enum && !node.enum.some((item) => item === value)) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(node.enum)}`);
  }
  if ('const' in node && node.const !== value) {
    errors.push(`${at}: expected ${JSON.stringify(node.const)}`);
  }
  if (typeof value === 'number') {
    if (node.minimum !== undefined && value < node.minimum) errors.push(`${at}: below minimum ${node.minimum}`);
    if (node.maximum !== undefined && value > node.maximum) errors.push(`${at}: above maximum ${node.maximum}`);
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) errors.push(`${at}: fewer than ${node.minItems} items`);
    if (node.maxItems !== undefined && value.length > node.maxItems) errors.push(`${at}: more than ${node.maxItems} items`);
    value.forEach((item, index) => {
      const itemSchema = node.prefixItems?.[index] ?? node.items;
      if (itemSchema !== undefined) errors.push(...validate(itemSchema, item, `${at}[${index}]`, options));
    });
  }
  if (jsonType(value) === 'object' && (node.properties || node.required || node.additionalProperties !== undefined)) {
    for (const name of node.required || []) {
      if (!(name in value)) errors.push(`${at}: missing required property "${name}"`);
    }
    for (const [name, item] of Object.entries(value)) {
      const declared = node.properties?.[name];
      if (declared !== undefined) {
        errors.push(...validate(declared, item, `${at}.${name}`, options));
      } else if (node.additionalProperties === false || (options.strict && node.additionalProperties === undefined)) {
        errors.push(`${at}: property "${name}" is not declared by the schema`);
      } else if (node.additionalProperties && node.additionalProperties !== true) {
        errors.push(...validate(node.additionalProperties, item, `${at}.${name}`, options));
      }
    }
  }
  for (const keyword of ['anyOf', 'oneOf']) {
    if (!node[keyword]) continue;
    const passing = node[keyword].filter((branch) => validate(branch, value, at, options).length === 0).length;
    if (passing === 0 || (keyword === 'oneOf' && passing > 1)) {
      errors.push(`${at}: ${passing} of ${node[keyword].length} ${keyword} branches match`);
    }
  }
  return errors;
}

function assertValid(defName, value, options = {}) {
  assert.ok(defName in defs, `schema no longer defines ${defName}`);
  const errors = validate(defs[defName], value, defName, options);
  assert.deepEqual(errors, [], `${defName} rejects ${JSON.stringify(value)}:\n${errors.join('\n')}`);
}

// Resolve `a.b[].c` through $ref, nullable anyOf and arrays to the schema
// types a field can have. Returns null when the path does not exist.
function fieldTypes(defName, path) {
  let nodes = [defs[defName]];
  for (const segment of path.split('.')) {
    const name = segment.replace(/\[\]$/u, '');
    nodes = expand(nodes).flatMap((node) => {
      const property = node.properties?.[name];
      return property === undefined ? [] : [property];
    });
    if (segment.endsWith('[]')) {
      nodes = expand(nodes).flatMap((node) => (node.items === undefined ? [] : [node.items]));
    }
    if (nodes.length === 0) return null;
  }
  return new Set(expand(nodes).flatMap((node) => (node === true ? ['any'] : [node.type ?? (node.enum ? 'string' : 'any')].flat())));
}

function expand(nodes) {
  return nodes.flatMap((node) => {
    if (node === true) return [true];
    if (!node || typeof node !== 'object') return [];
    if (node.$ref) return expand([resolveRef(node.$ref)]);
    if (node.anyOf || node.oneOf) return expand(node.anyOf || node.oneOf);
    return [node];
  });
}

function enumOf(defName) {
  const values = expand([defs[defName]]).flatMap((node) => node.enum ?? []);
  assert.ok(values.length > 0, `schema type ${defName} is no longer an enum`);
  return [...values].sort();
}

// ---------------------------------------------------------------------------
// Capture request bodies produced by the real client code.

const instance = { id: 'mock', baseUrl: 'http://127.0.0.1:19090', secret: 'mock-secret' };

async function capture(call) {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({
      url: String(url),
      method: init.method || 'GET',
      body: init.body === undefined ? undefined : JSON.parse(init.body)
    });
    return { ok: true, status: 200, headers: new Map(), json: async () => ({}) };
  };
  try {
    await call();
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(requests.length, 1, 'expected exactly one request');
  return requests[0];
}

const REQUESTS = [
  ['ControlOutboundRequest', 'PUT', '/spike/outbound', () => SpikeApiClient.setOutbound(instance, 'rule')],
  ['ControlOutboundRequest', 'PUT', '/spike/outbound', () => SpikeApiClient.setOutbound(instance, 'direct')],
  ['ControlOutboundRequest', 'PUT', '/spike/outbound', () => SpikeApiClient.setOutbound(instance, 'global', 'Proxy')],
  ['ControlPolicyAvoidanceRequest', 'POST', '/spike/policies/avoided', () => SpikeApiClient.setPolicyAvoidance(instance, 'Node A', true)],
  ['ControlPolicyAvoidanceRequest', 'POST', '/spike/policies/avoided', () => SpikeApiClient.setPolicyAvoidance(instance, 'Node A', false)],
  ['ControlProviderRefreshRequest', 'POST', '/spike/provider-refreshes', () => SpikeApiClient.startProviderRefreshTask(instance)],
  ['ControlProviderRefreshRequest', 'POST', '/spike/provider-refreshes', () => SpikeApiClient.startProviderRefreshTask(instance, 'rules-a')],
  ['ControlProviderRefreshRequest', 'POST', '/spike/provider-refreshes', () => SpikeApiClient.startProviderRefreshTask(instance, ['rules-a', 'rules-b'])],
  ['ControlProviderRefreshRequest', 'POST', '/spike/providers/refresh', () => SpikeApiClient.refreshProviders(instance, 'rules-a')],
  ['ControlModuleUpdateRequest', 'POST', '/spike/module-updates', () =>
    SpikeApiClient.startModuleUpdateTask(instance, { id: 'task-1', taskNamespace: 'ns-1' }, { enable: ['Example'] })],
  ['ControlRouteExplainRequest', 'POST', '/spike/rules/explain', () => SpikeApiClient.explainRoute(instance, routeContext({
    host: 'www.example.test', port: '443', protocol: 'tcp', source_ip: '192.0.2.10', source_port: '50000',
    in_port: '6152', destination_ip: '198.51.100.20', url: 'https://www.example.test/a', user_agent: 'mock-agent',
    process_name: 'mock', process_path: '/usr/bin/mock', process_cgroup: 'mock.slice'
  }))],
  ['ControlRouteExplainRequest', 'POST', '/spike/rules/explain', () => SpikeApiClient.explainRoute(instance, routeContext({
    host: 'www.example.test', port: '80'
  }))],
  ['ControlRouteExplainRequest', 'POST', '/spike/rules/explain', () =>
    SpikeApiClient.explainRoute(instance, activeTabTarget({ url: 'https://www.example.test:8443/path' }))]
];

test('request bodies match the Core request types', { skip }, async () => {
  for (const [defName, method, path, call] of REQUESTS) {
    const request = await capture(call);
    assert.equal(request.method, method, `${defName}: method`);
    assert.equal(new URL(request.url).pathname, path, `${defName}: path`);
    // No body is a valid request for refreshes; Core treats it as an empty object.
    assertValid(defName, request.body ?? {}, { strict: true });
  }
});

test('throughput start body matches the Core request type', { skip }, async () => {
  let body;
  const session = new ThroughputSession({
    start: async (value) => { body = value; throw Object.assign(new Error('stop'), { status: 400 }); }
  }, () => {});
  session.namespace = 'ns-1';
  for (const direction of ['download', 'upload']) {
    await session.start(direction, 'DIRECT');
    assertValid('ControlThroughputTestRequest', body, { strict: true });
  }
});

test('the validator rejects incompatible values', { skip }, () => {
  assert.notDeepEqual(validate(defs.ControlOutboundRequest, { mode: 'turbo' }), []);
  assert.notDeepEqual(validate(defs.ControlOutboundRequest, { policy: 'Proxy' }), []);
  assert.notDeepEqual(validate(defs.ControlRouteExplainRequest, { host: 'a', port: 70000, protocol: 'TCP' }), []);
  assert.notDeepEqual(validate(defs.ControlPolicyAvoidanceRequest, { action: 'add', extra: 1 }), []);
  assert.notDeepEqual(validate(defs.ControlProviderRefreshRequest, { provider: 'a' }, '$', { strict: true }), []);
  assert.deepEqual(validate({ type: 'string', pattern: 'x' }, 'x').length, 1);
});

// Enums the extension branches on must equal the schema's, so a new status
// is a test failure and not a silent fall-through.
const ENUMS = [
  ['ControlReadinessStatus', READINESS_STATES],
  ['OutboundMode', OUTBOUND_MODES],
  ['ControlGroupTestTaskStatus', GROUP_TEST_STATUSES],
  ['ControlThroughputTestStatus', THROUGHPUT_TEST_STATUSES],
  ['ControlProviderRefreshTaskStatus', PROVIDER_REFRESH_TASK_STATUSES],
  ['ControlProviderRefreshItemStatus', PROVIDER_REFRESH_ITEM_STATUSES],
  ['ControlProviderRefreshState', PROVIDER_REFRESH_STATES],
  ['ControlProviderAvailability', PROVIDER_AVAILABILITIES],
  ['ControlProviderFreshness', PROVIDER_FRESHNESS],
  ['ControlModuleUpdateStatus', MODULE_UPDATE_STATUSES]
];

test('enums the extension branches on match the schema', { skip }, () => {
  for (const [defName, known] of ENUMS) {
    assert.deepEqual(enumOf(defName), [...known].sort(), `${defName} values changed in the schema`);
  }
  for (const status of GROUP_TEST_TERMINAL_STATUSES) assert.ok(GROUP_TEST_STATUSES.includes(status));
  for (const status of THROUGHPUT_TEST_TERMINAL_STATUSES) assert.ok(THROUGHPUT_TEST_STATUSES.includes(status));
  assert.deepEqual(fieldTypes('ControlGroupTestTask', 'status'), new Set(['string']));
  assert.ok(String(defs.ControlGroupTestTask.properties.status.$ref).endsWith('/ControlGroupTestTaskStatus'));
  assert.ok(String(defs.ControlThroughputTestTask.properties.status.$ref).endsWith('/ControlThroughputTestStatus'));
  assert.ok(String(defs.ControlProviderRefreshTask.properties.status.$ref).endsWith('/ControlProviderRefreshTaskStatus'));
  assert.ok(String(defs.ControlModuleUpdateTask.properties.status.$ref).endsWith('/ControlModuleUpdateStatus'));
  assert.ok(String(defs.ControlProvider.properties.refresh_state.$ref).endsWith('/ControlProviderRefreshState'));
});

// Fields the extension reads, with the JSON type it treats them as. The
// list follows the code paths: badge and health (metrics, status), popup
// (groups, providers, outbound, tasks), tools page (logs, events,
// connections, throughput, route explanation).
const READS = {
  ControlStatusPayload: {
    profile: 'string', loaded_at_unix: 'integer', groups: 'integer', leaves: 'integer', rules: 'integer',
    revision: 'integer', 'listeners[].kind': 'string', 'listeners[].address': 'string',
    'provider_refresh.refreshing': 'boolean', 'provider_refresh.last_attempt_unix': 'integer',
    'provider_refresh.last_result': 'string', 'provider_refresh.last_success_unix': 'integer'
  },
  ControlMetrics: {
    'traffic.upload_bytes_per_second': 'integer', 'traffic.download_bytes_per_second': 'integer',
    'traffic.upload_bytes_total': 'integer', 'traffic.download_bytes_total': 'integer',
    'traffic.sampled_at_unix_ms': 'integer', 'session_pools[].name': 'string',
    'session_pools[].failures_total': 'integer', 'session_pools[].last_failure': 'string'
  },
  ControlReadiness: {
    schema_version: 'integer', ok: 'boolean', status: 'string', 'checks[].name': 'string',
    'checks[].status': 'string', 'checks[].reason': 'string', 'checks[].expected': 'integer', 'checks[].active': 'integer'
  },
  ControlOutbound: { mode: 'string', global_policy: 'string' },
  ControlGroups: {
    revision: 'integer', 'groups[].name': 'string', 'groups[].kind': 'string', 'groups[].members[]': 'string',
    'groups[].selected': 'string', 'groups[].hidden': 'boolean', 'groups[].override_member': 'string',
    'groups[].selection_basis': 'string', 'groups[].member_info[].name': 'string',
    'groups[].member_info[].type': 'string', 'groups[].member_info[].udp': 'boolean',
    'groups[].member_info[].avoided': 'boolean', 'groups[].member_info[].last_test_ok': 'boolean',
    'groups[].member_info[].last_test_ms': 'integer'
  },
  ControlGroupSelection: { group: 'string', member: 'string', override_active: 'boolean' },
  ControlPolicies: { 'policies[].name': 'string', 'policies[].type': 'string', 'policies[].udp': 'boolean' },
  ControlProviders: {
    refreshing: 'boolean', 'providers[].id': 'string', 'providers[].type': 'string', 'providers[].source': 'string',
    'providers[].source_kind': 'string', 'providers[].group': 'string', 'providers[].status': 'string',
    'providers[].availability': 'string', 'providers[].freshness': 'string', 'providers[].refreshing': 'boolean',
    'providers[].refresh_state': 'string', 'providers[].last_refresh_error': 'string',
    'providers[].last_successful_activation_unix_ms': 'integer', 'providers[].last_updated_unix': 'integer',
    'providers[].update_interval_seconds': 'integer'
  },
  ControlProviderRefreshTask: {
    id: 'integer', task_namespace: 'string', status: 'string', started_at_unix_ms: 'integer',
    completed_at_unix_ms: 'integer', error: 'string', revision: 'integer',
    'provider_results[].provider_id': 'string', 'provider_results[].status': 'string',
    'provider_results[].joined': 'boolean', 'provider_results[].error': 'string'
  },
  ControlProviderRefreshResult: { 'reload.revision': 'integer', 'providers[].availability': 'string' },
  ControlGroupTestTasks: { 'tasks[].id': 'integer', 'active_tasks[].id': 'integer' },
  ControlGroupTestTask: {
    id: 'integer', task_namespace: 'string', update_sequence: 'integer', group: 'string', member: 'string',
    requested_member: 'string', status: 'string', cancel_requested: 'boolean', total: 'integer',
    completed: 'integer', error: 'string', 'results[].member': 'string', 'results[].ok': 'boolean',
    'results[].latency_ms': 'integer', 'results[].error': 'string', 'results[].udp_ok': 'boolean',
    'results[].udp_latency_ms': 'integer', 'results[].udp_error': 'string', 'results[].tested_at_unix_ms': 'integer'
  },
  ControlModuleUpdateTasks: { task_namespace: 'string', 'tasks[].id': 'string' },
  ControlModuleUpdateTask: { schema_version: 'integer', id: 'string', task_namespace: 'string', status: 'string', error: 'string' },
  ControlThroughputTestTasks: { 'tasks[].id': 'integer' },
  ControlThroughputTestTask: {
    id: 'integer', created_at_unix_ms: 'integer', revision: 'integer', policy: 'string', direction: 'string',
    status: 'string', cancel_requested: 'boolean', bytes: 'integer', bytes_per_second: 'integer', byte_limit: 'integer'
  },
  ControlLogs: {
    event_namespace: 'string', next_sequence: 'integer', 'entries[].sequence': 'integer',
    'entries[].event_namespace': 'string', 'entries[].occurred_at_unix_ms': 'integer',
    'entries[].level': 'string', 'entries[].target': 'string', 'entries[].message': 'string', 'entries[].fields': 'object'
  },
  ControlEvents: { event_namespace: 'string', next_sequence: 'integer' },
  ControlConnections: {
    'live[].id': 'integer', 'live[].host': 'string', 'live[].port': 'integer', 'live[].peer': 'string',
    'live[].policy': 'string', 'live[].kind': 'string', 'live[].ok': 'boolean', 'live[].started_unix_ms': 'integer',
    'live[].duration_ms': 'integer', 'live[].protocol': 'string', 'live[].application': 'string',
    'live[].error': 'string', 'live[].end_reason': 'string', 'recent[].id': 'integer', 'recent[].host': 'string'
  },
  ControlRouteExplanation: {
    ok: 'boolean', rule_policy: 'string', 'matched_rule.id': 'string',
    'resolution.policy_chain[]': 'string', 'resolution.error': 'string'
  }
};

test('fields the extension reads exist with the expected types', { skip }, () => {
  const problems = [];
  for (const [defName, fields] of Object.entries(READS)) {
    if (!(defName in defs)) {
      problems.push(`${defName}: type removed from the schema`);
      continue;
    }
    for (const [path, expected] of Object.entries(fields)) {
      const types = fieldTypes(defName, path);
      if (!types) problems.push(`${defName}.${path}: field removed or renamed`);
      else if (!types.has(expected) && !types.has('any')) {
        problems.push(`${defName}.${path}: expected ${expected}, schema has ${[...types].join('|')}`);
      }
    }
  }
  assert.deepEqual(problems, [], `Control schema no longer matches what the extension reads:\n${problems.join('\n')}`);
});

// Fields the extension's own validators reject a response without. If Core
// makes one optional, the extension would start rejecting valid responses.
const VALIDATOR_REQUIRES = {
  ControlApiInfo: ['schema_version', 'ok', 'api_version', 'minimum_supported_api_version', 'features'],
  ControlReadiness: ['schema_version', 'ok', 'status', 'checks'],
  ControlReadinessCheck: ['name', 'status', 'reason'],
  ControlModuleUpdateTask: ['schema_version', 'id', 'task_namespace', 'status'],
  ControlThroughputTestTask: ['id', 'created_at_unix_ms', 'status'],
  ControlProviderRefreshItem: ['provider_id', 'status']
};

test('fields the extension validators require stay required', { skip }, () => {
  for (const [defName, fields] of Object.entries(VALIDATOR_REQUIRES)) {
    const required = new Set(defs[defName]?.required || []);
    const missing = fields.filter((field) => !required.has(field));
    assert.deepEqual(missing, [], `${defName} no longer requires ${missing.join(', ')}`);
  }
});

test('response validators accept schema-conformant payloads', { skip }, async () => {
  const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
  assertValid('ControlApiInfo', fixture);
  assert.deepEqual(validateControlApiInfo(structuredClone(fixture)), fixture);

  const previousFetch = globalThis.fetch;
  try {
    for (const status of enumOf('ControlReadinessStatus')) {
      const report = {
        schema_version: 1,
        ok: status !== 'not_ready',
        status,
        revision: 3,
        checks: [{ name: 'listeners', status, reason: 'mock_reason', expected: 2, active: status === 'not_ready' ? 0 : 2 }]
      };
      assertValid('ControlReadiness', report);
      globalThis.fetch = async () => ({
        ok: status !== 'not_ready', status: status === 'not_ready' ? 503 : 200, headers: new Map(), json: async () => report
      });
      assert.deepEqual(await SpikeApiClient.getReadiness(instance), report, `readiness ${status}`);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});
