import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  BIFROST_DISCOVERY_DNS_NAME,
  BIFROST_DISCOVERY_NAMESPACE,
  BIFROST_DISCOVERY_SERVICE_NAME,
  BIFROST_DISCOVERY_TTL_SECONDS,
} from "./discovery";
import { vkMintEnvironment } from "./bifrost-vk-mint";

/**
 * The private name the vk-mint Lambda uses to reach the task, and the one line
 * in `ecs.ts` that keeps it pointing at the running task.
 *
 * Step 3 of `docs/bifrost-virtual-keys.md` says the function calls the task on
 * 8080 directly; the design does not name an address, and the task's ENI IP
 * changes on every replacement. `discovery.ts` argues for Cloud Map over the
 * alternatives; these tests hold the name, the record type and the
 * registration together, because a service discovery service that nothing
 * registers into is a name that resolves to nothing.
 */

const ECS_SOURCE = fs.readFileSync(path.resolve(__dirname, "ecs.ts"), "utf8");

describe("the gateway's private name", () => {
  it("is a name inside the VPC, not a public one", () => {
    assert.equal(BIFROST_DISCOVERY_NAMESPACE, "workbench.local");
    assert.equal(BIFROST_DISCOVERY_SERVICE_NAME, "bifrost");
    assert.equal(BIFROST_DISCOVERY_DNS_NAME, "bifrost.workbench.local");
    // A `.goodparty.org` name would resolve through public DNS to the ALB, and
    // `/api` there is behind oauth2-proxy.
    assert.ok(!BIFROST_DISCOVERY_DNS_NAME.includes("goodparty.org"));
  });

  it("keeps the TTL short, because a replacement changes the answer", () => {
    assert.equal(BIFROST_DISCOVERY_TTL_SECONDS, 10);
    assert.ok(BIFROST_DISCOVERY_TTL_SECONDS <= 30);
  });

  it("is what the mint's environment points at", () => {
    assert.equal(
      vkMintEnvironment().BIFROST_BASE_URL,
      `http://${BIFROST_DISCOVERY_DNS_NAME}:8080`,
    );
  });

  it("is registered by the ECS service, so the record follows the task", () => {
    assert.match(ECS_SOURCE, /serviceRegistries:\s*\{\s*registryArn:\s*discovery\.service\.arn\s*\}/);
  });
});
