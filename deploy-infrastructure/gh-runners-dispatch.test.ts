import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { shouldDispatch, verifySignature } from "./gh-runners-dispatch/handler";

const SECRET = "webhook-secret";
const BODY = '{"action":"queued"}';
const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("gh-runners dispatch verifySignature", () => {
  it("accepts a good signature", () => {
    assert.equal(verifySignature(BODY, sign(BODY), SECRET), true);
  });

  it("accepts a good signature over a Buffer body", () => {
    assert.equal(verifySignature(Buffer.from(BODY), sign(BODY), SECRET), true);
  });

  it("rejects a signature made with another secret", () => {
    assert.equal(verifySignature(BODY, sign(BODY, "other"), SECRET), false);
  });

  it("rejects a signature over another body", () => {
    assert.equal(verifySignature(BODY, sign('{"action":"completed"}'), SECRET), false);
  });

  it("rejects a missing signature", () => {
    assert.equal(verifySignature(BODY, undefined, SECRET), false);
    assert.equal(verifySignature(BODY, "", SECRET), false);
  });

  it("rejects a signature of the wrong length", () => {
    assert.equal(verifySignature(BODY, sign(BODY).slice(0, -1), SECRET), false);
    assert.equal(verifySignature(BODY, "sha256=abc", SECRET), false);
  });
});

describe("gh-runners dispatch shouldDispatch", () => {
  const REPOS = ["thegoodparty/ops", "thegoodparty/omni"];
  const job = (labels: string[], overrides: Record<string, unknown> = {}) => ({
    action: "queued",
    workflow_job: { id: 1, run_id: 2, labels },
    repository: { full_name: "thegoodparty/ops" },
    ...overrides,
  });

  it("dispatches a queued gp-ecs job", () => {
    assert.equal(shouldDispatch("workflow_job", job(["gp-ecs"]), REPOS).dispatch, true);
  });

  it("dispatches when every label is one the runner registers", () => {
    const labels = ["self-hosted", "linux", "x64", "gp-ecs"];
    assert.equal(shouldDispatch("workflow_job", job(labels), REPOS).dispatch, true);
  });

  it("compares labels case-insensitively", () => {
    const labels = ["Self-Hosted", "Linux", "X64", "GP-ECS"];
    assert.equal(shouldDispatch("workflow_job", job(labels), REPOS).dispatch, true);
  });

  it("ignores a job without the gp-ecs label", () => {
    assert.equal(shouldDispatch("workflow_job", job(["ubuntu-latest"]), REPOS).dispatch, false);
    assert.equal(shouldDispatch("workflow_job", job(["self-hosted", "linux"]), REPOS).dispatch, false);
  });

  it("ignores a job with a label the runner does not register", () => {
    assert.equal(shouldDispatch("workflow_job", job(["gp-ecs", "gpu"]), REPOS).dispatch, false);
    assert.equal(shouldDispatch("workflow_job", job(["gp-ecs", "arm64"]), REPOS).dispatch, false);
  });

  it("ignores actions other than queued", () => {
    for (const action of ["in_progress", "completed", "waiting"]) {
      assert.equal(
        shouldDispatch("workflow_job", job(["gp-ecs"], { action }), REPOS).dispatch,
        false,
      );
    }
  });

  it("ignores other events, including ping", () => {
    for (const event of ["ping", "workflow_run", "push", undefined]) {
      assert.equal(shouldDispatch(event, job(["gp-ecs"]), REPOS).dispatch, false);
    }
  });

  it("ignores repos outside the allowlist", () => {
    const outside = job(["gp-ecs"], { repository: { full_name: "thegoodparty/gp-api" } });
    assert.equal(shouldDispatch("workflow_job", outside, REPOS).dispatch, false);
    const fork = job(["gp-ecs"], { repository: { full_name: "someone/ops" } });
    assert.equal(shouldDispatch("workflow_job", fork, REPOS).dispatch, false);
    const missing = job(["gp-ecs"], { repository: undefined });
    assert.equal(shouldDispatch("workflow_job", missing, REPOS).dispatch, false);
  });
});
