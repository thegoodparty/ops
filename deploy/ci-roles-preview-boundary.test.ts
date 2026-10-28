import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GP_API_PREVIEW_ROLE_BOUNDARY_ARN,
  gpApiPreviewRoleBoundary,
} from "./components/ci-roles/policies";

const asList = (value: unknown): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value as string];

const actions = () =>
  gpApiPreviewRoleBoundary.Statement.flatMap((s) =>
    "Action" in s ? asList(s.Action) : []
  );

const resources = () =>
  gpApiPreviewRoleBoundary.Statement.flatMap((s) => asList(s.Resource));

describe("gpApiPreviewRoleBoundary", () => {
  // omni's preview stack and the preview deploy role both name this ARN, and
  // IAM matches it as a string. Renaming the policy silently stops every
  // preview role from being created.
  it("has the ARN omni and the preview deploy role name", () => {
    assert.equal(
      GP_API_PREVIEW_ROLE_BOUNDARY_ARN,
      "arn:aws:iam::333022194791:policy/GpApiPreviewRoleBoundary"
    );
  });

  // A boundary only ever caps. A Deny here would add nothing a missing Allow
  // does not already give, and a NotAction or NotResource Allow is how a
  // ceiling quietly becomes "everything except".
  it("is allow statements over named actions and resources only", () => {
    for (const s of gpApiPreviewRoleBoundary.Statement) {
      assert.equal(s.Effect, "Allow", `${s.Sid} is not an Allow`);
      assert.ok("Action" in s, `${s.Sid} uses NotAction`);
      assert.equal(s.NotResource, undefined, `${s.Sid} uses NotResource`);
    }
  });

  it("uses no service-wide action wildcard", () => {
    for (const action of actions()) {
      assert.equal(action.endsWith(":*"), false, `wildcard: ${action}`);
      assert.notEqual(action, "*");
    }
  });

  // The whole point. A preview role is written by unreviewed code, so the
  // ceiling must not let it reach identity, credentials, or configuration.
  it("reaches no IAM, STS, Organizations, SSO or SSM parameter action", () => {
    for (const action of actions()) {
      assert.equal(
        /^(iam|sts|organizations|sso|kms):/.test(action),
        false,
        `not allowed in the boundary: ${action}`
      );
      assert.equal(/^ssm:/.test(action), false, `SSM parameter action: ${action}`);
    }
  });

  it("reads exactly one secret, GP_API_DEV", () => {
    const secretStatements = gpApiPreviewRoleBoundary.Statement.filter((s) =>
      "Action" in s && asList(s.Action).some((a) => a.startsWith("secretsmanager:"))
    );
    assert.equal(secretStatements.length, 1);
    assert.deepEqual(asList(secretStatements[0].Action), [
      "secretsmanager:GetSecretValue",
    ]);
    assert.deepEqual(asList(secretStatements[0].Resource), [
      "arn:aws:secretsmanager:us-west-2:333022194791:secret:GP_API_DEV-??????",
    ]);
  });

  it("names no prod or master resource", () => {
    for (const resource of resources()) {
      assert.equal(/prod|master/i.test(resource), false, `not preview: ${resource}`);
    }
  });

  // "*" is reserved for the actions AWS defines no resource for. S3, SQS,
  // Secrets Manager and log writes all take a resource, so none of them may
  // fall back to it.
  it("puts only resourceless actions on *", () => {
    const resourceless =
      /^(ecr:GetAuthorizationToken|route53domains:|ssmmessages:|transcribe:|polly:|textract:)/;
    for (const s of gpApiPreviewRoleBoundary.Statement) {
      if (!asList(s.Resource).includes("*")) continue;
      for (const action of "Action" in s ? asList(s.Action) : []) {
        assert.match(action, resourceless, `${action} is scopable but on *`);
      }
    }
  });

  // A pattern like `*-dev` would reach every dev bucket anyone adds later.
  // The owned buckets carry the stack's `pr-<n>` stage, which no dev or prod
  // bucket does; shared dev buckets are named in full.
  it("scopes bucket wildcards to the preview stage", () => {
    for (const resource of resources()) {
      if (!resource.startsWith("arn:aws:s3:::")) continue;
      const bucket = resource.slice("arn:aws:s3:::".length).replace(/\/\*$/, "");
      if (bucket.includes("*")) {
        assert.match(bucket, /-pr-\*$/, `bucket wildcard outside pr-: ${bucket}`);
      }
    }
  });

  it("reaches only the preview's own queues", () => {
    const queues = resources().filter((r) => r.startsWith("arn:aws:sqs:"));
    assert.deepEqual(queues, [
      "arn:aws:sqs:us-west-2:333022194791:pr-*-Queue.fifo",
      "arn:aws:sqs:us-west-2:333022194791:pr-*-DLQ.fifo",
    ]);
  });
});
