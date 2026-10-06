import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./gates";
import type { Finding } from "./schema";

const finding: Finding = {
  path: "src/a.ts",
  line: 3,
  body: "bug",
  category: "bugs",
  confidence: "high",
};

describe("decide", () => {
  it("approves when there are no findings", () => {
    const d = decide({ status: "complete", findings: [], summary: "clean" });
    assert.deepEqual(d, { verdict: "approve", action: "approve", gates: [] });
  });

  it("comments when any finding exists", () => {
    const d = decide({ status: "complete", findings: [finding], summary: "one bug" });
    assert.deepEqual(d, { verdict: "comment", action: "comment", gates: [] });
  });
});
