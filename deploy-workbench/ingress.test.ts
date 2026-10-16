import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { WORKBENCH_ZONE_NAME } from "./dns";
import {
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
    for (const group of TARGET_GROUPS) {
      assert.ok(
        group.name.length <= 32,
        `${group.name} is longer than 32 characters`,
      );
      assert.match(group.name, /^[a-zA-Z0-9-]+$/);
    }
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

  it("validates the certificate against the workbench zone", () => {
    // The validation record is a CNAME in the zone this stack owns, so a
    // missing zoneId (or a record created in the wrong zone) would leave the
    // certificate pending forever.
    assert.ok(
      INGRESS_SOURCE.includes("zoneId: zone.zoneId"),
      "ingress.ts does not create the validation record and alias in the workbench zone",
    );
    assert.ok(
      INGRESS_SOURCE.includes("validationRecordFqdns: [validationRecord.fqdn]"),
      "the certificate validation must reference the record's fqdn, or Pulumi can create the listener before ACM has validated",
    );
  });
});
