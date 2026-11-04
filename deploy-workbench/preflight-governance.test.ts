import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { MANAGEMENT_ACCOUNT_ID } from "../utils/accounts";
import { ENGINEERS_GROUP_ID as CORE_ENGINEERS_GROUP_ID } from "./bifrost/vk-mint-core";
import { checkGovernanceOverrides } from "./bifrost/governance-desired-state";
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
  SHAPE_ONLY_NOTE,
} from "./scripts/preflight-governance";
import { isNoSuchUser } from "./scripts/aws-role";

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

  it("treats a missing user as not-a-member, not as a directory outage", async () => {
    // `GetUserId` on an address that names nobody fails with
    // `ResourceNotFoundException`; every other failure is an outage. Without
    // this split a typo in an email exits "could not complete" and never says
    // which email is wrong, which is one of the messages the reviewer found.
    assert.equal(
      isNoSuchUser(
        "An error occurred (ResourceNotFoundException) when calling the GetUserId operation: no such user",
      ),
      true,
    );
    assert.equal(isNoSuchUser("An error occurred (AccessDeniedException)"), false);
    assert.equal(isNoSuchUser("Unable to locate credentials"), false);
    assert.equal(isNoSuchUser(""), false);

    // And the check's own half: a null user is a named non-member, an thrown
    // read is an abort.
    const directory = {
      getUserId: async () => null,
      listMemberUserIds: async () => ["user-1"],
    };
    const found = await checkOverridesAgainstDirectory({
      text: documentText({ "typo@goodparty.org": {} }),
      directory,
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "typo@goodparty.org");
    assert.match(found[0].message, /not in the Engineers group/);
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

describe("the deploy job can actually run it", () => {
  it("does not assume a role this job's session cannot assume", () => {
    // The reviewer's finding, pinned. `bifrost-vk-reader`'s trust admits two
    // principals, the two Lambdas' execution roles; the deploy job holds the
    // first-hop `github-actions-workbench-deploy`, whose policy allows
    // `sts:AssumeRole` only on the workbench `pulumi-deploy`. So an
    // unconditional assume of the reader from this script is an `AccessDenied`
    // on every deploy, under `set -e`, before `pulumi up` -- and it is a role
    // neither file admits, so no test of the ARN or the session name would
    // catch it.
    const readerSource = fs.readFileSync(
      path.resolve(__dirname, "../deploy/components/bifrost-vk-reader.ts"),
      "utf8",
    );
    const ciRoleSource = fs.readFileSync(
      path.resolve(__dirname, "../deploy/components/ci-roles/policies.ts"),
      "utf8",
    );

    // The reader's trust names the Lambdas' roles and no CI role.
    const granteeBlock = /const GRANTEE_ROLE_ARNS = \[([\s\S]*?)\];/.exec(
      readerSource,
    );
    assert.ok(granteeBlock, "the reader's grantee list moved");
    assert.ok(!/github-actions/.test(granteeBlock[1]));

    // The CI role's assume grant names one workbench role, not the reader.
    // Matched up to the closing `},` of the statement rather than the first
    // `}`, because the statement's own braces are nested inside it.
    const assumeAt = ciRoleSource.indexOf('Sid: "AssumeWorkbenchDeployRole"');
    assert.ok(assumeAt !== -1, "the CI role's workbench assume moved");
    const assumeBlock = ciRoleSource.slice(assumeAt, assumeAt + 400);
    assert.match(assumeBlock, /pulumi-deploy/);
    assert.ok(!/bifrost-vk-reader/.test(assumeBlock));

    // And the script takes the shape-only path when it holds no reader-role
    // grant, instead of throwing. The reader-role branch is entered only through
    // READER_ROLE_ARN, which no workflow sets. GOVERNANCE_CHECK_MEMBERSHIP used to
    // route there too, and the message that named it told the deploy job to do
    // the one thing it cannot (the review's finding, pinned below).
    const scriptSource = fs.readFileSync(
      path.resolve(__dirname, "scripts/preflight-governance.ts"),
      "utf8",
    );
    assert.doesNotMatch(scriptSource, /GOVERNANCE_CHECK_MEMBERSHIP/);
    assert.match(scriptSource, /--members/);
    assert.match(scriptSource, /GOVERNANCE_OVERRIDES_MEMBERS/);
  });

  it("never tells the deploy job to set a flag that assumes the reader role", () => {
    // The advice printed on a shape-only success names a member-set remedy the
    // deploy job can take, and not the flag that routes into createCliDirectory.
    assert.doesNotMatch(SHAPE_ONLY_NOTE, /GOVERNANCE_CHECK_MEMBERSHIP/);
    assert.match(SHAPE_ONLY_NOTE, /--members/);
    assert.match(SHAPE_ONLY_NOTE, /GOVERNANCE_OVERRIDES_MEMBERS/);
  });

  it("takes an explicit member set, which is the form a caller without the grant uses", () => {
    // The logic the flag feeds: a set, and an email outside it fails.
    const members = new Set(["someone@goodparty.org"]);
    const problems = checkGovernanceOverrides(
      documentText({
        "someone@goodparty.org": { calendar_aligned: true },
        "departed@goodparty.org": { calendar_aligned: true },
      }),
      { isMember: (email: string) => members.has(email.toLowerCase()) },
    );
    assert.equal(problems.length, 1);
    assert.equal(problems[0].path, "departed@goodparty.org");
  });

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
