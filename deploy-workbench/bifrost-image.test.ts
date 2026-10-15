import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BIFROST_REPOSITORY_NAME,
  BIFROST_UPSTREAM_DIGEST,
  BIFROST_UPSTREAM_REPOSITORY,
  BIFROST_UPSTREAM_TAG,
} from "./bifrost-image";

const WORKFLOW = path.resolve(
  __dirname,
  "../.github/workflows/deploy-workbench.yml",
);

describe("bifrost image pin", () => {
  it("pins an upstream tag and a sha256 digest", () => {
    assert.equal(BIFROST_UPSTREAM_REPOSITORY, "maximhq/bifrost");
    assert.equal(BIFROST_UPSTREAM_TAG, "v2.3.0");
    assert.match(BIFROST_UPSTREAM_DIGEST, /^sha256:[0-9a-f]{64}$/);
  });

  it("mirrors into the repository the stack creates", () => {
    assert.equal(BIFROST_REPOSITORY_NAME, "bifrost");
  });

  // The workflow hardcodes the upstream reference because Actions cannot
  // import a TypeScript module. Without this check a digest bump that touched
  // only one of the two would look applied and silently keep running the old
  // image.
  it("pulls the same tag and digest the workflow mirrors", () => {
    const workflow = fs.readFileSync(WORKFLOW, "utf8");
    assert.ok(
      workflow.includes(
        `${BIFROST_UPSTREAM_REPOSITORY}:${BIFROST_UPSTREAM_TAG}@${BIFROST_UPSTREAM_DIGEST}`,
      ),
      "deploy-workbench.yml must pin the same upstream image as bifrost-image.ts",
    );
  });
});
