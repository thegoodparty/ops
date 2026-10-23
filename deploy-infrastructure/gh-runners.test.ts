import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CLUSTER_NAME,
  imageTag,
  instanceUserData,
  RUNNER_CONTAINER,
} from "./gh-runners";

const ROOT = path.resolve(__dirname, "../gh-runners");

describe("gh-runners image tags", () => {
  it("are stable and distinct per image", () => {
    assert.match(imageTag("runner"), /^[0-9a-f]{16}$/);
    assert.equal(imageTag("runner"), imageTag("runner"));
    assert.notEqual(imageTag("runner"), imageTag("scaler"));
  });

  // The workflow pushes under the tag this prints. If the script stops
  // calling imageTag, CI pushes one tag and the task definition names another.
  it("are what push-images.sh pushes", () => {
    const script = fs.readFileSync(path.join(ROOT, "push-images.sh"), "utf8");
    assert.ok(script.includes("imageTag"));
  });
});

describe("gh-runners hosts", () => {
  it("join the runner cluster", () => {
    assert.ok(instanceUserData().includes(`ECS_CLUSTER=${CLUSTER_NAME}`));
  });
});

describe("gh-runners scaler contract", () => {
  // The scaler overrides env on a container by name, so the task definition
  // and the scaler's default must agree.
  it("targets the runner container by its task definition name", () => {
    const main = fs.readFileSync(path.join(ROOT, "scaler/main.go"), "utf8");
    assert.ok(main.includes(`"${RUNNER_CONTAINER}"`));
  });
});
