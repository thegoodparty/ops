import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AGENT_UID, WORK_MOUNT_PATH } from "./components/bugboss";
import { DEFAULT_WORK_ROOT } from "../bugboss/agent/workspace";

// The EFS access point writes every file as AGENT_UID and the task mounts the
// volume at WORK_MOUNT_PATH. Neither is checked by AWS against the image, so a
// drift here deploys cleanly and then fails every incident at checkout.
describe("the BugBoss work volume", () => {
  it("is mounted where the agent keeps its workspaces", () => {
    assert.equal(WORK_MOUNT_PATH, DEFAULT_WORK_ROOT);
  });

  it("writes as the user the image runs agents as", () => {
    const dockerfile = readFileSync(join(__dirname, "..", "bugboss", "Dockerfile"), "utf8");
    assert.match(dockerfile, new RegExp(`adduser -D -u ${AGENT_UID} .*agent`));
    assert.match(dockerfile, /^USER agent$/m);
  });
});
