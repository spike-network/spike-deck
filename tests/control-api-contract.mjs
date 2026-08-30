import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CONTROL_API_VERSION,
  CONTROL_API_VERSION_HEADER,
  validateControlApiInfo
} from '../lib/control-api-contract.js';

const fixtureUrl = new URL('./fixtures/control-api-v1.json', import.meta.url);

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
