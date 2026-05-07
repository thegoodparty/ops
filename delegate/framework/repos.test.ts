import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WRITE_REPOS, isWritableRepo, assertWritableRepo } from "./repos";

describe("WRITE_REPOS", () => {
  it("contains the expected initial allowlist", () => {
    assert.deepEqual([...WRITE_REPOS].sort(), [
      "gp-api",
      "gp-webapp",
      "people-api",
      "election-api",
      "runbooks",
      "gp-ai-projects",
      "ai-rules",
      "gp-sdk",
      "campaign-plan-service",
      "gp-data-platform",
      "candidate-sites",
    ]);
  });
});

describe("isWritableRepo", () => {
  it("returns true for repos in the allowlist", () => {
    assert.equal(isWritableRepo("gp-api"), true);
    assert.equal(isWritableRepo("ops"), true);
  });

  it("returns false for repos not in the allowlist", () => {
    assert.equal(isWritableRepo("runbooks"), false);
    assert.equal(isWritableRepo(""), false);
    assert.equal(isWritableRepo("Gp-Api"), false); // case-sensitive
  });
});

describe("assertWritableRepo", () => {
  it("does not throw for a writable repo", () => {
    assert.doesNotThrow(() => assertWritableRepo("gp-api"));
  });

  it("throws with a helpful message for a non-writable repo", () => {
    assert.throws(
      () => assertWritableRepo("evil-repo"),
      /not in WRITE_REPOS allowlist.*Allowed:/,
    );
  });
});
