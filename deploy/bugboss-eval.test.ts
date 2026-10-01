import assert from "node:assert/strict";
import { test } from "node:test";

import { bugbossEvalPolicy, bugbossEvalTrust, BUGBOSS_EVAL_SUBJECT } from "./components/bugboss-eval";

test("the eval role invokes Bedrock models and nothing else", () => {
  const actions = bugbossEvalPolicy.Statement.flatMap((s) => s.Action);
  assert.deepEqual(actions, ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]);
  for (const resource of bugbossEvalPolicy.Statement.flatMap((s) => s.Resource)) {
    assert.match(resource, /^arn:aws:bedrock:/);
  }
});

test("only the main-only bugboss-eval environment can assume it", () => {
  assert.equal(BUGBOSS_EVAL_SUBJECT, "repo:thegoodparty/ops:ref:refs/heads/main");
  const [statement] = bugbossEvalTrust.Statement;
  assert.equal(statement.Condition.StringEquals["token.actions.githubusercontent.com:sub"], BUGBOSS_EVAL_SUBJECT);
  assert.equal(statement.Condition.StringEquals["token.actions.githubusercontent.com:aud"], "sts.amazonaws.com");
  assert.equal(bugbossEvalTrust.Statement.length, 1);
});
