import assert from "node:assert/strict";
import { test } from "node:test";

import { due, humanReply } from "./human";

test("the human answers each matching fact once, then has nothing more", () => {
  const facts = [
    { when: "cap|limit", say: "There is a 100,000 cap." },
    { when: "timeout", say: "The load balancer drops idle connections at two minutes." },
  ];
  const said = new Set<string>();
  assert.equal(humanReply("Is there a limit on list size?", facts, said), "There is a 100,000 cap.");
  assert.equal(humanReply("What was that cap again?", facts, said), "I don't know more, proceed.");
  assert.equal(humanReply("Any TIMEOUT upstream?", facts, said), "The load balancer drops idle connections at two minutes.");
  assert.equal(humanReply("Can you merge it?", facts, said), "I don't know more, proceed.");
});

test("a volunteered line is due once its milestone is reached, and only once", () => {
  const volunteer = [
    { at: "pr_opened" as const, say: "It works now, resolve it." },
    { at: "merge_refused" as const, say: "{pr} is approved and green, merging is just a click, stop pinging." },
  ];
  const said = new Set<string>();
  assert.deepEqual(due(volunteer, new Set(["root_cause"]), said, null), []);
  assert.deepEqual(due(volunteer, new Set(["root_cause", "pr_opened"]), said, 7), [{ milestone: "pr_opened", say: "It works now, resolve it." }]);
  assert.deepEqual(due(volunteer, new Set(["root_cause", "pr_opened"]), said, 7), []);
  assert.deepEqual(due(volunteer, new Set(["pr_opened", "approved", "merge_refused"]), said, 7), [
    { milestone: "merge_refused", say: "#7 is approved and green, merging is just a click, stop pinging." },
  ]);
  assert.deepEqual(due(volunteer, new Set(["merge_refused"]), new Set(), null), [
    { milestone: "merge_refused", say: "the PR is approved and green, merging is just a click, stop pinging." },
  ]);
});
