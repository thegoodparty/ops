import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface WebhookConfig {
  clusterArn: pulumi.Output<string>;
  taskDefArn: pulumi.Output<string>;
  subnetIds: string[];
  securityGroupId: string;
  secretArn: string;
}

export const createWebhookLambda = (config: WebhookConfig) => {
  const role = new aws.iam.Role("webhookLambdaRole", {
    name: "delegate-webhook-lambda-role",
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
        },
      ],
    }),
    managedPolicyArns: [
      "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    ],
    inlinePolicies: [
      {
        name: "ecs-run-task",
        policy: pulumi.jsonStringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: "ecs:RunTask",
              Resource: config.taskDefArn,
            },
            {
              Effect: "Allow",
              Action: "ecs:TagResource",
              Resource: config.clusterArn.apply(
                (arn) => arn.replace(":cluster/", ":task/") + "/*"
              ),
            },
            {
              Effect: "Allow",
              Action: ["iam:PassRole"],
              Resource: ["*"],
              Condition: {
                StringLike: {
                  "iam:PassedToService": "ecs-tasks.amazonaws.com",
                },
              },
            },
            {
              Effect: "Allow",
              Action: ["secretsmanager:GetSecretValue"],
              Resource: [config.secretArn],
            },
          ],
        }),
      },
    ],
  });

  const fn = new aws.lambda.Function("webhookLambda", {
    name: "delegate-webhook",
    role: role.arn,
    runtime: aws.lambda.Runtime.NodeJS22dX,
    handler: "handler.handler",
    code: new pulumi.asset.FileArchive("../dist/lambda"),
    timeout: 30,
    memorySize: 256,
    environment: {
      variables: {
        CLUSTER_ARN: config.clusterArn,
        TASK_DEF_ARN: config.taskDefArn,
        SUBNET_IDS: config.subnetIds.join(","),
        SECURITY_GROUP_ID: config.securityGroupId,
        SECRET_ARN: config.secretArn,
      },
    },
  });

  const functionUrl = new aws.lambda.FunctionUrl("webhookUrl", {
    functionName: fn.name,
    authorizationType: "NONE",
  });

  return { fn, url: functionUrl.functionUrl };
};
