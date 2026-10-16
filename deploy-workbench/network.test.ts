import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AVAILABILITY_ZONES,
  BIFROST_PORT,
  DATABASE_SUBNET_GROUP_NAME,
  HTTP_PORT,
  HTTPS_PORT,
  OAUTH2_PROXY_PORT,
  POSTGRES_PORT,
  REGION,
  SUBNETS,
  VPC_CIDR,
} from "./network";

/**
 * The network module's constants, checked without standing up a Pulumi
 * resource. The resources themselves are exercised by the CI `pulumi preview`
 * on the pull request; what a unit test can usefully pin is the layout and the
 * port numbers the security groups, the task definition and the target groups
 * all have to agree on.
 */

const ipToInt = (ip: string): number =>
  ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);

const cidrRange = (cidr: string) => {
  const [ip, bits] = cidr.split("/");
  const prefix = Number(bits);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = (ipToInt(ip) & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  return { start, end: start + size - 1, prefix };
};

const overlaps = (
  a: { start: number; end: number },
  b: { start: number; end: number },
) => a.start <= b.end && b.start <= a.end;

describe("workbench network layout", () => {
  it("pins the region the workbench SCP permits", () => {
    assert.equal(REGION, "us-west-2");
  });

  it("uses a /16 VPC with one /24 per subnet, all inside the VPC", () => {
    const vpc = cidrRange(VPC_CIDR);
    assert.equal(vpc.prefix, 16, `${VPC_CIDR} is not a /16`);

    const subnets = [
      ...SUBNETS.map((s) => s.publicCidr),
      ...SUBNETS.map((s) => s.privateCidr),
    ];
    assert.equal(subnets.length, 4);

    for (const cidr of subnets) {
      const range = cidrRange(cidr);
      assert.equal(range.prefix, 24, `${cidr} is not a /24`);
      assert.ok(
        range.start >= vpc.start && range.end <= vpc.end,
        `${cidr} is outside ${VPC_CIDR}`,
      );
    }
  });

  it("has two public and two private subnets, one of each per AZ", () => {
    assert.equal(SUBNETS.length, 2);
    assert.deepEqual(
      SUBNETS.map((s) => s.az),
      [...AVAILABILITY_ZONES],
    );

    // Two distinct zones, so the ALB and the RDS subnet group both satisfy
    // their two-AZ requirement.
    assert.equal(new Set(SUBNETS.map((s) => s.az)).size, 2);
    // One public and one private CIDR per zone.
    assert.equal(new Set(SUBNETS.map((s) => s.publicCidr)).size, 2);
    assert.equal(new Set(SUBNETS.map((s) => s.privateCidr)).size, 2);
  });

  it("names the explicit zones, not discovered ones", () => {
    assert.deepEqual([...AVAILABILITY_ZONES], ["us-west-2a", "us-west-2b"]);
  });

  it("does not overlap any two subnet CIDRs", () => {
    const ranges = [
      ...SUBNETS.map((s) => s.publicCidr),
      ...SUBNETS.map((s) => s.privateCidr),
    ].map(cidrRange);

    for (let i = 0; i < ranges.length; i += 1) {
      for (let j = i + 1; j < ranges.length; j += 1) {
        assert.ok(
          !overlaps(ranges[i], ranges[j]),
          `${ranges[i]} overlaps ${ranges[j]}`,
        );
      }
    }
  });

  it("pins the container and database ports the later items reference", () => {
    assert.equal(BIFROST_PORT, 8080);
    assert.equal(OAUTH2_PROXY_PORT, 4180);
    assert.equal(POSTGRES_PORT, 5432);
    assert.equal(HTTP_PORT, 80);
    assert.equal(HTTPS_PORT, 443);
  });

  it("names the DB subnet group item 7 will reference", () => {
    assert.equal(DATABASE_SUBNET_GROUP_NAME, "bifrost-db");
  });
});
