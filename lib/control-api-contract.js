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
  return value;
}
