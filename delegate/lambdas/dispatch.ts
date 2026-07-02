import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import type { AgentJob } from "../framework/types";

const ecs = new ECSClient({});

// ECS resource tags only permit "UTF-8 letters, spaces, numbers, and
// _ . / = + - : @". Some tag values are derived from GitHub data — notably
// `metadata.author`, which is the PR author's login. Bot accounts render as
// `dependabot[bot]` / `<app>[bot]`, and the `[` / `]` make RunTask reject the
// whole call, which github.ts swallows as `github_webhook_dispatch_failed` —
// so a Dependabot PR silently never gets reviewed. Replace any disallowed
// character with `-` (and cap at the 256-char tag-value limit) so dispatch
// always succeeds regardless of who authored the PR.
export const sanitizeTagValue = (value: string): string =>
  value.replace(/[^\p{L}\p{N} _.\/=+:@-]/gu, "-").slice(0, 256);

export const dispatch = async (job: AgentJob) => {
  const { CLUSTER_ARN, TASK_DEF_ARN, SUBNET_IDS, SECURITY_GROUP_ID } =
    process.env;

  if (!CLUSTER_ARN || !TASK_DEF_ARN || !SUBNET_IDS || !SECURITY_GROUP_ID) {
    throw new Error(
      "Missing required env vars: CLUSTER_ARN, TASK_DEF_ARN, SUBNET_IDS, SECURITY_GROUP_ID",
    );
  }

  const result = await ecs.send(
    new RunTaskCommand({
      cluster: CLUSTER_ARN,
      taskDefinition: TASK_DEF_ARN,
      launchType: "FARGATE",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: SUBNET_IDS.split(","),
          securityGroups: [SECURITY_GROUP_ID],
          assignPublicIp: "ENABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: "agent",
            environment: [{ name: "AGENT_JOB", value: JSON.stringify(job) }],
          },
        ],
      },
      tags: [
        // Attribute the Fargate task's cost to the ops project in Cost
        // Explorer; the task def is tagged but RunTask tags aren't inherited.
        { key: "Project", value: "ops" },
        { key: "agent", value: job.agent },
        ...(job.metadata
          ? Object.entries(job.metadata).map(([key, value]) => ({
              key,
              value: sanitizeTagValue(value),
            }))
          : []),
      ],
    }),
  );

  const taskArn = result.tasks?.[0]?.taskArn;
  console.log(`Dispatched ${job.agent}: ${taskArn}`);
  return { taskArn };
};
