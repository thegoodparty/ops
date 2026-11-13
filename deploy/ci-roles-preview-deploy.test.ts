import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GP_API_PREVIEW_ROLE_BOUNDARY_ARN,
  githubActionsPreviewDeploy,
  githubActionsPreviewDeployTrust,
  githubActionsPullRequestJobs,
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

const CHECKPOINTS = [
  "arn:aws:s3:::goodparty-iac-state/.pulumi/stacks/gp-api/gp-api-dev.json",
  "arn:aws:s3:::goodparty-iac-state/.pulumi/stacks/gp-api/gp-api-prod.json",
  "arn:aws:s3:::goodparty-iac-state/.pulumi/stacks/vercel-config/prod.json",
];

const DIFF_PROD_RESOURCES = [
  "arn:aws:ecs:us-west-2:333022194791:service/gp-master-fargateCluster/gp-api-master",
  "arn:aws:secretsmanager:us-west-2:333022194791:secret:GP_API_PROD-??????",
];

const DIFF_PROD_READS = [
  "ecs:DescribeServices",
  "secretsmanager:DescribeSecret",
  "secretsmanager:GetResourcePolicy",
];

describe("githubActionsPreviewDeployTrust", () => {
  const [pullRequest, judge] = githubActionsPreviewDeployTrust.Statement;

  it("has two statements, both under StringEquals", () => {
    assert.equal(githubActionsPreviewDeployTrust.Statement.length, 2);
    for (const s of githubActionsPreviewDeployTrust.Statement) {
      assert.equal(s.Action, "sts:AssumeRoleWithWebIdentity");
      assert.deepEqual(Object.keys(s.Condition), ["StringEquals"]);
    }
  });

  it("is assumed by omni pull_request runs", () => {
    assert.deepEqual(pullRequest.Condition.StringEquals, {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      [SUBJECT_KEY]: "repo:thegoodparty/omni:pull_request",
    });
  });

  // The judge runs pull request code from a main-ref workflow. Without the
  // workflow pin every main job could assume this role; with it, only
  // judge.yml as it is on main.
  it("is assumed on main by judge.yml alone", () => {
    assert.deepEqual(judge.Condition.StringEquals, {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      [SUBJECT_KEY]: "repo:thegoodparty/omni:ref:refs/heads/main",
      "token.actions.githubusercontent.com:job_workflow_ref":
        "thegoodparty/omni/.github/workflows/judge.yml@refs/heads/main",
    });
  });
});

describe("githubActionsPullRequestJobs", () => {
  const statements = githubActionsPullRequestJobs.Statement;
  const allowStatements = statements.filter((s) => s.Effect === "Allow");
  const actions = allowStatements.flatMap((s) => ("Action" in s ? asList(s.Action) : []));
  const resources = allowStatements.flatMap((s) => asList(s.Resource));
  const deny = (sid: string) => {
    const found = statements.find((s) => s.Sid === sid);
    assert.ok(found, `no statement with Sid ${sid}`);
    assert.equal(found.Effect, "Deny");
    return found;
  };

  it("allows no delete and no receive", () => {
    for (const action of actions) {
      assert.doesNotMatch(action, /Delete|Receive|\*/, action);
    }
  });

  it("writes E2E reports only under gp-webapp/", () => {
    const writes = allowStatements.filter(
      (s) =>
        "Action" in s &&
        asList(s.Action).includes("s3:PutObject") &&
        asList(s.Resource).some((r) => r.includes("gp-playwright-reports")),
    );
    assert.deepEqual(
      writes.flatMap((s) => asList(s.Resource)),
      ["arn:aws:s3:::gp-playwright-reports/gp-webapp/*"],
    );
  });

  it("allows only dev resources, the reports bucket and dev Terraform state", () => {
    for (const r of resources) {
      assert.match(
        r,
        /^arn:aws:s3:::gp-playwright-reports(\/gp-webapp\/\*)?$|-dev(\.fifo)?(\/|$)|^arn:aws:s3:::goodparty-terraform-state-us-west-2(\/\*\/dev\/terraform\.tfstate|\/shared\/slack-notifier\/terraform\.tfstate)?$/,
        r,
      );
    }
  });

  it("sends to the dispatch queue and looks it up, nothing else", () => {
    const sqs = actions.filter((a) => a.startsWith("sqs:")).sort();
    assert.deepEqual(sqs, ["sqs:GetQueueUrl", "sqs:SendMessage"]);
  });

  it("allows nothing on *", () => {
    assert.ok(!resources.includes("*"));
  });

  // ReadOnlyAccess allows s3:GetObject on *. The deny's NotResource is the
  // real list of what the role can read, so it has to hold every object an
  // allow names, or that read breaks, and nothing else.
  it("denies every object read but the ones the role's allows name", () => {
    const allowed = [...githubActionsPreviewDeploy.Statement, ...statements]
      .filter((s) => s.Effect === "Allow" && "Action" in s && asList(s.Action).includes("s3:GetObject"))
      .flatMap((s) => asList(s.Resource))
      .sort();
    const objects = deny("DenyOtherObjects");
    assert.deepEqual("Action" in objects ? objects.Action : undefined, ["s3:GetObject"]);
    assert.deepEqual(asList(objects.NotResource).sort(), allowed);
  });

  it("keeps prod Terraform state and other projects' Pulumi state out of reach", () => {
    const readable = asList(deny("DenyOtherObjects").NotResource);
    for (const r of readable) {
      assert.doesNotMatch(r, /\/prod\/terraform\.tfstate|dataplatform/, r);
      if (r.startsWith("arn:aws:s3:::goodparty-iac-state/.pulumi/")) {
        assert.match(
          r,
          /\/gp-api\/gp-api-pr-\*$|\/meta\.yaml$|\/gp-api-(dev|prod)\.json$|\/vercel-config\/prod\.json$/,
          r,
        );
      }
    }
  });

  it("denies every object version", () => {
    assert.deepEqual(asList(deny("DenyObjectVersions").Resource), ["*"]);
  });

  it("reads one secret value, GP_API_DEV, even with ReadOnlyAccess", () => {
    assert.deepEqual(asList(deny("DenyOtherSecretValues").NotResource), [
      "arn:aws:secretsmanager:us-west-2:333022194791:secret:GP_API_DEV-??????",
    ]);
  });

  it("reads three SSM parameters, and no history or path", () => {
    assert.equal(asList(deny("DenyOtherParameters").NotResource).length, 3);
    assert.deepEqual(asList(deny("DenyParameterPathsAndHistory").Resource), ["*"]);
  });

  // Managed policies are capped at 6,144 characters, counted without
  // whitespace. JSON.stringify emits none.
  it("fits the managed policy quota", () => {
    assert.ok(JSON.stringify(githubActionsPullRequestJobs).length < 6144);
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

  it("reads three SSM parameters: the passphrase and the diff's Grafana tokens", () => {
    const ssm = allowedActions().filter((a) => a.startsWith("ssm:"));
    assert.deepEqual([...new Set(ssm)], ["ssm:GetParameter"]);
    assert.deepEqual(
      allowsWith("ssm:GetParameter").flatMap((s) => asList(s.Resource)),
      [
        "arn:aws:ssm:us-west-2:333022194791:parameter/pulumi-state-config-passphrase",
        "arn:aws:ssm:us-west-2:333022194791:parameter/grafana-shared-service-account-token",
        "arn:aws:ssm:us-west-2:333022194791:parameter/grafana-sm-access-token",
      ],
    );
  });

  // gp-api's dev and prod stacks share the project prefix, and their older
  // copies hold the Aurora master passwords under the shared passphrase.
  // Every write on the state bucket has to stop at the preview stack prefix,
  // and the diff reads the two current checkpoints by exact name, beside
  // vercel-config's one.
  it("reaches gp-api's preview stacks in the state bucket, and reads three checkpoints", () => {
    const objects = allows()
      .flatMap((s) => asList(s.Resource))
      .filter((r) => r.startsWith("arn:aws:s3:::goodparty-iac-state/"));
    for (const r of objects) {
      if (r.endsWith("/.pulumi/meta.yaml") || CHECKPOINTS.includes(r)) continue;
      assert.match(r, /\/gp-api\/gp-api-pr-\*$/, `outside the preview stacks: ${r}`);
    }
    assert.deepEqual(asList(statement("PulumiStateMeta").Action), ["s3:GetObject"]);
    assert.deepEqual(asList(statement("DiffCheckpoints").Action), ["s3:GetObject"]);
    assert.deepEqual(asList(statement("DiffCheckpoints").Resource), CHECKPOINTS);
    for (const s of allows()) {
      if (s.Sid === "DiffCheckpoints") continue;
      for (const c of CHECKPOINTS) {
        assert.equal(asList(s.Resource).includes(c), false, `${s.Sid} names ${c}`);
      }
    }
  });

  // The bucket is versioned, and every earlier checkpoint is one versionId
  // away from the current one.
  it("reads no object version", () => {
    assert.equal(allowsWith("s3:GetObjectVersion").length, 0);
  });

  it("only reads in the diff's statements, and reads no secret value", () => {
    const diff = allows().filter((s) => s.Sid?.startsWith("Diff"));
    assert.equal(diff.length, 4);
    for (const s of diff) {
      for (const action of asList(s.Action)) {
        assert.match(action, /^[a-z0-9-]+:(Get|Describe)[A-Za-z]*$/, `${s.Sid}: ${action}`);
        assert.notEqual(action, "secretsmanager:GetSecretValue", s.Sid);
      }
    }
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
    for (const x of allows()) {
      if (!asList(x.Resource).some((r) => /gp-develop|gp-master/.test(r))) continue;
      assert.equal(x.Sid, "DiffDeployedServices", `dev or prod resource in ${x.Sid}`);
      assert.deepEqual(asList(x.Action), ["ecs:DescribeServices"]);
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

  it("denies everything on a resource tagged Environment=prod, but the diff's two", () => {
    const deny = statement("DenyProductionTagged");
    assert.equal(deny.Effect, "Deny");
    assert.ok("Action" in deny);
    assert.equal(deny.Action, "*");
    assert.equal(deny.Resource, undefined);
    assert.deepEqual(deny.NotResource, DIFF_PROD_RESOURCES);
    assert.deepEqual(deny.Condition, {
      StringEquals: { "aws:ResourceTag/Environment": "prod" },
    });
  });

  // The tag deny leaves those two out, so this is what holds them to reads.
  it("denies everything but three reads on the diff's two prod resources", () => {
    const deny = statement("DiffProdReadsOnly");
    assert.equal(deny.Effect, "Deny");
    assert.ok("NotAction" in deny);
    assert.deepEqual(deny.NotAction, DIFF_PROD_READS);
    assert.deepEqual(deny.Resource, DIFF_PROD_RESOURCES);
    assert.equal(deny.Condition, undefined);
    for (const s of allows()) {
      if (!asList(s.Resource).some((r) => DIFF_PROD_RESOURCES.includes(r))) continue;
      for (const action of asList(s.Action)) {
        assert.ok(DIFF_PROD_READS.includes(action), `${s.Sid}: ${action}`);
      }
    }
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

  it("names a prod or master resource only in the diff's statements", () => {
    for (const s of allows()) {
      const named = asList(s.Resource).filter((r) => /prod|master/i.test(r));
      if (named.length === 0) continue;
      assert.match(s.Sid ?? "", /^Diff/, `not preview: ${named.join(", ")}`);
    }
  });

  // Role inline policies share a 10,240 character quota, counted without
  // whitespace. JSON.stringify emits none. The diff's statements (step 5b)
  // took most of the room; a widening that does not fit moves them into a
  // managed policy of their own, which does not count against it.
  it("fits the inline policy quota with room to widen", () => {
    assert.ok(JSON.stringify(githubActionsPreviewDeploy).length < 9800);
  });
});
