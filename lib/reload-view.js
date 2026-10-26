function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid revision");
  return value;
}
function changes(values, t) {
  if (!Array.isArray(values)) throw new Error("Invalid reload differences");
  return values.map((value) => {
    if (![value.field, value.before, value.after].every((item) => typeof item === "string"))
      throw new Error("Invalid reload difference");
    return { [t("Field")]: value.field, [t("Before")]: value.before, [t("After")]: value.after };
  });
}
export function reloadView(value, preview, t = (value) => value) {
  const label = {
    no_change: "No changes",
    hot_apply: "Hot update",
    restart_required: "Restart required",
    mixed: "Hot update and restart required",
    invalid: "Invalid candidate",
  }[value?.classification];
  if (typeof label !== "string" || (!preview && value.ok !== true))
    throw new Error("Invalid reload result");
  const result = {
    [t("Classification")]: t(label),
    [t(preview ? "Current revision" : "Reloaded revision")]: revision(
      preview ? value.current_revision : value.revision,
    ),
  };
  if (preview && value.candidate_revision != null)
    result[t("Candidate revision")] = revision(value.candidate_revision);
  result[t("Hot update")] = changes(value.hot_applied || [], t);
  result[t("Restart required")] = changes(value.restart_required || [], t);
  if (preview && value.ok !== true)
    result[t("Error")] = t(
      Array.isArray(value.errors) &&
        value.errors.some((issue) => issue.code === "revision_exhausted")
        ? "The revision limit was reached. Restart the engine before reloading."
        : "The candidate profile could not be validated. Check the configuration before reloading.",
    );
  return result;
}
export function reloadStatusView(value, t = (value) => value) {
  const result = { [t("Current revision")]: revision(value?.revision) };
  for (const [key, label] of [
    ["groups", "Policy groups"],
    ["leaves", "Policies"],
    ["rules", "Rules"],
  ]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[t(label)] = value[key];
  }
  return result;
}
