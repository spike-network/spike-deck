import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  CONTROL_API_VERSION,
  CONTROL_API_VERSION_HEADER,
  validateControlApiInfo
} from '../lib/control-api-contract.js';

const fixtureUrl = new URL('./fixtures/control-api-v1.json', import.meta.url);
const coreFixtureUrl = process.env.SPIKE_CORE_DIR
  ? pathToFileURL(`${process.env.SPIKE_CORE_DIR}/tests/fixtures/control-api-v1.json`)
  : new URL('../../spike-core/tests/fixtures/control-api-v1.json', import.meta.url);

test('fixture matches the Core-owned contract', { skip: !existsSync(coreFixtureUrl) && 'spike-core checkout not found; set SPIKE_CORE_DIR' }, async () => {
  assert.equal(await readFile(fixtureUrl, 'utf8'), await readFile(coreFixtureUrl, 'utf8'));
});

test('accepts the native Control API v1 fixture', async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  assert.deepEqual(validateControlApiInfo(fixture), fixture);
  assert.equal(CONTROL_API_VERSION, 1);
  assert.equal(CONTROL_API_VERSION_HEADER, 'Spike-Control-Api-Version');
});

test('rejects an incomplete feature inventory', async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  delete fixture.features.connection_decision_trace;
  assert.throws(() => validateControlApiInfo(fixture), /connection_decision_trace/u);
});
