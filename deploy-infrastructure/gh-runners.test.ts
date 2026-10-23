import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  GH_RUNNERS_LOG_GROUP,
  GH_RUNNERS_PROJECT_NAME,
  GH_RUNNERS_RUNS_ON,
  ghRunnersFilterGroups,
  ghRunnersPolicy,
  ghRunnersTrust,
} from "./gh-runners";
import { INFRASTRUCTURE_ACCOUNT_ID } from "../utils/accounts";

const CONNECTION_ARN = `arn:aws:codeconnections:us-west-2:${INFRASTRUCTURE_ACCOUNT_ID}:connection/example`;

describe("gh-runners label", () => {
  it("names the project, so CodeBuild routes the job to it", () => {
    assert.equal(
      GH_RUNNERS_RUNS_ON,
      `codebuild-${GH_RUNNERS_PROJECT_NAME}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
    );
  });

  it("is the label the smoke workflow runs on", () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, "../.github/workflows/gh-runners-smoke.yml"),
      "utf8",
    );
    assert.ok(workflow.includes(`    runs-on: ${GH_RUNNERS_RUNS_ON}\n`));
    assert.doesNotMatch(workflow, /pull_request/);
  });
});

describe("ghRunnersFilterGroups", () => {
  it("is one group: queued workflow jobs from omni and ops", () => {
    assert.equal(ghRunnersFilterGroups.length, 1);
    const [event, repo] = ghRunnersFilterGroups[0].filters;
    assert.deepEqual(event, { type: "EVENT", pattern: "WORKFLOW_JOB_QUEUED" });
    assert.equal(repo.type, "REPOSITORY_NAME");

    const pattern = new RegExp(repo.pattern);
    for (const name of ["omni", "ops", "thegoodparty/omni", "thegoodparty/ops"]) {
      assert.match(name, pattern);
    }
    for (const name of ["gp-api", "omni-fork", "other/omni", "ops-old", "xops"]) {
      assert.doesNotMatch(name, pattern);
    }
  });
});

describe("ghRunnersTrust", () => {
  it("admits CodeBuild in this account only", () => {
    assert.equal(ghRunnersTrust.Statement.length, 1);
    const [statement] = ghRunnersTrust.Statement;
    assert.equal(statement.Principal.Service, "codebuild.amazonaws.com");
    assert.equal(statement.Action, "sts:AssumeRole");
    assert.equal(
      statement.Condition.StringEquals["aws:SourceAccount"],
      INFRASTRUCTURE_ACCOUNT_ID,
    );
  });
});

describe("ghRunnersPolicy", () => {
  it("grants its own logs and the one connection, nothing else", () => {
    const policy = ghRunnersPolicy(CONNECTION_ARN);
    assert.deepEqual(
      policy.Statement.map((s) => s.Sid),
      ["OwnLogs", "GitHubConnection"],
    );

    const [logs, connection] = policy.Statement;
    assert.deepEqual(logs.Action, ["logs:CreateLogStream", "logs:PutLogEvents"]);
    for (const resource of logs.Resource) {
      assert.ok(resource.includes(`:log-group:${GH_RUNNERS_LOG_GROUP}`));
    }

    assert.equal(connection.Resource, CONNECTION_ARN);
    for (const action of connection.Action) {
      assert.ok(action.startsWith("codeconnections:"));
    }

    const json = JSON.stringify(policy);
    assert.ok(!json.includes('"*"'));
    assert.ok(!json.includes("sts:"));
    assert.ok(!json.includes("iam:"));
  });
});
