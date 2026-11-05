import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { withAdminReserved } from "./components/identity-center";
import {
  workbenchAccess,
  readOnlyAccess,
} from "./components/identity-center/policies";
import { WORKBENCH_ACCOUNT_ID, MANAGEMENT_ACCOUNT_ID } from "../utils/accounts";

// `WorkbenchAccess` has guardrails on, so the document Pulumi serialises is
// `adminReservedActions` prepended to `workbenchAccess`, not the export on its
// own. Assert on the composed document, which is the one that reaches IAM.
const composed = withAdminReserved(workbenchAccess);

const actionsOf = (s: (typeof composed.Statement)[number]): string[] =>
  Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];

const asList = (value: unknown): string[] =>
  value === undefined
    ? []
    : Array.isArray(value)
      ? (value as string[])
      : [value as string];

/**
 * The invoke actions a session must not hold: the whole invoke family on the
 * foundation-model service, which is the two `InvokeModel` forms, the
 * bidirectional stream the speech models use, and the two `Converse` forms.
 *
 * A deliberate second copy, in the shape `identity-center-engineer.test.ts`
 * uses for `BEDROCK_SERVICE_PREFIXES`: an action added to the policy's Deny
 * without being added here fails the exact-match test below, which is the
 * point. What nothing can detect is a *new* AWS action that means "invoke",
 * and that is a reason to keep the Deny rather than a gap a test could close.
 */
const BEDROCK_INVOKE_ACTIONS = [
  "bedrock:Converse",
  "bedrock:ConverseStream",
  "bedrock:InvokeModel",
  "bedrock:InvokeModelWithBidirectionalStream",
  "bedrock:InvokeModelWithResponseStream",
];

describe("WorkbenchAccess", () => {
  // The set is the entire session for an engineer's sandbox, and the account is
  // meant to hold Bedrock traffic and nothing worth reading. The Brave key the
  // web search tool needs is the one exception, and it is deliberately the only
  // secretsmanager or ssm permission in the document.
  it("allows GetSecretValue on the gp-pi Brave secret and nothing else", () => {
    const reads = composed.Statement.filter(
      (s) =>
        s.Effect === "Allow" &&
        actionsOf(s).includes("secretsmanager:GetSecretValue")
    );

    assert.equal(reads.length, 1);
    assert.deepEqual(actionsOf(reads[0]), ["secretsmanager:GetSecretValue"]);
    assert.equal(
      reads[0].Resource,
      `arn:aws:secretsmanager:us-west-2:${WORKBENCH_ACCOUNT_ID}:secret:gp-pi/brave-search-??????`
    );
  });

  it("grants no other secretsmanager or ssm action", () => {
    const others = composed.Statement.filter((s) => s.Effect === "Allow")
      .flatMap(actionsOf)
      .filter(
        (a) =>
          /^(secretsmanager|ssm):/.test(a) &&
          a !== "secretsmanager:GetSecretValue"
      );

    assert.deepEqual(others, []);
  });

  // The admin guardrails are prepended to every set, and none of them names
  // secretsmanager or ssm today. Asserted so that adding one later is a visible
  // change here rather than a silent deny of the Brave read.
  it("does not deny the secret read through the admin guardrails", () => {
    const denies = composed.Statement.filter((s) => s.Effect === "Deny")
      .flatMap(actionsOf)
      .filter((a) => /^(secretsmanager|ssm):/.test(a));

    assert.deepEqual(denies, []);
  });

  // ---------------------------------------------------------------------
  // Bifrost is the only invoke path, which is two separate facts: this set
  // holds no invoke action, and it holds no way to become an identity that
  // does. The second half is the one a reviewer would otherwise have to take
  // on trust, and it is the half that makes removing the first more than
  // cosmetic.
  // ---------------------------------------------------------------------

  it("allows no Bedrock invoke action", () => {
    const invokeAllows = composed.Statement.filter(
      (s) => s.Effect === "Allow"
    ).filter((s) =>
      actionsOf(s).some((a) =>
        BEDROCK_INVOKE_ACTIONS.includes(a) ||
        // Any wildcard that would cover one of them. `bedrock:*` is the shape
        // this set carried until 2026-09-22 and the one a careless revert
        // would restore.
        /^bedrock:(\*|Invoke\*|Converse\*)$/.test(a)
      )
    );

    assert.deepEqual(
      invokeAllows.map((s) => s.Sid ?? "(no Sid)"),
      [],
      "WorkbenchAccess allows a Bedrock invoke action; Bifrost's task role is the only principal that may invoke a model"
    );
  });

  // The Deny is not what refuses the call — the absence of an Allow above is.
  // It is what an engineer reads in the error, and what keeps holding if a
  // later edit adds a broad grant. Asserted exactly, so growing it or
  // narrowing it is a visible change in review.
  it("denies the whole invoke family explicitly, on every resource", () => {
    const denies = composed.Statement.filter((s) => s.Effect === "Deny");
    const invoke = denies.filter((s) =>
      actionsOf(s).some((a) => a.startsWith("bedrock:"))
    );

    assert.equal(invoke.length, 1, "one Bedrock deny, and it is the invoke one");
    assert.equal(invoke[0].Sid, "DenyDirectBedrockInvoke");
    assert.deepEqual(actionsOf(invoke[0]), BEDROCK_INVOKE_ACTIONS);
    assert.equal(invoke[0].Resource, "*");

    // Reads are allowed and the Deny must not shadow them: a Deny beats an
    // Allow, so a `bedrock:*` here would take the catalog page away from every
    // engineer and the failure would read as an outage rather than a policy.
    for (const action of actionsOf(invoke[0])) {
      assert.ok(
        !/^(bedrock):(\*|Get\*|List\*)$/.test(action),
        `${action} in the Deny would shadow the catalog reads`
      );
    }
  });

  it("still allows the catalog reads", () => {
    const reads = composed.Statement.filter(
      (s) =>
        s.Effect === "Allow" &&
        actionsOf(s).includes("bedrock:Get*") &&
        actionsOf(s).includes("bedrock:List*")
    );

    assert.equal(reads.length, 1);
    assert.equal(reads[0].Sid, "ReadBedrockCatalogAndState");
    assert.equal(reads[0].Resource, "*");
  });

  // The assume half. The gateway's task role trusts only the ECS tasks service
  // (`deploy-workbench/ecs.ts`), so no engineer session can become it whatever
  // this document says. The test reads the trust policy from source, the way
  // `deploy-workbench/ecs.test.ts` reads resource blocks, because standing up
  // the resource needs a Pulumi runtime.
  it("cannot assume the gateway's task role", () => {
    // No `sts:AssumeRole` is granted to this set at all. That is stronger than
    // "not on the task role" and is what makes the claim durable: a new role in
    // the account does not become reachable by being created.
    const assumes = composed.Statement.filter((s) => s.Effect === "Allow")
      .flatMap(actionsOf)
      .filter((a) => /^sts:(AssumeRole|AssumeRoleWith\w+|\*)$/.test(a));

    assert.deepEqual(
      assumes,
      [],
      "WorkbenchAccess holds sts:AssumeRole; direct Bedrock access could return through an assumed role"
    );

    // And the task role's own trust would refuse the attempt anyway. Two
    // independent halves, and neither is load-bearing on its own: the first is
    // a policy this repo controls, the second is the resource-side check that
    // survives a mistake in the first.
    const ecsSource = fs.readFileSync(
      path.resolve(__dirname, "../deploy-workbench/ecs.ts"),
      "utf8"
    );
    const taskRoleStart = ecsSource.indexOf('"bifrostTaskRole"');
    assert.ok(taskRoleStart >= 0, "ecs.ts has no bifrostTaskRole resource");
    const taskRoleBlock = ecsSource.slice(taskRoleStart).split("new aws.")[0];
    assert.match(
      taskRoleBlock,
      /Principal: \{ Service: "ecs-tasks\.amazonaws\.com" \}/,
      "the gateway's task role must trust only the ECS tasks service"
    );
    assert.doesNotMatch(
      taskRoleBlock,
      /Principal: \{ AWS:/,
      "the gateway's task role trusts an AWS principal; an engineer session could assume it back into a Bedrock invoke"
    );
  });

  // The read-only set is assigned to engineers in the main account, and it
  // gains `sts:AssumeRole` on exactly one role: the workbench preview role,
  // which holds no permissions at all. Asserted so a later edit cannot turn
  // that single hop into a path to a role that does hold a Bedrock invoke.
  it("keeps ReadOnlyAccess's one cross-account hop pointed at a role with no permissions", () => {
    const assumes = readOnlyAccess.Statement.filter(
      (s) => s.Effect === "Allow"
    )
      .flatMap((s) => asList(s.Action))
      .filter((a) => a.startsWith("sts:"));

    assert.deepEqual(assumes, ["sts:AssumeRole"]);
    const target = readOnlyAccess.Statement.flatMap((s) =>
      asList(s.Resource)
    ).filter((r) => r.includes(":role/"));
    assert.deepEqual(target, [
      `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/pulumi-preview`,
    ]);
    // `pulumi-preview` has no policy attached by design
    // (`deploy-workbench/preview-role.ts`), and the management-account side of
    // that trust is asserted here so a widened target fails visibly.
    assert.notEqual(MANAGEMENT_ACCOUNT_ID, WORKBENCH_ACCOUNT_ID);
  });
});
