import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyInvoke, invokeArguments, isResourceNotFound, isThrottle } from "./verify-usage-export-bootstrap";

/**
 * The bootstrap poll's classification, which is the whole of its logic.
 *
 * The branch that matters most is `ResourceNotFound`, because it is the one place
 * this script has to distinguish "the function was removed as planned" from "the
 * function was never created". Getting it wrong either way is bad in a different
 * direction: a blanket failure would make a deploy red for a week after the
 * removal PR, and a blanket pass would let a skipped apply go green with no role
 * and no password.
 */
describe("usage export bootstrap poll", () => {
  const base = {
    stdout: "",
    stderr: "",
    status: 0,
    payload: undefined as string | undefined,
    secretHasPassword: () => false,
  };

  it("reads a provisioned reply", () => {
    assert.deepEqual(
      classifyInvoke({ ...base, payload: JSON.stringify({ outcome: "provisioned" }) }),
      { kind: "provisioned" },
    );
  });

  it("reads the no-op", () => {
    assert.deepEqual(
      classifyInvoke({ ...base, payload: JSON.stringify({ outcome: "already-provisioned" }) }),
      { kind: "already-provisioned" },
    );
  });

  it("fails on an unrecognised reply rather than passing", () => {
    // A Lambda can return anything on a bug; an unrecognised value is a change to
    // the contract, not a success.
    for (const payload of [undefined, "", "not json", JSON.stringify({ outcome: "ok" }), "[]"]) {
      const attempt = classifyInvoke({ ...base, payload });
      assert.equal(attempt.kind, "failed", `payload ${String(payload)} must not pass`);
    }
  });

  it("retries a throttle rather than failing", () => {
    const attempt = classifyInvoke({
      ...base,
      status: 1,
      stderr: "An error occurred (TooManyRequestsException) when calling the Invoke operation",
    });
    assert.equal(attempt.kind, "throttled");
  });

  it("treats a removed function as provisioned only when the secret holds a password", () => {
    const removed = {
      ...base,
      status: 1,
      stderr: "An error occurred (ResourceNotFoundException) when calling the Invoke operation",
    };
    assert.deepEqual(classifyInvoke({ ...removed, secretHasPassword: () => true }), {
      kind: "removed-and-provisioned",
    });
    assert.deepEqual(classifyInvoke({ ...removed, secretHasPassword: () => false }), {
      kind: "removed-and-not-provisioned",
    });
  });

  it("fails a run that threw", () => {
    const attempt = classifyInvoke({
      ...base,
      stdout: '{"StatusCode": 200, "FunctionError": "Unhandled"}',
    });
    assert.equal(attempt.kind, "failed");
  });

  it("invokes with RequestResponse and a read timeout above the function's", () => {
    const args = invokeArguments({ functionName: "fn", region: "us-west-2", outFile: "/tmp/out.json" });
    assert.ok(args.includes("RequestResponse"), "Event would be green on a failed provision");
    const timeoutAt = args.indexOf("--cli-read-timeout");
    assert.ok(timeoutAt !== -1);
    assert.ok(Number(args[timeoutAt + 1]) > 120, "the read timeout must exceed the function's own timeout");
    assert.ok(!args.includes("--payload"), "the handler takes no payload");
  });

  it("recognises the two error shapes it is looking for", () => {
    assert.ok(isThrottle("TooManyRequestsException"));
    assert.ok(isThrottle("HTTP 429"));
    assert.ok(isResourceNotFound("ResourceNotFoundException"));
    assert.ok(!isResourceNotFound("AccessDeniedException"));
    assert.ok(!isThrottle("AccessDeniedException"));
  });
});
