import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import type { AgentJob } from "../framework/types";

const ecs = new ECSClient({});

export const dispatch = async (job: AgentJob) => {
  const { CLUSTER_ARN, TASK_DEF_ARN, SUBNET_IDS, SECURITY_GROUP_ID } =
    process.env;

  if (!CLUSTER_ARN || !TASK_DEF_ARN || !SUBNET_IDS || !SECURITY_GROUP_ID) {
    throw new Error(
      "Missing required env vars: CLUSTER_ARN, TASK_DEF_ARN, SUBNET_IDS, SECURITY_GROUP_ID"
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
            environment: [
              { name: "AGENT_JOB", value: JSON.stringify(job) },
            ],
          },
        ],
      },
      tags: [
        { key: "agent", value: job.agent },
        ...(job.metadata
          ? Object.entries(job.metadata).map(([key, value]) => ({
              key,
              value,
            }))
          : []),
      ],
    })
  );

  const taskArn = result.tasks?.[0]?.taskArn;
  console.log(`Dispatched ${job.agent}: ${taskArn}`);
  return { taskArn };
};
