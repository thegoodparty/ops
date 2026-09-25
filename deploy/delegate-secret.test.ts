import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DELEGATE_SECRET_KEYS,
  diffDelegateSecretKeys,
} from "./delegate-secret";

describe("diffDelegateSecretKeys", () => {
  it("reports nothing when the live secret matches the declared list", () => {
    assert.deepEqual(diffDelegateSecretKeys([...DELEGATE_SECRET_KEYS]), {
      missing: [],
      extra: [],
    });
  });

  it("is insensitive to order", () => {
    assert.deepEqual(
      diffDelegateSecretKeys([...DELEGATE_SECRET_KEYS].reverse()),
      { missing: [], extra: [] }
    );
  });

  it("reports a declared key the live secret does not hold", () => {
    const actual = DELEGATE_SECRET_KEYS.filter(
      (key) => key !== "ANTHROPIC_API_KEY"
    );
    assert.deepEqual(diffDelegateSecretKeys([...actual]), {
      missing: ["ANTHROPIC_API_KEY"],
      extra: [],
    });
  });

  it("reports a live key that is not declared", () => {
    assert.deepEqual(
      diffDelegateSecretKeys([...DELEGATE_SECRET_KEYS, "LEFTOVER_KEY"]),
      { missing: [], extra: ["LEFTOVER_KEY"] }
    );
  });
});
