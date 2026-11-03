import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { MANAGEMENT_ACCOUNT_ID } from "../utils/accounts";
import { ENGINEERS_GROUP_ID as CORE_ENGINEERS_GROUP_ID } from "./bifrost/vk-mint-core";
import { VK_READER_SESSION_NAME } from "../deploy/components/bifrost-vk-reader";
import {
  GOVERNANCE_OVERRIDES_FILE,
  ENGINEERS_GROUP_ID,
  VK_READER_ROLE_ARN,
  checkCommittedOverrides,
  checkOverridesAgainstDirectory,
  formatCheckFailure,
  overridesPath,
  resolveMembership,
} from "./scripts/preflight-governance";

/**
 * The apply-time half of step 2's validation: the `Engineers` membership check
 * over the committed overrides document.
 *
 * Everything here runs without AWS. The directory is an object with two
 * methods, which is the shape `vk-mint-core.ts` already uses for
 * `MembershipDirectory`, so the decisions — "a read that fails is not an
 * absence", "an empty group admits nobody", "every problem is reported at
 * once" — are testable in the credential-free job `deploy.yml` runs `npm test`
 * in. Only `createCliDirectory` needs AWS, and it is the part with nothing to
 * decide: it names the role, the session and the two commands, and the deploy
 * run is what exercises it.
 *
 * The wiring is checked by reading `deploy.sh` and the workflow, the way
 * `deploy-workflow-order.test.ts` checks the order of the steps: a validation
 * that exists and is never invoked is the failure mode this test is for, and a
 * green unit test would not catch it.
 */

const DEPLOY_SH = fs.readFileSync(path.resolve(__dirname, "deploy.sh"), "utf8");
const WORKFLOW = fs.readFileSync(
  path.resolve(__dirname, "../.github/workflows/deploy-workbench.yml"),
  "utf8",
);

const documentText = (overrides: Record<string, unknown>): string =>
  JSON.stringify(overrides, null, 2);

/** A directory where every address given resolves and is in the group. */
const members = (emails: readonly string[]) => {
  const ids = new Map(emails.map((email, index) => [email, `user-${index}`]));
  return {
    getUserId: async (email: string) => ids.get(email) ?? null,
    listMemberUserIds: async () => [...ids.values()],
  };
};

describe("the membership read", () => {
  it("keeps the addresses it resolved into the group, and names the rest", async () => {
    const result = await resolveMembership({
      ...members(["someone@goodparty.org"]),
      emails: ["someone@goodparty.org", "departed@goodparty.org"],
    });
    assert.deepEqual([...result.memberEmails], ["someone@goodparty.org"]);
    assert.deepEqual(result.notMembers, ["departed@goodparty.org"]);
  });

  it("treats an empty group as admitting nobody", async () => {
    // The janitor's guard, for the same reason: "the group is empty" and "the
    // read failed" are indistinguishable at the far end, and neither is a
    // reason to accept an override.
    const result = await resolveMembership({
      getUserId: async () => "user-1",
      listMemberUserIds: async () => [],
      emails: ["someone@goodparty.org"],
    });
    assert.equal(result.memberEmails.size, 0);
    assert.deepEqual(result.notMembers, ["someone@goodparty.org"]);
  });

  it("propagates a directory read that fails, rather than reading it as absences", async () => {
    // Fail closed in the direction that matters: a throttled or unreachable
    // directory must stop the run, not report every Engineer as departed and
    // fail on the first one with a misleading message.
    await assert.rejects(
      resolveMembership({
        getUserId: async () => {
          throw new Error("ThrottlingException");
        },
        listMemberUserIds: async () => ["user-1"],
        emails: ["someone@goodparty.org"],
      }),
      /ThrottlingException/,
    );

    await assert.rejects(
      resolveMembership({
        getUserId: async () => "user-1",
        listMemberUserIds: async () => {
          throw new Error("AccessDeniedException");
        },
        emails: ["someone@goodparty.org"],
      }),
      /AccessDeniedException/,
    );
  });
});

describe("the check over the committed document", () => {
  it("passes the committed file against the directory that holds its people", async () => {
    // The document is read from the repo, not from a fixture, so the check that
    // runs in the deploy workflow is this one. It is empty of people today, so
    // an empty member set is the honest fixture; a document that gains an
    // override in the same PR as this test would be caught by the deploy run
    // rather than here, which is the split the plan asks for.
    const text = fs.readFileSync(overridesPath(), "utf8");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const emails = Object.keys(parsed).filter((key) => !key.startsWith("$"));

    const result = await checkCommittedOverrides(members(emails), text);
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, new RegExp(GOVERNANCE_OVERRIDES_FILE.replace(/[.]/g, "\\.")));
  });

  it("fails with the email named when somebody is not in the group", async () => {
    const text = documentText({
      "departed@goodparty.org": { calendar_aligned: true },
    });
    const result = await checkCommittedOverrides(members([]), text);
    assert.equal(result.ok, false);
    assert.match(result.message, /departed@goodparty\.org/);
    assert.match(result.message, /not in the Engineers group/);
    // The file is named once, in the first line, so a reader of the run log
    // knows what to open.
    assert.ok(result.message.startsWith(GOVERNANCE_OVERRIDES_FILE));
  });

  it("reports the shape problems and the membership problems in one run", async () => {
    // One run, everything: a reviewer fixing a document should not have to run
    // the deploy twice to learn about a typo and a departed member.
    const text = documentText({
      "departed@goodparty.org": { budget: [{ max_limit: 1, reset_duration: "1M" }] },
    });
    const problems = await checkOverridesAgainstDirectory({
      text,
      directory: members([]),
    });
    const paths = problems.map((problem) => problem.path);
    assert.ok(paths.includes("departed@goodparty.org.budget"));
    assert.ok(paths.includes("departed@goodparty.org"));
  });

  it("reports a malformed document as a shape problem, with no directory read", async () => {
    const problems = await checkOverridesAgainstDirectory({
      text: "{ not json",
      directory: {
        getUserId: async () => {
          throw new Error("the directory must not be read for a malformed document");
        },
        listMemberUserIds: async () => {
          throw new Error("the directory must not be read for a malformed document");
        },
      },
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /not valid JSON/);
  });

  it("formats the failure with the file named once and every path listed", () => {
    const message = formatCheckFailure([
      { path: "a@goodparty.org", message: "is not in the Engineers group" },
      { path: "b@goodparty.org.budgets[0].max_limit", message: "must be a number" },
    ]);
    assert.ok(message.startsWith(GOVERNANCE_OVERRIDES_FILE));
    assert.ok(message.includes("a@goodparty.org: is not in the Engineers group"));
    assert.ok(
      message.includes("b@goodparty.org.budgets[0].max_limit: must be a number"),
    );
    assert.equal(message.match(/governance-overrides\.json/g)?.length, 1);
  });
});

describe("the role, the session and the group are the ones the Lambdas use", () => {
  it("assumes bifrost-vk-reader, in the management account, under its own session name", () => {
    assert.equal(
      VK_READER_ROLE_ARN,
      `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/bifrost-vk-reader`,
    );
    // The reader role lives where the Identity Store is, which is the
    // management account; the Lambdas are in the workbench one.
    assert.ok(!VK_READER_ROLE_ARN.includes("024901689212"));
    assert.equal(VK_READER_SESSION_NAME, "bifrost-vk-reader");
    // Imported and passed, not retyped: the role's own module is the source.
    const source = fs.readFileSync(
      path.resolve(__dirname, "scripts/preflight-governance.ts"),
      "utf8",
    );
    assert.match(source, /VK_READER_SESSION_NAME/);
    assert.doesNotMatch(source, /"bifrost-vk-reader"/);
  });

  it("reads the same Engineers group the mint and the janitor read", () => {
    // A fifth literal for one group id is how a validation check starts
    // agreeing with a directory nobody else reads.
    assert.equal(ENGINEERS_GROUP_ID, CORE_ENGINEERS_GROUP_ID);
  });
});

describe("it runs before the apply that writes the parameter", () => {
  it("is invoked by deploy.sh in the write path, after the secrets check and before the apply", () => {
    const governanceAt = DEPLOY_SH.indexOf("scripts/preflight-governance.ts");
    const secretsAt = DEPLOY_SH.indexOf("scripts/preflight-secrets.ts");
    const applyAt = DEPLOY_SH.indexOf("pulumi up --diff --yes\n");

    assert.ok(governanceAt !== -1, "deploy.sh never runs the governance check");
    assert.ok(secretsAt !== -1, "the secrets check moved");
    assert.ok(applyAt !== -1, "the unconstrained apply moved");
    assert.ok(
      governanceAt > secretsAt,
      "the governance check runs before the secrets check, which reads the preview",
    );
    assert.ok(
      governanceAt < applyAt,
      "the governance check runs after the apply, so a bad override is published before it is caught",
    );
    // Preview mode returns above this block, so a preview never reaches the
    // directory and never needs credentials for it.
    const previewReturn = DEPLOY_SH.indexOf('if [ "$PREVIEW" = "true" ]');
    assert.ok(previewReturn !== -1 && previewReturn < governanceAt);
    // The check's exit code stops the run: `set -e` is the whole mechanism, and
    // a `|| true` anywhere on this line would defeat it.
    const line = DEPLOY_SH.split("\n").find((candidate) =>
      candidate.includes("scripts/preflight-governance.ts"),
    );
    assert.ok(line && !line.includes("||"), `the check's failure is swallowed: ${line}`);
  });

  it("is not something the credential-free test job has to run", () => {
    // `npm test` picks up every `*.test.ts` under the project, and this one
    // holds no credentials, so it must stay that way. Named because the next
    // person to want a real directory read in a test will find this.
    assert.ok(!WORKFLOW.includes("preflight-governance"), "the deploy workflow runs the script from deploy.sh only");
    const deployWorkflow = fs.readFileSync(
      path.resolve(__dirname, "../.github/workflows/deploy.yml"),
      "utf8",
    );
    assert.match(deployWorkflow, /- run: npm test/);
  });
});
