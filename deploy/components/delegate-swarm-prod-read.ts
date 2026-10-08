import * as aws from "@pulumi/aws";
import { INFRASTRUCTURE_ACCOUNT_ID } from "../../utils/accounts";

// Production read access for the Delegate swarm, which runs in the
// infrastructure account (deploy-infrastructure/agent-swarm.ts). Its host
// role assumes this one; nothing in that account holds production
// credentials of its own.

const HOST_ROLE_ARN = `arn:aws:iam::${INFRASTRUCTURE_ACCOUNT_ID}:role/delegate-swarm-host`;

// The account root with a PrincipalArn condition rather than the host role as
// the principal: IAM rejects a trust that names a role that does not exist
// yet, and this stack and the infrastructure stack apply concurrently on the
// same push.
export const delegateSwarmProdReadTrust = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { AWS: `arn:aws:iam::${INFRASTRUCTURE_ACCOUNT_ID}:root` },
      Action: "sts:AssumeRole",
      Condition: { ArnEquals: { "aws:PrincipalArn": HOST_ROLE_ARN } },
    },
  ],
};

export const delegateSwarmProdReadPolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "CloudWatchRead",
      Effect: "Allow",
      Action: [
        "cloudwatch:Describe*",
        "cloudwatch:Get*",
        "cloudwatch:List*",
        "logs:Describe*",
        "logs:Get*",
        "logs:List*",
        "logs:FilterLogEvents",
        "logs:StartQuery",
        "logs:StopQuery",
        "logs:TestMetricFilter",
      ],
      Resource: "*",
    },
    {
      Sid: "EcsRead",
      Effect: "Allow",
      Action: [
        "ecs:Describe*",
        "ecs:List*",
        "ecr:Describe*",
        "ecr:List*",
        "application-autoscaling:Describe*",
      ],
      Resource: "*",
    },
    {
      Sid: "CostRead",
      Effect: "Allow",
      Action: [
        "ce:Get*",
        "ce:Describe*",
        "ce:List*",
        "budgets:ViewBudget",
        "budgets:Describe*",
        "cur:Describe*",
        "pricing:*",
      ],
      Resource: "*",
    },
  ],
};

export const createDelegateSwarmProdRead = () => {
  const tags = { Environment: "infra", Project: "delegate-swarm" };

  const role = new aws.iam.Role("delegateSwarmProdRead", {
    name: "delegate-swarm-prod-read",
    description:
      "Read-only production access for the Delegate swarm host in the infrastructure account.",
    assumeRolePolicy: JSON.stringify(delegateSwarmProdReadTrust),
    tags,
  });

  new aws.iam.RolePolicy("delegateSwarmProdReadPolicy", {
    name: "delegate-swarm-prod-read",
    role: role.name,
    policy: JSON.stringify(delegateSwarmProdReadPolicy),
  });

  return role;
};
