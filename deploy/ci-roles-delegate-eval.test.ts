import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  githubActionsDelegateEvalTrust,
  githubActionsDelegateEval,
} from "./components/ci-roles/policies";

const SUBJECT_KEY = "token.actions.githubusercontent.com:sub";
const WORKFLOW_KEY = "token.actions.githubusercontent.com:job_workflow_ref";

describe("githubActionsDelegateEvalTrust", () => {
  it("has exactly one statement", () => {
    assert.equal(githubActionsDelegateEvalTrust.Statement.length, 1);
  });

  it("is pinned to ops main", () => {
    const [statement] = githubActionsDelegateEvalTrust.Statement;
    assert.equal(
      statement.Condition.StringEquals?.[SUBJECT_KEY],
      "repo:thegoodparty/ops:ref:refs/heads/main",
    );
  });

  it("is pinned to delegate-eval.yml workflow file", () => {
    const [statement] = githubActionsDelegateEvalTrust.Statement;
    assert.equal(
      statement.Condition.StringEquals?.[WORKFLOW_KEY],
      "thegoodparty/ops/.github/workflows/delegate-eval.yml@refs/heads/main",
    );
  });

  it("requires the sts audience", () => {
    const [statement] = githubActionsDelegateEvalTrust.Statement;
    assert.equal(
      statement.Condition.StringEquals?.["token.actions.githubusercontent.com:aud"],
      "sts.amazonaws.com",
    );
  });

  it("uses no wildcard subject", () => {
    const [statement] = githubActionsDelegateEvalTrust.Statement;
    const sub = statement.Condition.StringEquals?.[SUBJECT_KEY];
    assert.equal(typeof sub === "string" && sub.includes("*"), false);
  });
});

describe("githubActionsDelegateEval", () => {
  const actions = () =>
    githubActionsDelegateEval.Statement.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    ).filter((a): a is string => typeof a === "string");

  const resources = () =>
    githubActionsDelegateEval.Statement.flatMap((s) =>
      Array.isArray(s.Resource) ? s.Resource : [s.Resource as string],
    ).filter((r): r is string => typeof r === "string");

  it("allows only S3 read and list actions", () => {
    const allowed = new Set(["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket"]);
    for (const action of actions()) {
      assert.ok(allowed.has(action), `unexpected action: ${action}`);
    }
  });

  it("scopes object reads to the delegate-reviews bucket objects", () => {
    const objectStatement = githubActionsDelegateEval.Statement.find(
      (s) =>
        (Array.isArray(s.Action) ? s.Action : [s.Action]).includes("s3:GetObject") &&
        s.Effect === "Allow",
    );
    assert.ok(objectStatement, "missing GetObject statement");
    const resource = objectStatement.Resource;
    assert.equal(resource, "arn:aws:s3:::delegate-reviews/*");
  });

  it("scopes list to the delegate-reviews bucket itself", () => {
    const listStatement = githubActionsDelegateEval.Statement.find(
      (s) =>
        (Array.isArray(s.Action) ? s.Action : [s.Action]).includes("s3:ListBucket") &&
        s.Effect === "Allow",
    );
    assert.ok(listStatement, "missing ListBucket statement");
    const resource = listStatement.Resource;
    assert.equal(resource, "arn:aws:s3:::delegate-reviews");
  });

  it("grants no IAM, no EC2, no Secrets, and no other AWS service", () => {
    for (const action of actions()) {
      assert.match(action, /^s3:/, `unexpected service in action: ${action}`);
    }
  });

  it("touches no resources outside the delegate-reviews bucket", () => {
    for (const resource of resources()) {
      assert.ok(
        resource.includes("delegate-reviews"),
        `resource outside delegate-reviews: ${resource}`,
      );
    }
  });
});
