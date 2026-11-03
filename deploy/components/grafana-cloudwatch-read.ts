import * as aws from "@pulumi/aws";

// The role Grafana Cloud assumes for the `aws-cloudwatch-prod` data source
// (`authType: grafana_assume_role`), which omni's gp-api deploy provisions
// against this exact name. Grafana's own AWS account makes the AssumeRole call,
// and the external ID is what limits that account to our stack.

// Grafana's AWS account id. From the aws-cloudwatch-prod data source's
// Authentication section (Settings tab, "How to create an IAM role for grafana
// to assume"). Not published in Grafana's docs.
export const GRAFANA_ACCOUNT_ID = "008923505280";

// Our stack's external ID. From the aws-cloudwatch-prod data source's
// Authentication section (Settings tab, "How to create an IAM role for grafana
// to assume").
export const GRAFANA_EXTERNAL_ID = "1532096";

export const grafanaCloudwatchReadTrust = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { AWS: `arn:aws:iam::${GRAFANA_ACCOUNT_ID}:root` },
      Action: "sts:AssumeRole",
      Condition: { StringEquals: { "sts:ExternalId": GRAFANA_EXTERNAL_ID } },
    },
  ],
};

// The two actions Grafana's permissions reference marks required for metrics
// queries. Its alarm, Contributor Insights, EC2 and tag actions back features
// (alarm display, template variables) the provisioned alerts and dashboard do
// not use, so they are left out.
export const grafanaCloudwatchReadPolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "CloudWatchMetricsRead",
      Effect: "Allow",
      Action: ["cloudwatch:GetMetricData", "cloudwatch:ListMetrics"],
      Resource: "*",
    },
  ],
};

export const createGrafanaCloudwatchRead = () => {
  const tags = { Environment: "infra", Project: "grafana" };

  const role = new aws.iam.Role("grafanaCloudwatchRead", {
    name: "grafana-cloudwatch-read",
    description:
      "Read-only CloudWatch metrics for the Grafana Cloud aws-cloudwatch-prod data source.",
    assumeRolePolicy: JSON.stringify(grafanaCloudwatchReadTrust),
    tags,
  });

  new aws.iam.RolePolicy("grafanaCloudwatchReadPolicy", {
    name: "grafana-cloudwatch-read",
    role: role.name,
    policy: JSON.stringify(grafanaCloudwatchReadPolicy),
  });

  return role;
};
