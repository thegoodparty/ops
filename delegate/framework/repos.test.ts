import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WRITE_REPOS, isWritableRepo, assertWritableRepo } from "./repos";

describe("WRITE_REPOS", () => {
  it("contains the expected initial allowlist", () => {
    assert.deepEqual([...WRITE_REPOS].sort(), [
      "ai-rules",
      "campaign-plan-service",
      "candidate-sites",
      "election-api",
      "gp-ai-projects",
      "gp-api",
      "gp-data-loader",
      "gp-data-matcha",
      "gp-data-platform",
      "gp-sdk",
      "gp-webapp",
      "people-api",
      "runbooks",
    ]);
  });
});

describe("isWritableRepo", () => {
  it("returns true for repos in the allowlist", () => {
    assert.equal(isWritableRepo("gp-api"), true);
    assert.equal(isWritableRepo("runbooks"), true);
  });

  it("returns false for repos not in the allowlist", () => {
    assert.equal(isWritableRepo("ops"), false);
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
