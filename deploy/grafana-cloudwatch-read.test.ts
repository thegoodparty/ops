import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GRAFANA_STACK_EXTERNAL_ID,
  grafanaCloudwatchReadPolicy,
  grafanaCloudwatchReadTrust,
} from "./components/grafana-cloudwatch-read";

const asList = (value: string | string[]) =>
  Array.isArray(value) ? value : [value];

describe("grafanaCloudwatchReadTrust", () => {
  // Grafana's account is shared by every Grafana Cloud stack; the external ID
  // is the only thing that keeps the others out.
  it("requires our stack's external ID", () => {
    assert.match(GRAFANA_STACK_EXTERNAL_ID, /\S/);
    assert.deepEqual(grafanaCloudwatchReadTrust.Statement, [
      {
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::008923505280:root" },
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: { "sts:ExternalId": GRAFANA_STACK_EXTERNAL_ID },
        },
      },
    ]);
  });
});

describe("grafanaCloudwatchReadPolicy", () => {
  // Insights StartQuery and StopQuery run and cancel a read.
  const READ_ONLY =
    /^([a-z0-9-]+:(Describe|Get|List)[A-Za-z]*|logs:(StartQuery|StopQuery))$/;

  it("allows only read actions", () => {
    const statements: {
      Effect: string;
      Action: string | string[];
      NotAction?: unknown;
    }[] = grafanaCloudwatchReadPolicy.Statement;
    assert.ok(statements.length > 0);
    for (const statement of statements) {
      assert.equal(statement.Effect, "Allow");
      assert.equal(statement.NotAction, undefined);
      for (const action of asList(statement.Action)) {
        assert.match(action, READ_ONLY, `${action} is not a read action`);
      }
    }
  });
});
