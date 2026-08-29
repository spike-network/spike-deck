import assert from "node:assert/strict";

import { groupSelectionBasisLabel } from "../lib/group-selection.js";

assert.equal(groupSelectionBasisLabel("manual_override"), "手动选择");
assert.equal(groupSelectionBasisLabel("first_available_member"), "首个健康");
assert.equal(groupSelectionBasisLabel("per_connection_preview"), "逐连接选择");
assert.equal(groupSelectionBasisLabel("future_basis"), "");
assert.equal(groupSelectionBasisLabel(), "");

console.log("group selection tests passed");
