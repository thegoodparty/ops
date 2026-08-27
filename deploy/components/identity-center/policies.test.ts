import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXPECTED: Record<string, string> = {
  "engineer-access.json":
    "8eb20244b8b3848bc44a6869ae5cb2c9be649eeb26e79d425eb82b235cd02b6c",
  "product-manager.json":
    "e131860e532768dabf16fb518da04e5948723bbe1a7276d9e650996f14059eaf",
  "read-only-access.json":
    "98e54d03d87835021f6fb3819f0cedc391a7bd23633d2a43aa27ab86f7b9127b",
};

// A failure here means a fixture was reformatted. Restore the file from live
// state; never update the hash to match — the import compares bytes verbatim.
describe("inline policy fixtures", () => {
  for (const [file, sha] of Object.entries(EXPECTED)) {
    it(`${file} still matches live Identity Center byte for byte`, () => {
      const body = readFileSync(join(__dirname, "policies", file));
      assert.equal(createHash("sha256").update(body).digest("hex"), sha);
    });
  }
});
