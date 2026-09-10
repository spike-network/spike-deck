import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  groupMemberAction,
  groupSelectionBasisLabel,
  splitSelectedSummary,
} from "../lib/group-selection.js";

assert.equal(groupSelectionBasisLabel("manual_override"), "手动选择");
assert.equal(groupSelectionBasisLabel("first_available_member"), "首个健康");
assert.equal(groupSelectionBasisLabel("per_connection_preview"), "逐连接选择");
assert.equal(groupSelectionBasisLabel("future_basis"), "");
assert.equal(groupSelectionBasisLabel(), "");
assert.equal(groupMemberAction({ kind: "url-test", selected: "A" }, "A"), "select");
assert.equal(
  groupMemberAction({ kind: "url-test", selected: "A", override_member: "A" }, "A"),
  "auto",
);
assert.equal(
  groupMemberAction({ kind: "url-test", selected: "A", override_member: "A" }, "B"),
  "select",
);
assert.equal(groupMemberAction({ kind: "select", selected: "A" }, "A"), "none");
assert.deepEqual(splitSelectedSummary("🇭🇰 香港高级 IEPL 专线 5"), {
  leading: "🇭🇰 香港高级 IEPL",
  trailing: "专线 5",
});
assert.deepEqual(splitSelectedSummary("🇭🇰 香港 Fusion 14 [Premium]"), {
  leading: "🇭🇰 香港 Fusion",
  trailing: "14 [Premium]",
});
assert.deepEqual(splitSelectedSummary("Router SS"), {
  leading: "Router SS",
  trailing: "",
});

const popup = readFileSync(new URL("../popup.js", import.meta.url), "utf8");
assert.match(popup, /async function refreshGroupsSelectionState\(groupName = null\)/);
assert.match(popup, /paintSelection\(groupCard, group\)/);
assert.match(popup, /await refreshGroupsSelectionState\(groupName\)/);
assert.match(popup, /visibleGroupsStable/);
assert.doesNotMatch(popup, /className: "selection-basis-badge"/);
assert.match(popup, /className: "btn-resume-auto"/);
assert.doesNotMatch(popup, /className: "override-kind-badge"/);
assert.match(
  popup,
  /className: "btn-resume-auto"[\s\S]*?className: "pin-icon"/,
);
assert.match(popup, /groupMemberAction\(currentGroup, member\)/);
assert.match(popup, /className: "pin-icon"/);
assert.doesNotMatch(popup, /el\("span", \{\}, "已固定"\)/);
assert.doesNotMatch(popup, /className: "group-kind-badge"/);
assert.match(popup, /className: "group-name",\s+title: groupType,/);
assert.doesNotMatch(popup, /attachGroupTypeTooltip|group-type-tooltip/);
assert.match(popup, /selectedSummaryChildren\(currentSelected\)/);
assert.match(popup, /selectedSummary\.replaceChildren\(\.\.\.selectedSummaryChildren\(memberName\)\)/);

console.log("group selection tests passed");
