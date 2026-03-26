import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { WebClient } from "@slack/web-api";
import axios, { AxiosInstance } from "axios";
import type { z } from "zod";

export type JobContext = {
  github: Octokit;
  slack: WebClient;
  clickup: AxiosInstance;
};

type JobDefinition = {
  /**
   * A CloudWatch schedule expression.
   * See: https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-schedule-expressions.html
   */
  schedule: string;
};

type JobHandler = (ctx: JobContext) => Promise<void>;

export type Job = {
  type: "job";
  definition: JobDefinition;
  handler: JobHandler;
};

export const defineJob = (
  definition: JobDefinition,
  handler: JobHandler,
): Job => ({ type: "job", definition, handler });

export type AgentJobDefinition<T extends z.ZodType> = {
  schedule: string;
  agent: {
    prompt: string;
    model: string;
  };
  outputSchema: T;
};

type AgentJobHandler<T extends z.ZodType> = (
  ctx: JobContext,
  output: z.infer<T>,
) => Promise<void>;

export type AgentJob<T extends z.ZodType = z.ZodType> = {
  type: "agent";
  definition: AgentJobDefinition<T>;
  handler: AgentJobHandler<T>;
};

export const defineAgentJob = <T extends z.ZodType>(
  definition: AgentJobDefinition<T>,
  handler: AgentJobHandler<T>,
): AgentJob<T> => ({ type: "agent", definition, handler });

export const createAgentHandler =
  <T extends z.ZodType>(agentJob: AgentJob<T>) =>
  async (validatedOutput: z.infer<T>) => {
    const ctx = await buildContext();
    await agentJob.handler(ctx, validatedOutput);
  };

let cachedSecrets: Record<string, string> | null = null;

const getSecrets = async (): Promise<Record<string, string>> => {
  if (cachedSecrets) return cachedSecrets;

  const secretArn = process.env.SECRET_ARN;

  if (!secretArn) {
    cachedSecrets = {
      GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ?? "",
      CLICKUP_TOKEN: process.env.CLICKUP_TOKEN ?? "",
    };
    return cachedSecrets;
  }

  const client = new SecretsManagerClient({});
  const result = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );

  cachedSecrets = JSON.parse(result.SecretString ?? "{}") as Record<
    string,
    string
  >;
  return cachedSecrets;
};

const buildContext = async (): Promise<JobContext> => {
  const secrets = await getSecrets();

  const raw = secrets["GITHUB_APP_PRIVATE_KEY"];
  if (!raw) throw new Error("Missing GITHUB_APP_PRIVATE_KEY in secrets");

  const github = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: 3107048,
      installationId: 117364330,
      privateKey: [
        "-----BEGIN RSA PRIVATE KEY-----",
        raw
          .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
          .replace(/-----END RSA PRIVATE KEY-----/, "")
          .replace(/\s+/g, ""),
        "-----END RSA PRIVATE KEY-----",
      ].join("\n"),
    },
  });

  const slack = new WebClient(secrets["SLACK_BOT_TOKEN"]);

  const clickup = axios.create({
    baseURL: "https://api.clickup.com/api/v2",
    headers: {
      Authorization: secrets["CLICKUP_TOKEN"],
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });

  return { github, slack, clickup };
};

export const createHandler = (job: Job) => async () => {
  const ctx = await buildContext();
  await job.handler(ctx);
};
