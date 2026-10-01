import assert from "node:assert/strict";
import { test } from "node:test";

import { humanReply } from "./run";
import { patchShipPr } from "./sandbox";

test("the scripted human gives each matching fact once, and otherwise says proceed", () => {
  const facts = [
    { when: "cap|limit", say: "There is a 100,000 cap." },
    { when: "load balancer|timeout", say: "The load balancer drops idle connections at two minutes." },
  ];
  const said = new Set<string>();
  assert.equal(humanReply("Is there a limit on list size?", facts, said), "There is a 100,000 cap.");
  assert.equal(humanReply("What was that cap again?", facts, said), "I don't know more, proceed.");
  assert.equal(humanReply("Any TIMEOUT upstream?", facts, said), "The load balancer drops idle connections at two minutes.");
  assert.equal(humanReply("Can you merge it?", facts, said), "I don't know more, proceed.");
});

test("ship-pr in the sandbox names the sandbox and the reviewer the harness posts as", () => {
  const patched = patchShipPr("gh api repos/thegoodparty/omni/pulls/1/reviews | select(.user.login==\"delegate-reviewer[bot]\")");
  assert.equal(patched, "gh api repos/thegoodparty/bugboss-eval-sandbox/pulls/1/reviews | select(.user.login==\"bugboss-gp[bot]\")");
});
