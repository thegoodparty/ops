import * as aws from "@pulumi/aws";

const ACCOUNT_ID = "333022194791";
const REGION = "us-west-2";

/**
 * The only thing in AWS BugBoss evals touch. `.github/workflows/bugboss-eval.yml`
 * assumes this role through GitHub's OIDC provider, from the `bugboss-eval`
 * environment, which only `main` may deploy to. It can invoke Bedrock models
 * and nothing else, so the BugBoss under test, which resolves AWS through it,
 * is denied every other call.
 */
export const BUGBOSS_EVAL_ROLE_NAME = "github-actions-bugboss-eval";
export const BUGBOSS_EVAL_SUBJECT = "repo:thegoodparty/ops:environment:bugboss-eval";

export const bugbossEvalTrust = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: {
        Federated: `arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com`,
      },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": BUGBOSS_EVAL_SUBJECT,
        },
      },
    },
  ],
};

export const bugbossEvalPolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      Resource: [
        "arn:aws:bedrock:*::foundation-model/*",
        `arn:aws:bedrock:*:${ACCOUNT_ID}:inference-profile/*`,
        `arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:application-inference-profile/*`,
      ],
    },
  ],
};

export const createBugBossEvalRole = () => {
  const role = new aws.iam.Role("githubActionsBugbossEval", {
    name: BUGBOSS_EVAL_ROLE_NAME,
    assumeRolePolicy: JSON.stringify(bugbossEvalTrust),
    // A comparison runs up to six hours, and the job holds one session.
    maxSessionDuration: 6 * 3600,
    tags: { Environment: "infra", Project: "bugboss-evals" },
  });
  new aws.iam.RolePolicy("githubActionsBugbossEvalBedrock", {
    role: role.id,
    policy: JSON.stringify(bugbossEvalPolicy),
  });
  return role;
};
