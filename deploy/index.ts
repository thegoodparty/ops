import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { createWorker } from "./components/worker";
import { createWebhookLambda } from "./components/webhooks";
import { createPlaywrightReportsBucket } from "./components/playwright-reports";
import { createIdentityCenter } from "./components/identity-center";
import { createCiRoles } from "./components/ci-roles";
import { DELEGATE_SECRET_KEYS } from "./delegate-secret";

export = async () => {
  const config = new pulumi.Config();
  const workerImageUri = config.require("workerImageUri");

  const vpcSubnetIds = {
    public: ["subnet-07984b965dabfdedc", "subnet-01c540e6428cdd8db"],
  };
  const securityGroupId = "sg-01de8d67b0f0ec787";

  // Metadata only: `getSecret` is a `DescribeSecret` call, so a preview never
  // reads the secret's value. The key names come from the repo; `deploy.sh`
  // checks the live secret against them on apply. See `docs/pr-previews.md`,
  // step 3.
  const secret = await aws.secretsmanager.getSecret({
    name: "DELEGATES",
  });

  const worker = createWorker({
    imageUri: workerImageUri,
    secretArn: secret.arn,
    secretKeys: [...DELEGATE_SECRET_KEYS],
    subnetIds: vpcSubnetIds.public,
    securityGroupIds: [securityGroupId],
  });

  const webhook = createWebhookLambda({
    clusterArn: worker.cluster.arn,
    taskDefArn: worker.taskDefinition.arn,
    subnetIds: vpcSubnetIds.public,
    securityGroupId,
    secretArn: secret.arn,
  });

  const playwrightReports = createPlaywrightReportsBucket();

  createIdentityCenter();
  createCiRoles();

  return {
    webhookUrl: webhook.url,
    clusterName: worker.cluster.name,
    logGroupName: worker.logGroup.name,
    playwrightReportsBucket: playwrightReports.bucket.bucket,
  };
};
