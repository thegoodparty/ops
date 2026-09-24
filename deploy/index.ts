import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { createWorker } from "./components/worker";
import { createWebhookLambda } from "./components/webhooks";
import { createPlaywrightReportsBucket } from "./components/playwright-reports";
import { createIdentityCenter } from "./components/identity-center";
import { createCiRoles } from "./components/ci-roles";
import { createBugBoss } from "./components/bugboss";

export = async () => {
  const config = new pulumi.Config();
  const workerImageUri = config.require("workerImageUri");

  const vpcSubnetIds = {
    public: ["subnet-07984b965dabfdedc", "subnet-01c540e6428cdd8db"],
  };
  const securityGroupId = "sg-01de8d67b0f0ec787";

  const secretVersion = await aws.secretsmanager.getSecretVersion({
    secretId: "DELEGATES",
  });

  const secretKeys = Object.keys(
    JSON.parse(secretVersion.secretString || "{}") as Record<string, string>
  );

  const worker = createWorker({
    imageUri: workerImageUri,
    secretArn: secretVersion.arn,
    secretKeys,
    subnetIds: vpcSubnetIds.public,
    securityGroupIds: [securityGroupId],
  });

  const webhook = createWebhookLambda({
    clusterArn: worker.cluster.arn,
    taskDefArn: worker.taskDefinition.arn,
    subnetIds: vpcSubnetIds.public,
    securityGroupId,
    secretArn: secretVersion.arn,
  });

  const playwrightReports = createPlaywrightReportsBucket();

  createIdentityCenter();
  createCiRoles();

  // Gated rather than unconditional because deploy.yml still builds and
  // pushes only delegate-worker, so there is no BugBoss image to pull and the
  // service would sit at zero healthy tasks. The `bugboss` ECR repository is
  // created out of band; nothing here creates it, which is what keeps
  // `ecr:CreateRepository` off the deploy role. Set `bugbossImageUri` in
  // deploy.sh once the build step lands.
  const bugbossImageUri = config.get("bugbossImageUri");
  const bugboss = bugbossImageUri
    ? createBugBoss({
        imageUri: bugbossImageUri,
        subnetIds: vpcSubnetIds.public,
      })
    : undefined;

  return {
    webhookUrl: webhook.url,
    clusterName: worker.cluster.name,
    logGroupName: worker.logGroup.name,
    playwrightReportsBucket: playwrightReports.bucket.bucket,
    bugbossUrl: bugboss?.url,
  };
};
