// Inline policies for the Identity Center permission sets, in TypeScript so
// the document shape is type-checked rather than trusted. The AWS provider
// parses this field as JSON, so how it serialises does not have to match how
// AWS stores it.

type PolicyValue = string | string[];

export type PolicyStatement = {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action: PolicyValue;
  Resource?: PolicyValue;
  NotAction?: PolicyValue;
  NotResource?: PolicyValue;
  Condition?: Record<string, Record<string, PolicyValue>>;
};

export type PolicyDocument = {
  Version: "2012-10-17";
  Statement: PolicyStatement[];
};

export const engineerAccess: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:*"],
      Resource: "*",
    },
    {
      Effect: "Allow",
      Action: ["sqs:*"],
      Resource: "*",
    },
    {
      Sid: "DevResourceOperations",
      Effect: "Allow",
      Action: ["*"],
      Resource: "*",
      Condition: {
        StringEquals: {
          "aws:ResourceTag/Environment": "dev",
        },
      },
    },
    {
      Sid: "DevResourceCreation",
      Effect: "Allow",
      Action: ["*"],
      Resource: "*",
      Condition: {
        StringEquals: {
          "aws:RequestTag/Environment": "dev",
        },
        StringNotEquals: {
          "aws:ResourceTag/Environment": "prod",
        },
      },
    },
    {
      Effect: "Deny",
      Action: [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
      ],
      Resource: "*",
      Condition: {
        StringEquals: {
          "aws:ResourceTag/Environment": "prod",
        },
      },
    },
    {
      Sid: "LoaderCreateAndManageRDS",
      Effect: "Allow",
      Action: [
        "rds:CreateDBCluster",
        "rds:CreateDBInstance",
        "rds:CreateDBClusterParameterGroup",
        "rds:AddRoleToDBCluster",
        "rds:RemoveRoleFromDBCluster",
        "rds:ModifyDBCluster",
        "rds:ModifyDBInstance",
        "rds:RebootDBCluster",
        "rds:RebootDBInstance",
        "rds:DeleteDBCluster",
        "rds:DeleteDBInstance",
        "rds:DeleteDBClusterParameterGroup",
      ],
      Resource: "*",
      Condition: {
        StringEqualsIfExists: {
          "aws:RequestTag/Environment": "dev",
          "aws:ResourceTag/Environment": "dev",
        },
      },
    },
    {
      Sid: "LoaderPassRoleForRDS",
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: "arn:aws:iam::333022194791:role/rds-s3-import-*",
      Condition: {
        StringEquals: {
          "iam:PassedToService": "rds.amazonaws.com",
        },
      },
    },
    {
      Sid: "InvokeGoldMatchEmbeddingModels",
      Effect: "Allow",
      Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      Resource: [
        "arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0",
        "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-2-multimodal-embeddings-v1:0",
      ],
    },
    {
      Sid: "InvokeGoldMatchHaikuGlobalProfile",
      Effect: "Allow",
      Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      Resource: [
        "arn:aws:bedrock:us-east-1:333022194791:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0",
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
      ],
    },
    {
      Sid: "TranscribeJobs",
      Effect: "Allow",
      Action: [
        "transcribe:StartTranscriptionJob",
        "transcribe:GetTranscriptionJob",
      ],
      Resource: "*",
    },
  ],
};

export const readOnlyAccess: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Deny",
      Action: [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
      ],
      Resource: "*",
      Condition: {
        StringEquals: {
          "aws:ResourceTag/Environment": "prod",
        },
      },
    },
  ],
};

export const productManager: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:ListBucket"],
      Resource: [
        "arn:aws:s3:::serve-analyze-data-dev",
        "arn:aws:s3:::serve-analyze-data-qa",
        "arn:aws:s3:::serve-analyze-data-prod",
      ],
    },
    {
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject"],
      Resource: ["arn:aws:s3:::serve-analyze-data-*/input/*"],
    },
    {
      Effect: "Allow",
      Action: ["s3:*"],
      Resource: [
        "arn:aws:s3:::meeting-pipeline-dev",
        "arn:aws:s3:::meeting-pipeline-dev/*",
      ],
    },
  ],
};
