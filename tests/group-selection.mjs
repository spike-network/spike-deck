import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { groupSelectionBasisLabel } from "../lib/group-selection.js";

assert.equal(groupSelectionBasisLabel("manual_override"), "手动选择");
assert.equal(groupSelectionBasisLabel("first_available_member"), "首个健康");
assert.equal(groupSelectionBasisLabel("per_connection_preview"), "逐连接选择");
assert.equal(groupSelectionBasisLabel("future_basis"), "");
assert.equal(groupSelectionBasisLabel(), "");

const popup = readFileSync(new URL("../popup.js", import.meta.url), "utf8");
assert.match(popup, /async function refreshGroupsSelectionState\(groupName = null\)/);
assert.match(popup, /paintSelection\(groupCard, group\)/);
assert.match(popup, /await refreshGroupsSelectionState\(groupName\)/);
assert.match(popup, /visibleGroupsStable/);
assert.doesNotMatch(popup, /className: "selection-basis-badge"/);
assert.doesNotMatch(popup, /className: "btn-resume-auto"/);
assert.doesNotMatch(popup, /className: "override-kind-badge"/);
assert.match(popup, /currentGroup\?\.override_member === member/);

console.log("group selection tests passed");
