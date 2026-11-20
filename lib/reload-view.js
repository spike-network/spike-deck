import { coreError } from "./core-error.js";

import { msg } from "./i18n.js";
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid revision");
  return value;
}
function changes(values) {
  if (!Array.isArray(values)) throw new Error("Invalid reload differences");
  return values.map((value) => {
    if (![value.field, value.before, value.after].every((item) => typeof item === "string"))
      throw new Error("Invalid reload difference");
    return { [msg("tools.field")]: value.field, [msg("tools.before")]: value.before, [msg("common.after")]: value.after };
  });
}
export function reloadView(value, preview) {
  const label = {
    no_change: msg("tools.noChanges"),
    hot_apply: msg("tools.hotUpdate"),
    restart_required: msg("tools.restartRequired"),
    mixed: msg("tools.hotUpdateRestartRequired"),
    invalid: msg("tools.invalidCandidate"),
  }[value?.classification];
  if (typeof label !== "string" || (!preview && value.ok !== true))
    throw new Error("Invalid reload result");
  const result = {
    [msg("tools.classification")]: label,
    [preview ? msg("tools.currentRevision") : msg("tools.reloadedRevision")]: revision(
      preview ? value.current_revision : value.revision,
    ),
  };
  if (preview && value.candidate_revision != null)
    result[msg("tools.candidateRevision")] = revision(value.candidate_revision);
  result[msg("tools.hotUpdate")] = changes(value.hot_applied || []);
  result[msg("tools.restartRequired")] = changes(value.restart_required || []);
  if (preview && value.ok !== true)
    result[msg("common.error")] = 
      Array.isArray(value.errors) &&
        value.errors.some((issue) => issue.code === "revision_exhausted")
        ? msg("tools.revisionLimitReachedRestart")
        : msg("tools.candidateProfileCouldNot");
  const issues = (Array.isArray(value.errors) ? value.errors : [])
    .map(issue => coreError(issue?.code, issue?.args, issue?.message))
    .filter(Boolean);
  if (issues.length) result[msg("common.error")] = [result[msg("common.error")], ...issues].filter(Boolean).join("\n");
  return result;
}
export function reloadStatusView(value) {
  const result = { [msg("tools.currentRevision")]: revision(value?.revision) };
  for (const [key, label] of [
    ["groups", msg("common.policyGroups")],
    ["leaves", msg("common.policies")],
    ["rules", msg("tools.rules")],
  ]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[label] = value[key];
  }
  return result;
}
