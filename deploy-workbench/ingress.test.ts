import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { WORKBENCH_ZONE_NAME } from "./dns";
import {
  ALB_IDLE_TIMEOUT_SECONDS,
  BIFROST_ALB_NAME,
  BIFROST_HEALTH_CHECK_PATH,
  BIFROST_HOSTNAME,
  BIFROST_TARGET_GROUP_NAME,
  OAUTH2_PROXY_HEALTH_CHECK_PATH,
  OAUTH2_PROXY_TARGET_GROUP_NAME,
  TARGET_GROUPS,
  TLS_POLICY,
} from "./ingress";
import {
  BIFROST_PORT,
  HTTP_PORT,
  HTTPS_PORT,
  OAUTH2_PROXY_PORT,
} from "./network";

/**
 * The ingress module's constants, checked without standing up a Pulumi
 * resource. The resources themselves are exercised by the CI `pulumi preview`
 * on the pull request; what a unit test can usefully pin is the name, the two
 * target group ports and health checks, and the wiring back into `index.ts`
 * and `network.ts` that the plan depends on.
 */

const INGRESS_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "ingress.ts"),
  "utf8",
);
const INDEX_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "index.ts"),
  "utf8",
);

/**
 * The source of one named resource's constructor call, from its logical-name
 * literal to the next `new aws.` (or the end of the file). Enough to tell
 * whether an argument belongs to that resource rather than a sibling, which a
 * bare `includes` on the whole file cannot.
 */
const resourceBlock = (logicalName: string): string => {
  const marker = `"${logicalName}"`;
  const start = INGRESS_SOURCE.indexOf(marker);
  assert.ok(start >= 0, `ingress.ts has no resource named ${logicalName}`);
  const rest = INGRESS_SOURCE.slice(start);
  const next = rest.indexOf("new aws.", 1);
  return next >= 0 ? rest.slice(0, next) : rest;
};

describe("bifrost ingress", () => {
  it("names the gateway under the delegated workbench zone", () => {
    assert.equal(BIFROST_HOSTNAME, "bifrost.workbench.goodparty.org");
    // Derived, not spelled twice: a zone rename must move the record with it.
    assert.equal(BIFROST_HOSTNAME, `bifrost.${WORKBENCH_ZONE_NAME}`);
  });

  it("has one target group per container, with the upstream health checks", () => {
    assert.deepEqual(
      TARGET_GROUPS.map((group) => ({
        name: group.name,
        port: group.port,
        path: group.healthCheckPath,
      })),
      [
        { name: "bifrost", port: BIFROST_PORT, path: "/health" },
        {
          name: "bifrost-oauth2-proxy",
          port: OAUTH2_PROXY_PORT,
          path: "/ping",
        },
      ],
    );
    assert.equal(BIFROST_TARGET_GROUP_NAME, "bifrost");
    assert.equal(OAUTH2_PROXY_TARGET_GROUP_NAME, "bifrost-oauth2-proxy");
    assert.equal(BIFROST_HEALTH_CHECK_PATH, "/health");
    assert.equal(OAUTH2_PROXY_HEALTH_CHECK_PATH, "/ping");
  });

  it("listens on the ports item 5 pinned for the listeners", () => {
    assert.equal(HTTP_PORT, 80);
    assert.equal(HTTPS_PORT, 443);
  });

  it("takes the target group ports from network.ts rather than a second copy", () => {
    // The port literals live in network.ts; this module must import them, or
    // the target group and the security group that admits the ALB would agree
    // only by coincidence.
    for (const name of [
      "BIFROST_PORT",
      "OAUTH2_PROXY_PORT",
      "HTTP_PORT",
      "HTTPS_PORT",
    ]) {
      assert.ok(
        INGRESS_SOURCE.includes(name),
        `ingress.ts does not reference ${name} from network.ts`,
      );
    }
  });

  it("keeps the ALB and target group names inside AWS's 32-character limit", () => {
    assert.ok(BIFROST_ALB_NAME.length <= 32, BIFROST_ALB_NAME);
    assert.match(BIFROST_ALB_NAME, /^[a-zA-Z0-9-]+$/);
    for (const group of TARGET_GROUPS) {
      assert.ok(
        group.name.length <= 32,
        `${group.name} is longer than 32 characters`,
      );
      assert.match(group.name, /^[a-zA-Z0-9-]+$/);
    }
  });

  it("sets an ALB idle timeout long enough for time-to-first-token", () => {
    // AWS's default is 60 seconds, which a thinking model can exceed before
    // its first token; the ALB would then 504 the request.
    assert.equal(ALB_IDLE_TIMEOUT_SECONDS, 3600);
    assert.ok(ALB_IDLE_TIMEOUT_SECONDS > 60);
    // The ALB's maximum, so a future edit cannot set something AWS rejects.
    assert.ok(ALB_IDLE_TIMEOUT_SECONDS <= 4000);
    assert.ok(
      INGRESS_SOURCE.includes("idleTimeout: ALB_IDLE_TIMEOUT_SECONDS"),
      "the ALB must set idleTimeout from ALB_IDLE_TIMEOUT_SECONDS",
    );
  });

  it("raises the listener TLS floor above the provider default", () => {
    assert.equal(TLS_POLICY, "ELBSecurityPolicy-TLS13-1-2-2021-06");
  });

  it("is wired into index.ts with the network and the zone", () => {
    assert.ok(
      INDEX_SOURCE.includes("createBifrostIngress"),
      "index.ts does not create the ingress",
    );
    assert.ok(
      INDEX_SOURCE.includes("zone: workbenchZone"),
      "index.ts does not pass the workbench zone to the ingress",
    );
    assert.ok(
      INDEX_SOURCE.includes("network,"),
      "index.ts does not pass the item 5 network to the ingress",
    );
  });

  it("fails closed: the HTTPS default action points at oauth2-proxy, not Bifrost", () => {
    // Until item 9 adds the inference-prefix rule, the default reaches a
    // target group with no registered targets (503) instead of exposing
    // Bifrost's admin surface as soon as item 8 registers the ECS task.
    const httpsBlock = resourceBlock("bifrostHttpsListener");
    assert.ok(
      httpsBlock.includes("targetGroupArn: oauth2ProxyTargetGroup.arn"),
      "the HTTPS listener default action must forward to oauth2-proxy",
    );
    assert.ok(
      !httpsBlock.includes("targetGroupArn: bifrostTargetGroup.arn"),
      "the HTTPS listener default action must not forward to Bifrost before item 9 adds the inference rule",
    );
  });

  it("pins both Route 53 records to the workbench zone", () => {
    // Assert each named resource's own argument block, not a bare substring:
    // a whole-file `includes` would still pass if the validation record dropped
    // the zone and only the alias kept it, and a validation record in the wrong
    // zone leaves the certificate pending forever.
    for (const logicalName of [
      "bifrostCertificateValidationRecord",
      "bifrostAliasRecord",
    ]) {
      assert.ok(
        resourceBlock(logicalName).includes("zoneId: zone.zoneId"),
        `${logicalName} is not created in the workbench zone`,
      );
    }
    assert.ok(
      INGRESS_SOURCE.includes("validationRecordFqdns: [validationRecord.fqdn]"),
      "the certificate validation must reference the record's fqdn, or Pulumi can create the listener before ACM has validated",
    );
  });
});
