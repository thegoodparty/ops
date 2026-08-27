import { describe, it } from "node:test";
import assert from "node:assert/strict";
import prReviewer from "./pr-reviewer";

describe("pr-reviewer permission gate", () => {
  it("names the permission paths it must never auto-approve", () => {
    const prompt = JSON.stringify(prReviewer);
    assert.match(prompt, /PERMISSION_CHANGE=false/);
    assert.match(prompt, /identity-center/);
    assert.match(prompt, /CODEOWNERS/);
  });

  it("still carries the original self-review gate", () => {
    const prompt = JSON.stringify(prReviewer);
    assert.match(prompt, /SELF_REVIEW/);
  });
});
