import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DATABASE_ALLOCATED_STORAGE_GB,
  DATABASE_BACKUP_RETENTION_DAYS,
  DATABASE_ENGINE,
  DATABASE_ENGINE_VERSION,
  DATABASE_IDENTIFIER,
  DATABASE_INSTANCE_CLASS,
  DATABASE_MAX_ALLOCATED_STORAGE_GB,
  DATABASE_NAME,
  DATABASE_STORAGE_TYPE,
} from "./rds";
import { POSTGRES_PORT } from "./network";

/**
 * The RDS module's constants and the properties of the instance it creates,
 * checked without standing up a Pulumi resource. The resources themselves are
 * exercised by the CI `pulumi preview` on the pull request; what a unit test
 * can usefully pin is the handful of properties a review is actually about —
 * single-AZ, encrypted, undeletable, backed up, private, and reachable on 5432
 * from the gateway's own security group and nothing else.
 *
 * The instance's own arguments are asserted against the source, the way
 * `ingress.test.ts` does it, because the resource cannot be constructed here
 * without a Pulumi runtime. The database security group and its ingress rule
 * are item 5's, in `network.ts`, so "the 5432 source" is asserted there.
 */

const RDS_SOURCE = fs.readFileSync(path.resolve(__dirname, "rds.ts"), "utf8");
const NETWORK_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "network.ts"),
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
const resourceBlock = (source: string, logicalName: string): string => {
  const marker = `"${logicalName}"`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `no resource named ${logicalName}`);
  const rest = source.slice(start);
  const next = rest.indexOf("new aws.", 1);
  return next >= 0 ? rest.slice(0, next) : rest;
};

const instanceBlock = (): string => resourceBlock(RDS_SOURCE, "bifrostDatabase");

describe("bifrost database", () => {
  it("is Postgres 16, the version upstream requires and runs", () => {
    // `docs/quickstart/gateway/setting-up.mdx` at the pinned tag: "The minimum
    // PostgreSQL version required is 16 or above", and the only Postgres
    // upstream's own guides run is the `postgres:16-alpine` in
    // `deployment-guides/docker-tuning.mdx`. Both stores (config and logs)
    // support it, which is the requirement.
    assert.equal(DATABASE_ENGINE, "postgres");
    assert.equal(DATABASE_ENGINE_VERSION, "16");
    const block = instanceBlock();
    assert.ok(block.includes("engine: DATABASE_ENGINE"), block);
    assert.ok(
      block.includes("engineVersion: DATABASE_ENGINE_VERSION"),
      block,
    );
  });

  it("starts at the smallest reasonable class and volume", () => {
    assert.equal(DATABASE_INSTANCE_CLASS, "db.t4g.micro");
    assert.equal(DATABASE_ALLOCATED_STORAGE_GB, 20);
    assert.equal(DATABASE_STORAGE_TYPE, "gp3");

    const block = instanceBlock();
    for (const expected of [
      "instanceClass: DATABASE_INSTANCE_CLASS",
      "allocatedStorage: DATABASE_ALLOCATED_STORAGE_GB",
      "storageType: DATABASE_STORAGE_TYPE",
    ]) {
      assert.ok(block.includes(expected), `bifrostDatabase omits ${expected}`);
    }
  });

  it("is single-AZ, with Multi-AZ documented as a one-line change", () => {
    // The decision recorded in the plan's open questions: single-AZ with
    // backups, because the gateway is one Fargate task and Multi-AZ would
    // protect the database's availability, not the gateway's.
    assert.ok(
      instanceBlock().includes("multiAz: false"),
      "bifrostDatabase must be single-AZ",
    );
    // The plan's requirement that the flip be one line, documented in place,
    // so the next person does not have to reconstruct why it is off.
    const note = RDS_SOURCE.replace(/\s*\*\s*/g, " ");
    assert.ok(
      note.includes("Flipping it to true is the only change Multi-AZ needs"),
      "the single-AZ decision must carry the one-line Multi-AZ note",
    );
  });

  it("encrypts storage at rest", () => {
    assert.ok(
      instanceBlock().includes("storageEncrypted: true"),
      "bifrostDatabase must encrypt storage",
    );
  });

  it("cannot be deleted without a deliberate change", () => {
    const block = instanceBlock();
    assert.ok(
      block.includes("deletionProtection: true"),
      "bifrostDatabase must keep deletion protection on",
    );
    // Deleting it therefore takes a PR, which is also what makes the static
    // final snapshot identifier acceptable.
    assert.ok(block.includes("skipFinalSnapshot: false"));
    assert.ok(block.includes("finalSnapshotIdentifier:"));
  });

  it("keeps automated backups for a week", () => {
    assert.equal(DATABASE_BACKUP_RETENTION_DAYS, 7);
    assert.ok(
      instanceBlock().includes(
        "backupRetentionPeriod: DATABASE_BACKUP_RETENTION_DAYS",
      ),
      "bifrostDatabase must set backupRetentionPeriod",
    );
  });

  it("does not autoscale storage", () => {
    // Off on purpose, per the module's one-sentence justification: growing the
    // volume silently bills for capacity a retention setting could reclaim.
    assert.equal(DATABASE_MAX_ALLOCATED_STORAGE_GB, 0);
    assert.ok(
      instanceBlock().includes(
        "maxAllocatedStorage: DATABASE_MAX_ALLOCATED_STORAGE_GB",
      ),
      "bifrostDatabase must state that storage autoscaling is off",
    );
  });

  it("is not publicly accessible", () => {
    assert.ok(
      instanceBlock().includes("publiclyAccessible: false"),
      "bifrostDatabase must not be publicly accessible",
    );
  });

  it("uses the RDS-managed master password, not a hand-populated one", () => {
    const block = instanceBlock();
    assert.ok(
      block.includes("manageMasterUserPassword: true"),
      "bifrostDatabase must let RDS own the master password",
    );
    // A `password` alongside the managed one is rejected by RDS and would mean
    // a human typed a credential somewhere in the first place.
    assert.ok(
      !/\bpassword:/.test(block),
      "bifrostDatabase must not take a password; RDS manages it",
    );
    // The ARN item 8 injects, resolved out of the list RDS models it as.
    assert.ok(
      RDS_SOURCE.includes("database.masterUserSecrets.apply"),
      "rds.ts must resolve the managed secret's ARN for item 8",
    );
    assert.ok(
      INDEX_SOURCE.includes("bifrostDatabaseSecretArn"),
      "index.ts must export the managed secret's ARN",
    );
  });

  it("is private: the subnet group and the task-only security group are item 5's", () => {
    const block = instanceBlock();
    assert.ok(
      block.includes("dbSubnetGroupName: network.databaseSubnetGroup.name"),
      "bifrostDatabase must use the item 5 DB subnet group",
    );
    assert.ok(
      block.includes(
        "vpcSecurityGroupIds: [network.databaseSecurityGroup.id]",
      ),
      "bifrostDatabase must use the item 5 database security group",
    );
    // The subnet group spans both private subnets, which is what RDS requires
    // and what makes Multi-AZ a one-line change later.
    assert.ok(
      resourceBlock(NETWORK_SOURCE, "workbenchDatabaseSubnetGroup").includes(
        "subnetIds: privateSubnets.map",
      ),
      "the DB subnet group must span the private subnets",
    );
  });

  it("admits 5432 from the gateway's security group and nothing else", () => {
    const ingressRule = resourceBlock(
      NETWORK_SOURCE,
      "bifrostDatabaseIngressPostgres",
    );
    assert.ok(
      ingressRule.includes("fromPort: POSTGRES_PORT") &&
        ingressRule.includes("toPort: POSTGRES_PORT"),
      "the database ingress rule must be the Postgres port",
    );
    assert.equal(POSTGRES_PORT, 5432);
    assert.ok(
      ingressRule.includes(
        "referencedSecurityGroupId: taskSecurityGroup.id",
      ),
      "the only source allowed to reach 5432 must be the task security group",
    );
    assert.ok(
      !ingressRule.includes("cidrIpv4"),
      "the database ingress rule must not admit a CIDR",
    );
    // Exactly one ingress rule exists for the database group: a second one
    // would be a source nobody reviewed, and the assertion above would still
    // pass because it only reads the named block.
    assert.equal(
      NETWORK_SOURCE.match(/securityGroupId: databaseSecurityGroup\.id,/g)
        ?.length,
      1,
      "the database security group must have exactly one ingress rule",
    );
  });

  it("has an identifier RDS accepts", () => {
    assert.match(DATABASE_IDENTIFIER, /^[a-z][a-z0-9-]{0,62}$/);
    assert.equal(DATABASE_NAME, "bifrost");
  });

  it("is wired into index.ts with the item 5 network", () => {
    assert.ok(
      INDEX_SOURCE.includes("createBifrostDatabase"),
      "index.ts does not create the database",
    );
    assert.ok(
      INDEX_SOURCE.includes("network,"),
      "index.ts does not pass the item 5 network to the database",
    );
  });
});
