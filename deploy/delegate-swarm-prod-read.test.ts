import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  delegateSwarmProdReadPolicy,
  delegateSwarmProdReadTrust,
} from "./components/delegate-swarm-prod-read";

const asList = (value: string | string[]) =>
  Array.isArray(value) ? value : [value];

describe("delegateSwarmProdReadTrust", () => {
  // The account root is the principal only because the host role may not
  // exist when this applies; the condition is what narrows it to the host.
  it("admits only the swarm host role in the infrastructure account", () => {
    assert.deepEqual(delegateSwarmProdReadTrust.Statement, [
      {
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::394495727159:root" },
        Action: "sts:AssumeRole",
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn":
              "arn:aws:iam::394495727159:role/delegate-swarm-host",
          },
        },
      },
    ]);
  });
});

describe("delegateSwarmProdReadPolicy", () => {
  // Pricing is read-only as a whole service. Insights StartQuery and
  // StopQuery run and cancel a read.
  const READ_ONLY =
    /^([a-z-]+:(Describe|Get|List|View)[A-Za-z]*\*?|logs:(FilterLogEvents|StartQuery|StopQuery|TestMetricFilter)|pricing:\*)$/;

  it("allows only read actions", () => {
    const statements: {
      Effect: string;
      Action: string | string[];
      NotAction?: unknown;
    }[] = delegateSwarmProdReadPolicy.Statement;
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
