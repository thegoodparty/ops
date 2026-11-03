import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  grafanaCloudwatchReadPolicy,
  grafanaCloudwatchReadTrust,
} from "./components/grafana-cloudwatch-read";

describe("grafanaCloudwatchReadTrust", () => {
  // Without the external ID condition, any Grafana Cloud customer's data
  // source could assume this role.
  it("admits only Grafana's account presenting our external ID", () => {
    assert.deepEqual(grafanaCloudwatchReadTrust.Statement, [
      {
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::008923505280:root" },
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: { "sts:ExternalId": "1532096" },
        },
      },
    ]);
  });
});

describe("grafanaCloudwatchReadPolicy", () => {
  it("allows only CloudWatch metric reads", () => {
    assert.deepEqual(grafanaCloudwatchReadPolicy.Statement, [
      {
        Sid: "CloudWatchMetricsRead",
        Effect: "Allow",
        Action: ["cloudwatch:GetMetricData", "cloudwatch:ListMetrics"],
        Resource: "*",
      },
    ]);
  });
});
