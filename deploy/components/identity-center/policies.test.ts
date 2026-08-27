import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Hashes of the canonical form, not the raw bytes. The AWS provider parses
// `inlinePolicy` as JSON rather than comparing it as a string, so whitespace
// is free to change and only a semantic change should fail this test.
const canonicalize = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonicalize)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonicalize(v)]),
        )
      : value;

const canonicalSha = (file: string) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize(
          JSON.parse(readFileSync(join(__dirname, "policies", file), "utf8")),
        ),
      ),
    )
    .digest("hex");

const EXPECTED: Record<string, string> = {
  "engineer-access.json": "cc7172c285b5d4d5fa2fcb2f43d622accfa5ea157811d0dd8650279de0531fe4",
  "product-manager.json": "8c3cd11b0aef464abdb67e2ebe83785b127e537f55554c7953775f15c2fa8098",
  "read-only-access.json": "4573a1b22bb61fc1ec33293df9f9b943f792505e41f0fd08f740aa5768e46dd0",
};

describe("inline policy fixtures", () => {
  for (const [file, sha] of Object.entries(EXPECTED)) {
    it(`${file} still expresses the policy it was captured with`, () => {
      assert.equal(
        canonicalSha(file),
        sha,
        `${file} changed meaning, not just formatting. If that was intentional (a deliberate policy edit), update the hash. If not, restore the file from live Identity Center.`,
      );
    });
  }
});
