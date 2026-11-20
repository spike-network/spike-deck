export const CONTROL_API_VERSION = 1;
export const CONTROL_API_VERSION_HEADER = 'Spike-Control-Api-Version';

const REQUIRED_FEATURES = [
  'connection_decision_trace',
  'group_test_tasks',
  'operational_event_metadata',
  'provider_refresh_tasks',
  'reload_preview',
  'runtime_event_stream',
  'runtime_log_stream',
  'session_pool_metrics'
];

export function validateControlApiInfo(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.schema_version !== 1 ||
    value.ok !== true ||
    value.api_version !== CONTROL_API_VERSION ||
    value.minimum_supported_api_version !== 1 ||
    !value.features ||
    typeof value.features !== 'object'
  ) {
    throw new Error('unsupported Control API contract');
  }
  for (const feature of REQUIRED_FEATURES) {
    if (!Number.isInteger(value.features[feature]) || value.features[feature] < 1) {
      throw new Error(`missing Control API feature: ${feature}`);
    }
  }
  // Additive capability: older Core versions still use refreshing as a fallback.
  const independent = value.features.provider_refresh_independent;
  if (independent !== undefined && (!Number.isInteger(independent) || independent < 1)) {
    throw new Error('unsupported provider refresh capability');
  }
  const refreshModel = value.features.refresh_model;
  if (refreshModel !== undefined && (!Number.isInteger(refreshModel) || refreshModel < 1)) {
    throw new Error('unsupported refresh model capability');
  }
  return value;
}

/** True when Core advertises summaries, change feeds and the refresh stream. */
export function supportsRefreshModel(info) {
  const flag = info?.features?.refresh_model;
  return Number.isInteger(flag) && flag >= 1;
}

// Wire enums the extension branches on. tests/control-schema-contract.mjs
// checks each against spike-core's control-types.schema.json, so a value Core
// adds or renames fails there instead of falling through a default branch.
export const READINESS_STATES = Object.freeze(['ready', 'degraded', 'not_ready']);
export const OUTBOUND_MODES = Object.freeze(['rule', 'direct', 'global']);
export const GROUP_TEST_STATUSES = Object.freeze(['queued', 'running', 'completed', 'cancelled', 'failed']);
export const GROUP_TEST_TERMINAL_STATUSES = Object.freeze(['completed', 'cancelled', 'failed']);
export const THROUGHPUT_TEST_STATUSES = GROUP_TEST_STATUSES;
export const THROUGHPUT_TEST_TERMINAL_STATUSES = GROUP_TEST_TERMINAL_STATUSES;
export const PROVIDER_REFRESH_TASK_STATUSES = Object.freeze(['running', 'succeeded', 'failed']);
export const PROVIDER_REFRESH_ITEM_STATUSES = Object.freeze(['pending', 'running', 'succeeded', 'failed', 'skipped']);
export const PROVIDER_REFRESH_STATES = Object.freeze(['idle', 'queued', 'downloading', 'activating']);
export const PROVIDER_AVAILABILITIES = Object.freeze(['available', 'missing']);
export const PROVIDER_FRESHNESS = Object.freeze(['fresh', 'stale', 'unmanaged', 'unknown']);
export const MODULE_UPDATE_STATUSES = Object.freeze(['running', 'succeeded', 'failed']);
