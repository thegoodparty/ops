import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAdminReserved } from "./components/identity-center";
import {
  BIFROST_VK_MINT_FUNCTION_ARN,
  workbenchAccess,
} from "./components/identity-center/policies";

// Step 4 of `docs/bifrost-virtual-keys.md`: `WorkbenchAccess` may call the
// Bifrost virtual-key mint function's URL, and may not call the function any
// other way.
//
// The two conditions are the whole boundary, and the failure they prevent is
// silent rather than loud: a bare `lambda:InvokeFunction` beside the correct
// statements is not an error at apply time and does not break the mint, it just
// also admits the direct `Invoke` API. That path delivers only the payload, so
// the function cannot see who called it and cannot enforce "your own key only".
// This file exists to make that addition fail a test.

// `WorkbenchAccess` has guardrails on, so the document that reaches IAM is
// `adminReservedActions` prepended to `workbenchAccess`. Assert on the composed
// document, as `deploy/identity-center-workbench.test.ts` does.
const composed = withAdminReserved(workbenchAccess);

// The function ARN, pinned as a literal rather than imported, and mirrored from
// step 2's role name and step 3's function in `deploy-workbench/`. The two
// stacks apply independently and the plan allows either order, so this string
// is the seam between them: if either side renames the function the test below
// is what makes the drift visible in review rather than as an `AccessDenied` at
// the first mint.
const MINT_FUNCTION_ARN =
  "arn:aws:lambda:us-west-2:024901689212:function:bifrost-vk-mint";

const actionsOf = (s: (typeof composed.Statement)[number]): string[] =>
  Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];

const allowStatements = composed.Statement.filter((s) => s.Effect === "Allow");

const lambdaStatements = allowStatements.filter((s) =>
  actionsOf(s).some((a) => /^lambda:/.test(a))
);

// A statement admits direct `Invoke` unless the `InvokedViaFunctionUrl`
// condition is on it. Named separately because three tests ask the question in
// different ways.
const invokesDirectly = (s: (typeof composed.Statement)[number]): boolean =>
  actionsOf(s).includes("lambda:InvokeFunction") &&
  s.Condition?.Bool?.["lambda:InvokedViaFunctionUrl"] === undefined;

describe("WorkbenchAccess: the Bifrost virtual-key mint invoke grant", () => {
  it("names exactly the function ARN step 2 pinned, with no wildcard", () => {
    assert.equal(BIFROST_VK_MINT_FUNCTION_ARN, MINT_FUNCTION_ARN);
    assert.match(
      MINT_FUNCTION_ARN,
      /^arn:aws:lambda:us-west-2:024901689212:function:bifrost-vk-mint$/
    );
    assert.doesNotMatch(BIFROST_VK_MINT_FUNCTION_ARN, /\*/);
  });

  it("allows lambda:InvokeFunctionUrl on the mint function, gated on AWS_IAM", () => {
    const statements = allowStatements.filter((s) =>
      actionsOf(s).includes("lambda:InvokeFunctionUrl")
    );

    assert.equal(statements.length, 1);
    const [statement] = statements;
    assert.deepEqual(actionsOf(statement), ["lambda:InvokeFunctionUrl"]);
    assert.equal(statement.Resource, MINT_FUNCTION_ARN);
    assert.deepEqual(statement.Condition, {
      StringEquals: { "lambda:FunctionUrlAuthType": "AWS_IAM" },
    });
  });

  it("allows lambda:InvokeFunction on the mint function, gated on InvokedViaFunctionUrl", () => {
    const statements = allowStatements.filter((s) =>
      actionsOf(s).includes("lambda:InvokeFunction")
    );

    assert.equal(statements.length, 1);
    const [statement] = statements;
    assert.deepEqual(actionsOf(statement), ["lambda:InvokeFunction"]);
    assert.equal(statement.Resource, MINT_FUNCTION_ARN);
    // `Bool`, not `StringEquals`: it is a boolean condition key, and a string
    // comparison against it matches nothing, which would turn this half of the
    // grant into an inert statement that reads as though it works.
    assert.deepEqual(statement.Condition, {
      Bool: { "lambda:InvokedViaFunctionUrl": "true" },
    });
  });

  // The absence test the plan asks for. A bare `lambda:InvokeFunction` is
  // explicitly allowed by AWS and would let a `WorkbenchAccess` session call
  // the function through the Invoke API, losing the caller identity the url
  // path depends on.
  it("grants no bare lambda:InvokeFunction anywhere in the document", () => {
    const bare = composed.Statement.filter(
      (s) => s.Effect === "Allow" && invokesDirectly(s)
    );

    assert.deepEqual(
      bare.map((s) => s.Sid),
      []
    );
  });

  // Stated the other way round, so a future statement that renames its action
  // or uses a wildcard cannot slip past the check above: every lambda action in
  // the document is one of the two url-path actions, on the one function.
  it("grants no lambda action beyond the two the url path needs", () => {
    const actions = lambdaStatements.flatMap(actionsOf);

    assert.deepEqual([...actions].sort(), [
      "lambda:InvokeFunction",
      "lambda:InvokeFunctionUrl",
    ]);
    for (const action of actions) {
      assert.doesNotMatch(action, /\*/, action);
    }
    for (const statement of lambdaStatements) {
      assert.equal(statement.Resource, MINT_FUNCTION_ARN, statement.Sid);
      assert.equal(statement.NotAction, undefined, statement.Sid);
      assert.equal(statement.NotResource, undefined, statement.Sid);
    }
  });

  // A `lambda:*` or a wildcarded function name would widen the grant from "this
  // one function's url" to "any function", which is the thing the condition
  // cannot claw back.
  it("scopes every lambda grant to the one function, with no wildcard resource", () => {
    const resources = lambdaStatements.flatMap((s) =>
      Array.isArray(s.Resource) ? s.Resource : s.Resource ? [s.Resource] : []
    );

    assert.ok(resources.length > 0);
    for (const resource of resources) {
      assert.equal(resource, MINT_FUNCTION_ARN, resource);
    }
  });

  // The admin guardrails are prepended to every set. None of them names lambda
  // today, and asserting it means a future deny that collides with the mint is
  // a visible change here rather than an AccessDenied at the first call.
  it("does not deny any lambda action through the admin guardrails", () => {
    const denies = composed.Statement.filter((s) => s.Effect === "Deny")
      .flatMap(actionsOf)
      .filter((a) => /^lambda:/.test(a));

    assert.deepEqual(denies, []);
  });
});
