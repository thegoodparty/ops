import assert from "node:assert/strict";
import { test } from "node:test";

import { patchShipPr } from "./sandbox";

test("ship-pr in the sandbox names the sandbox and the reviewer the harness posts as", () => {
  const patched = patchShipPr("gh api repos/thegoodparty/omni/pulls/1/reviews | select(.user.login==\"delegate-reviewer[bot]\")");
  assert.equal(patched, "gh api repos/thegoodparty/bugboss-eval-sandbox/pulls/1/reviews | select(.user.login==\"bugboss-gp[bot]\")");
});
