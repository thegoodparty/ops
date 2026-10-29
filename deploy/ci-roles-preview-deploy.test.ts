import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GP_API_PREVIEW_ROLE_BOUNDARY_ARN,
  githubActionsPreviewDeploy,
  githubActionsPreviewDeployTrust,
} from "./components/ci-roles/policies";

const SUBJECT_KEY = "token.actions.githubusercontent.com:sub";

const asList = (value: unknown): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value as string];

const statement = (sid: string) => {
  const found = githubActionsPreviewDeploy.Statement.find((s) => s.Sid === sid);
  assert.ok(found, `no statement with Sid ${sid}`);
  return found;
};

const allows = () =>
  githubActionsPreviewDeploy.Statement.filter((s) => s.Effect === "Allow");

const allowedActions = () =>
  allows().flatMap((s) => ("Action" in s ? asList(s.Action) : []));

const allowsWith = (action: string) =>
  allows().filter((s) => "Action" in s && asList(s.Action).includes(action));

describe("githubActionsPreviewDeployTrust", () => {
  it("is assumed by omni pull_request runs alone, under StringEquals", () => {
    assert.equal(githubActionsPreviewDeployTrust.Statement.length, 1);
    const [s] = githubActionsPreviewDeployTrust.Statement;
    assert.equal(s.Action, "sts:AssumeRoleWithWebIdentity");
    assert.equal(s.Condition.StringLike, undefined);
    assert.deepEqual(s.Condition.StringEquals, {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      [SUBJECT_KEY]: "repo:thegoodparty/omni:pull_request",
    });
  });
});

describe("githubActionsPreviewDeploy", () => {
  // The two actions that make the shared deploy role admin-equivalent
  // regardless of the rest of its document, named in the plan's design.
  it("holds no sso, organizations or account-wide IAM policy action", () => {
    for (const action of allowedActions()) {
      assert.equal(/^(sso|organizations|account):/.test(action), false, action);
      assert.equal(
        /^iam:(CreatePolicy|CreatePolicyVersion|SetDefaultPolicyVersion|CreateUser|CreateAccessKey|AttachUserPolicy|PutUserPolicy)/.test(action),
        false,
        action,
      );
    }
  });

  it("uses no action wildcard except the ELB describes", () => {
    for (const action of allowedActions()) {
      if (!action.includes("*")) continue;
      assert.ok(
        ["elasticloadbalancing:Describe*", "s3:GetBucket*"].includes(action),
        `wildcard action: ${action}`,
      );
    }
  });

  // Self-escalation. Each of these can give a role a permission, so each must
  // require the step 6a boundary, and only on the preview's own roles.
  for (const action of [
    "iam:CreateRole",
    "iam:PutRolePolicy",
    "iam:AttachRolePolicy",
    "iam:PutRolePermissionsBoundary",
    "iam:UpdateAssumeRolePolicy",
  ]) {
    it(`grants ${action} only with the boundary, on gp-pr- roles`, () => {
      const grants = allowsWith(action);
      assert.equal(grants.length, 1, `${action} granted more than once`);
      const [s] = grants;
      assert.deepEqual(asList(s.Resource), ["arn:aws:iam::333022194791:role/gp-pr-*"]);
      assert.deepEqual(s.Condition, {
        StringEquals: { "iam:PermissionsBoundary": GP_API_PREVIEW_ROLE_BOUNDARY_ARN },
      });
    });
  }

  it("cannot remove or rewrite the boundary", () => {
    const deny = statement("DenyBoundaryTampering");
    assert.equal(deny.Effect, "Deny");
    assert.equal(deny.Resource, "*");
    for (const action of [
      "iam:DeleteRolePermissionsBoundary",
      "iam:CreatePolicyVersion",
      "iam:SetDefaultPolicyVersion",
      "iam:DeletePolicy",
    ]) {
      assert.ok(asList(deny.Action).includes(action), `missing ${action}`);
      assert.equal(allowsWith(action).length, 0, `${action} is allowed`);
    }
  });

  it("touches IAM roles named gp-pr- and nothing else in IAM", () => {
    for (const s of allows()) {
      if (!asList(s.Action).some((a) => a.startsWith("iam:"))) continue;
      assert.deepEqual(asList(s.Resource), ["arn:aws:iam::333022194791:role/gp-pr-*"], s.Sid);
    }
  });

  it("passes the preview roles to ECS tasks only", () => {
    const [s] = allowsWith("iam:PassRole");
    assert.deepEqual(s.Condition, {
      StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
    });
  });

  it("reads one secret value, GP_API_DEV", () => {
    const grants = allowsWith("secretsmanager:GetSecretValue");
    assert.equal(grants.length, 1);
    assert.deepEqual(asList(grants[0].Resource), [
      "arn:aws:secretsmanager:us-west-2:333022194791:secret:GP_API_DEV-??????",
    ]);
  });

  it("reads one SSM parameter, the state passphrase", () => {
    const ssm = allowedActions().filter((a) => a.startsWith("ssm:"));
    assert.deepEqual(ssm, ["ssm:GetParameter"]);
    assert.deepEqual(asList(statement("PulumiStatePassphrase").Resource), [
      "arn:aws:ssm:us-west-2:333022194791:parameter/pulumi-state-config-passphrase",
    ]);
  });

  // gp-api's dev and prod stacks share the project prefix, and their state
  // holds the Aurora master passwords under the shared passphrase. Every
  // object grant on the state bucket has to stop at the preview stack prefix.
  it("reaches gp-api's preview stacks in the state bucket, and no other", () => {
    const objects = allows()
      .flatMap((s) => asList(s.Resource))
      .filter((r) => r.startsWith("arn:aws:s3:::goodparty-iac-state/"));
    for (const r of objects) {
      if (r.endsWith("/.pulumi/meta.yaml")) continue;
      assert.match(r, /\/gp-api\/gp-api-pr-\*$/, `outside the preview stacks: ${r}`);
    }
    assert.deepEqual(asList(statement("PulumiStateMeta").Action), ["s3:GetObject"]);
  });

  // RDS deserves its own decision in the plan. Previews create no RDS
  // resource, so the role holds the one describe and nothing that could
  // touch the shared cluster.
  it("only describes the shared preview cluster", () => {
    const rds = allows().filter((s) => asList(s.Action).some((a) => a.startsWith("rds:")));
    assert.equal(rds.length, 1);
    assert.deepEqual(asList(rds[0].Action), ["rds:DescribeDBClusters"]);
    assert.deepEqual(asList(rds[0].Resource), [
      "arn:aws:rds:us-west-2:333022194791:cluster:gp-api-preview-shared-db",
    ]);
  });

  // The plan's open question for teardown. The drop runs on the preview's own
  // task definition in its own cluster, so no grant reaches a dev cluster or
  // a dev task definition.
  it("runs tasks only from preview task definitions, in preview clusters", () => {
    const [s] = allowsWith("ecs:RunTask");
    assert.deepEqual(asList(s.Resource), [
      "arn:aws:ecs:us-west-2:333022194791:task-definition/gp-pr-*",
    ]);
    assert.deepEqual(s.Condition, {
      ArnLike: { "ecs:cluster": "arn:aws:ecs:us-west-2:333022194791:cluster/gp-pr-*" },
    });
    for (const r of allows().flatMap((x) => asList(x.Resource))) {
      assert.equal(/gp-develop|gp-master/.test(r), false, `dev or prod resource: ${r}`);
    }
  });

  // The target group has no distinguishing name, so the tag is the only bound
  // on it. Creating needs the preview tags in the request; everything after
  // needs them on the resource.
  it("creates routing only with the preview tags in the request", () => {
    assert.deepEqual(statement("CreatePreviewRouting").Condition, {
      StringEquals: {
        "aws:RequestTag/Environment": "preview",
        "aws:RequestTag/Project": "gp-api",
      },
    });
  });

  it("modifies routing only where it is already tagged preview", () => {
    assert.deepEqual(statement("ManagePreviewRouting").Condition, {
      StringEquals: { "aws:ResourceTag/Environment": "preview" },
    });
    assert.deepEqual(statement("DeleteLegacyPreviewSecurityGroup").Condition, {
      StringEquals: { "aws:ResourceTag/Environment": "preview" },
    });
  });

  // Otherwise AddTags could relabel a dev target group as preview and the
  // statement above would then let it through.
  it("tags new routing only as part of creating it", () => {
    assert.deepEqual(statement("TagPreviewRoutingOnCreate").Condition, {
      StringEquals: {
        "elasticloadbalancing:CreateAction": ["CreateTargetGroup", "CreateRule"],
      },
    });
  });

  it("creates no load balancer, listener, security group or DNS record", () => {
    for (const action of [
      "elasticloadbalancing:CreateLoadBalancer",
      "elasticloadbalancing:CreateListener",
      "ec2:CreateSecurityGroup",
      "ec2:AuthorizeSecurityGroupIngress",
    ]) {
      assert.equal(allowsWith(action).length, 0, `${action} is allowed`);
    }
    const dns = statement("DeleteLegacyPreviewRecords");
    assert.deepEqual(dns.Condition, {
      "ForAllValues:StringEquals": {
        "route53:ChangeResourceRecordSetsActions": ["DELETE"],
        "route53:ChangeResourceRecordSetsRecordTypes": ["A", "AAAA"],
      },
      "ForAllValues:StringLike": {
        "route53:ChangeResourceRecordSetsNormalizedRecordNames": [
          "pr-*.preview.goodparty.org",
        ],
      },
    });
  });

  it("denies everything on a resource tagged Environment=prod", () => {
    const deny = statement("DenyProductionTagged");
    assert.equal(deny.Effect, "Deny");
    assert.ok("Action" in deny);
    assert.equal(deny.Action, "*");
    assert.equal(deny.Resource, "*");
    assert.deepEqual(deny.Condition, {
      StringEquals: { "aws:ResourceTag/Environment": "prod" },
    });
  });

  // "*" is for the actions AWS defines no resource for. Anything that takes
  // one has to be scoped.
  it("puts only resourceless actions on *", () => {
    const resourceless = new Set([
      "ecr:GetAuthorizationToken",
      "ecr-public:GetAuthorizationToken",
      "sts:GetServiceBearerToken",
      "ecs:DescribeTaskDefinition",
      "ecs:DeregisterTaskDefinition",
      "elasticloadbalancing:Describe*",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeNetworkInterfaces",
      "logs:DescribeLogGroups",
    ]);
    for (const s of allows()) {
      if (!asList(s.Resource).includes("*")) continue;
      for (const action of "Action" in s ? asList(s.Action) : []) {
        assert.ok(resourceless.has(action), `${action} is scopable but on *`);
      }
    }
  });

  it("names no prod or master resource", () => {
    for (const r of allows().flatMap((s) => asList(s.Resource))) {
      assert.equal(/prod|master/i.test(r), false, `not preview: ${r}`);
    }
  });

  // Role inline policies share a 10,240 character quota, counted without
  // whitespace. JSON.stringify emits none.
  it("fits the inline policy quota with room to widen", () => {
    assert.ok(JSON.stringify(githubActionsPreviewDeploy).length < 9000);
  });
});
