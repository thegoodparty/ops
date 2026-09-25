import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentInlinePolicy } from "./components/bugboss";

const statements = agentInlinePolicy.Statement;

const resourcesFor = (action: string): string[] =>
  statements
    .filter((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]).includes(action))
    .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]));

describe("agentInlinePolicy", () => {
  // The child mirrors its session JSONL to S3 per turn, which is what makes a
  // restart resume rather than start over. Without this the first launch died
  // at startup and the crash-loop breaker escalated.
  it("lets the agent write its own transcript", () => {
    assert.deepEqual(resourcesFor("s3:PutObject"), [
      "arn:aws:s3:::bugboss-prod/sessions/*",
    ]);
  });

  // S3 answers a GET for a missing key with AccessDenied rather than NoSuchKey
  // unless the caller holds ListBucket, and evaluates it on the bucket with no
  // `s3:prefix` in context — so this cannot be narrowed by prefix and is not
  // redundant with the object grant above.
  it("can tell an absent session from a forbidden one", () => {
    assert.deepEqual(resourcesFor("s3:ListBucket"), ["arn:aws:s3:::bugboss-prod"]);
  });

  // The boundary that matters. `state/db` is the incident database the Boss
  // restores from; an agent that could rewrite it would bypass every
  // transition guard in toolapi, which is the whole containment claim.
  it("reaches no object outside its own session prefix", () => {
    const objectActions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"];
    const granted = objectActions.flatMap(resourcesFor);

    // Without this the loop below passes on an empty list, which is how a test
    // that enforces a boundary quietly stops enforcing anything.
    assert.ok(granted.length > 0, "no object grants found — the check is vacuous");

    for (const resource of granted) {
      assert.ok(
        resource.startsWith("arn:aws:s3:::bugboss-prod/sessions/"),
        `object access to ${resource} reaches outside sessions/`,
      );
    }
  });

  // Resume reads the session back before the first turn. Asserting the write
  // alone would let a missing read pass, and a missing read is not visible
  // until a container restart fails to resume an incident already underway.
  it("lets the agent read its own transcript back", () => {
    assert.deepEqual(resourcesFor("s3:GetObject"), [
      "arn:aws:s3:::bugboss-prod/sessions/*",
    ]);
  });

  // Not granted today. Stated rather than assumed, because the boundary check
  // above iterates whatever is granted and would say nothing about a delete
  // that nobody added yet.
  it("cannot delete anything in the bucket", () => {
    assert.deepEqual(resourcesFor("s3:DeleteObject"), []);
  });

  it("grants no blanket object access to the bucket", () => {
    const wildcard = statements.some((s) =>
      (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).includes(
        "arn:aws:s3:::bugboss-prod/*",
      ),
    );
    assert.equal(wildcard, false);
  });
});
