import * as aws from "@pulumi/aws";

// Read-only CloudWatch access for Grafana Cloud's CloudWatch data source,
// which omni's gp-api deploy provisions with the "Grafana Assume Role" auth
// type. Grafana assumes this role from its own AWS account; no AWS keys are
// stored in Grafana.

// Grafana Labs' account for Grafana Assume Role, shown in the CloudWatch
// data source's setup instructions. Shared by every Grafana Cloud stack.
const GRAFANA_ACCOUNT_ID = "008923505280";

// Unique to our Grafana Cloud stack (goodparty, 1532096), from the CloudWatch
// data source's Settings tab. Without it, any Grafana Cloud stack could
// assume this role.
export const GRAFANA_STACK_EXTERNAL_ID = "";

export const grafanaCloudwatchReadTrust = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { AWS: `arn:aws:iam::${GRAFANA_ACCOUNT_ID}:root` },
      Action: "sts:AssumeRole",
      Condition: {
        StringEquals: { "sts:ExternalId": GRAFANA_STACK_EXTERNAL_ID },
      },
    },
  ],
};

// The metrics-and-logs policy from Grafana's CloudWatch data source docs.
export const grafanaCloudwatchReadPolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "CloudWatchMetrics",
      Effect: "Allow",
      Action: [
        "cloudwatch:DescribeAlarmsForMetric",
        "cloudwatch:DescribeAlarmHistory",
        "cloudwatch:DescribeAlarms",
        "cloudwatch:ListMetrics",
        "cloudwatch:GetMetricData",
        "cloudwatch:GetInsightRuleReport",
      ],
      Resource: "*",
    },
    {
      Sid: "CloudWatchLogs",
      Effect: "Allow",
      Action: [
        "logs:DescribeLogGroups",
        "logs:GetLogGroupFields",
        "logs:StartQuery",
        "logs:StopQuery",
        "logs:GetQueryResults",
        "logs:GetLogEvents",
      ],
      Resource: "*",
    },
    {
      Sid: "DimensionLookups",
      Effect: "Allow",
      Action: [
        "ec2:DescribeTags",
        "ec2:DescribeInstances",
        "ec2:DescribeRegions",
        "tag:GetResources",
        "oam:ListSinks",
        "oam:ListAttachedLinks",
      ],
      Resource: "*",
    },
  ],
};

export const createGrafanaCloudwatchRead = () => {
  const tags = { Environment: "infra", Project: "grafana" };

  const role = new aws.iam.Role("grafanaCloudwatchRead", {
    name: "grafana-cloudwatch-read",
    description:
      "Read-only CloudWatch access for Grafana Cloud's CloudWatch data source.",
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
