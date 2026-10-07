import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt, REVIEW_OUTPUT_JSON_SCHEMA } from "./pr-reviewer";
import type { Bundle } from "../review/schema";

const baseBundle: Bundle = {
  repo: "thegoodparty/gp-api",
  prNumber: 42,
  baseRef: "develop",
  baseSha: "aabbcc",
  headSha: "ddeeff",
  author: "swain",
  title: "Add null check",
  body: "Fixes the null thing",
  diff: "@@ -1,3 +1,4 @@\n const x = 1;\n+if (!x) return;\n",
  changedFiles: ["src/foo.ts", "src/bar.ts"],
  priorFindings: [],
};

describe("buildReviewPrompt", () => {
  it("wraps title and body in <untrusted> tags", () => {
    const prompt = buildReviewPrompt(baseBundle);
    assert.ok(
      prompt.includes("<title><untrusted>Add null check</untrusted></title>"),
      "title must be wrapped in <untrusted>",
    );
    assert.ok(
      prompt.includes("<body><untrusted>Fixes the null thing</untrusted></body>"),
      "body must be wrapped in <untrusted>",
    );
  });

  it("includes the diff", () => {
    const prompt = buildReviewPrompt(baseBundle);
    assert.ok(
      prompt.includes("@@ -1,3 +1,4 @@"),
      "diff content must appear in the prompt",
    );
  });

  it("includes prior findings as <finding> elements", () => {
    const bundle: Bundle = {
      ...baseBundle,
      priorFindings: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          path: "src/foo.ts",
          line: 10,
          body: "Null not handled here.",
          category: "bugs",
          headSha: "aabbcc",
        },
      ],
    };
    const prompt = buildReviewPrompt(bundle);
    assert.ok(
      prompt.includes('id="11111111-1111-1111-1111-111111111111"'),
      "prior finding id must appear",
    );
    assert.ok(
      prompt.includes('path="src/foo.ts"'),
      "prior finding path must appear",
    );
    assert.ok(
      prompt.includes("Null not handled here."),
      "prior finding body must appear",
    );
  });

  it("emits empty <prior_findings> block when there are none", () => {
    const prompt = buildReviewPrompt(baseBundle);
    assert.ok(prompt.includes("<prior_findings>"), "prior_findings block must exist");
    assert.ok(prompt.includes("</prior_findings>"), "prior_findings closing tag must exist");
  });

  it("includes changed_files", () => {
    const prompt = buildReviewPrompt(baseBundle);
    assert.ok(prompt.includes("src/foo.ts"), "changed files must appear");
    assert.ok(prompt.includes("src/bar.ts"), "changed files must appear");
  });
});

describe("REVIEW_OUTPUT_JSON_SCHEMA", () => {
  it("is a plain object (JSON Schema)", () => {
    assert.equal(typeof REVIEW_OUTPUT_JSON_SCHEMA, "object");
    assert.notEqual(REVIEW_OUTPUT_JSON_SCHEMA, null);
  });

  it("discriminates on status with complete and failed branches", () => {
    const schema = REVIEW_OUTPUT_JSON_SCHEMA as Record<string, unknown>;
    const branches = (schema["oneOf"] ?? schema["anyOf"]) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(branches), "schema must have oneOf or anyOf branches");
    assert.equal(branches.length, 2, "must have exactly two branches");

    const statuses = branches.map((b) => {
      const props = b["properties"] as Record<string, Record<string, unknown>>;
      return props?.["status"]?.["const"];
    });

    assert.ok(statuses.includes("complete"), "must have a complete branch");
    assert.ok(statuses.includes("failed"), "must have a failed branch");
  });
});

it("buildReviewPrompt references a diff file instead of inlining when asked", () => {
  const bundle: Bundle = {
    repo: "thegoodparty/ops", prNumber: 1, baseRef: "main", baseSha: "a", headSha: "b", author: "x",
    title: "t", body: "", diff: "diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n+b\n",
    changedFiles: ["f.ts"], priorFindings: [],
  };
  const prompt = buildReviewPrompt(bundle, { diffPath: "/app/review/.delegate-review/diff.patch" });
  assert.ok(prompt.includes('<diff path="/app/review/.delegate-review/diff.patch">'));
  assert.ok(!prompt.includes("+b\n"));
  assert.ok(prompt.includes("<diff_stat>"));
});
