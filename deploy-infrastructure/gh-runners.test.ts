import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildDispatchCode,
  CLUSTER_NAME,
  imageTag,
  instanceUserData,
  RUNNER_CONTAINER,
} from "./gh-runners";

const ROOT = path.resolve(__dirname, "../gh-runners");

describe("gh-runners image tags", () => {
  it("are stable", () => {
    assert.match(imageTag("runner"), /^[0-9a-f]{16}$/);
    assert.equal(imageTag("runner"), imageTag("runner"));
  });

  // The workflow pushes under the tag this prints. If the script stops
  // calling imageTag, CI pushes one tag and the task definition names another.
  it("are what push-images.sh pushes", () => {
    const script = fs.readFileSync(path.join(ROOT, "push-images.sh"), "utf8");
    assert.ok(
      script.includes("require('./deploy-infrastructure/gh-runners').imageTag"),
    );
  });
});

describe("gh-runners hosts", () => {
  it("join the runner cluster", () => {
    assert.ok(instanceUserData().includes(`ECS_CLUSTER=${CLUSTER_NAME}`));
  });
});

describe("gh-runners dispatch", () => {
  it("bundles the handler", () => {
    assert.ok(buildDispatchCode());
  });

  // The handler overrides env on a container by name, so the task definition
  // and the handler must agree.
  it("targets the runner container by its task definition name", () => {
    const handler = fs.readFileSync(
      path.join(__dirname, "gh-runners-dispatch/handler.ts"),
      "utf8",
    );
    assert.ok(handler.includes(`name: "${RUNNER_CONTAINER}"`));
  });
});
