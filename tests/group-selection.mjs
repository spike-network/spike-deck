import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { groupMemberAction, groupSelectionBasisLabel } from "../lib/group-selection.js";

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

const popup = readFileSync(new URL("../popup.js", import.meta.url), "utf8");
assert.match(popup, /async function refreshGroupsSelectionState\(groupName = null\)/);
assert.match(popup, /paintSelection\(groupCard, group\)/);
assert.match(popup, /await refreshGroupsSelectionState\(groupName\)/);
assert.match(popup, /visibleGroupsStable/);
assert.doesNotMatch(popup, /className: "selection-basis-badge"/);
assert.match(popup, /className: "btn-resume-auto"/);
assert.match(popup, /className: "override-kind-badge"/);
assert.match(popup, /groupMemberAction\(currentGroup, member\)/);
assert.match(popup, /className: "pin-icon"/);
assert.doesNotMatch(popup, /el\("span", \{\}, "已固定"\)/);

console.log("group selection tests passed");
