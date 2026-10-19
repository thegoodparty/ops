import * as aws from "@pulumi/aws";
import { createWorkbenchNetwork } from "./network";

/**
 * The Postgres instance Bifrost keeps its `config_store` and `logs_store` in.
 * Phase 1 item 7 of `docs/bifrost-gateway.md`; "State: RDS Postgres" and the
 * "Persistence, backup and upgrade" section are the requirements this file
 * implements, and the open questions carry the decisions review settled.
 *
 * What this module owns, and what it deliberately leaves to later items:
 *
 * - Owns: the DB instance and the two outputs item 8 needs from it, the
 *   endpoint and the ARN of the Secrets Manager secret holding the master
 *   password.
 * - Does not own: the DB subnet group, the database security group and the
 *   5432 ingress rule. Item 5 put all three in `network.ts`, because they are
 *   network facts and because the instance cannot be created without them, so
 *   this file consumes them from the object the network module returns rather
 *   than creating a second subnet group or a second group with the same rule.
 *   Nothing is added to `network.ts` here.
 * - Does not own: the ECS task definition, the service, the `secrets`
 *   injection or the read grant on the secret below. Those are items 8 and 9.
 *   Until they land the database is created and consumed by nothing, which is
 *   the intended staging: the SCP relaxation (phase 0 item 1) has to be
 *   applied before this can create anything, and the instance is the one
 *   resource in this plan that an apply cannot take back cheaply.
 *
 * Everything takes the explicit provider this project requires. The workbench
 * stack disables the default provider (`deploy.sh`), so a resource that omits
 * `{ provider }` fails the apply rather than landing in the management account.
 */

/**
 * The network phase 1 item 5 created. The subnet group and the security group
 * come from here; the shape is imported so the two cannot drift.
 */
type WorkbenchNetwork = ReturnType<typeof createWorkbenchNetwork>;

/**
 * The instance identifier. Lowercase and hyphenated because RDS rejects
 * anything else, account-unique within the region, and the name a human types
 * into `aws rds describe-db-instances` when the plan's restore procedure is
 * being followed.
 */
export const DATABASE_IDENTIFIER = "bifrost-db";

/**
 * The database and the master user Bifrost connects as.
 *
 * Both are upstream's own example values in
 * `docs/deployment-guides/config-json/storage.mdx` (`db_name: "bifrost"`,
 * `user: env.PG_USER`), so the non-secret half of the connection string is the
 * one the documentation shows. The password is not here at all: see
 * `manageMasterUserPassword` below.
 *
 * The master user is the one Bifrost runs its startup migrations as, which
 * needs `CREATE` on the schema; that is why this is the master user and not a
 * second, narrower application role. Bifrost does not document a split role,
 * and inventing one here would be a permission model nothing else in the
 * deployment knows about.
 */
export const DATABASE_NAME = "bifrost";
export const DATABASE_USERNAME = "bifrost";

/**
 * PostgreSQL 16, upstream's stated minimum and the version upstream itself
 * runs.
 *
 * `docs/quickstart/gateway/setting-up.mdx` at the pinned tag
 * (`transports/v2.3.0`) says, of both stores: "The minimum PostgreSQL version
 * required is 16 or above." The only Postgres upstream exercises in its own
 * deployment guides is 16 — `docs/deployment-guides/docker-tuning.mdx` pins
 * `postgres:16-alpine` for the production multi-node example — so 16 is the
 * version this repo can point at having been run, and 17 would be a version
 * Bifrost documents as supported but never runs in its own examples. There is
 * nothing in the store schema that wants a 17 feature.
 *
 * The major version only, not `16.9`. RDS then creates the current default
 * minor for that major and `autoMinorVersionUpgrade` (the provider's default,
 * left alone) keeps it patched, which is the "RDS engine upgrades follow RDS's
 * own version windows" rule from the plan. Pinning a minor here would mean a
 * one-line PR every few months for a patch version, and a pinned minor can
 * silently stop being creatable.
 */
export const DATABASE_ENGINE = "postgres";
export const DATABASE_ENGINE_VERSION = "16";

/**
 * `db.t4g.micro` — the smallest ARM instance RDS offers, and the plan's "start
 * as small as reasonable".
 *
 * The workload is one engineer's gateway configuration and its request
 * metadata; the plan's own sizing argument for the task ("Bifrost adds
 * microseconds of overhead and the load is per-engineer") applies twice over
 * here. Burstable is the right family for a database that is idle most of the
 * working day, and the class is a one-line change when the logs store outgrows
 * it — that change is a reboot, not a migration.
 */
export const DATABASE_INSTANCE_CLASS = aws.rds.InstanceType.T4G_Micro;

/**
 * 20 GiB gp3, and storage autoscaling deliberately off.
 *
 * 20 GiB is RDS's minimum for gp3, which is the smallest the decision allows
 * and several times what a config store and seven days of metadata-only request
 * records occupy. gp3 rather than gp2 because it is the current generation,
 * cheaper per GiB, and its baseline IOPS do not depend on volume size.
 *
 * `maxAllocatedStorage: 0` is the provider's spelling for "no autoscaling". It
 * stays off because autoscaling raises the storage bill on its own schedule
 * without telling anyone, and a logs store that outgrows 20 GiB is a signal to
 * shorten `logs_store.retention_days` or move logs to ClickHouse (both are
 * configuration) rather than to buy disk.
 */
export const DATABASE_ALLOCATED_STORAGE_GB = 20;
export const DATABASE_STORAGE_TYPE = aws.rds.StorageType.GP3;
export const DATABASE_MAX_ALLOCATED_STORAGE_GB = 0;

/**
 * Seven days of automated backups.
 *
 * This is a restore window, not an archive: the plan's backup rule is
 * "snapshot before an upgrade, rehearse the restore", and seven days covers a
 * long weekend plus the working week in which someone would notice a bad
 * migration. RDS's maximum is 35 and the number is a one-line change if the
 * cost history ever needs to live in the database rather than in the backups.
 *
 * The bucket of truth for gateway configuration is `config.json` in git and
 * the provider keys in Secrets Manager; neither is in a snapshot. What the
 * snapshot protects is the config store's UI-created rows and the request log.
 */
export const DATABASE_BACKUP_RETENTION_DAYS = 7;

/**
 * The snapshot RDS takes when the instance is deleted.
 *
 * Deletion protection means this only fires after someone has deliberately
 * turned protection off in a PR, which is the intent: destroying the store
 * should cost a reviewed change and leave a snapshot behind. The identifier is
 * static, so deleting and recreating the instance twice would collide on the
 * second teardown; rename it in that PR rather than making the identifier
 * time-based, which would show a diff on every refresh.
 */
export const DATABASE_FINAL_SNAPSHOT_IDENTIFIER = "bifrost-db-final";

export const createBifrostDatabase = (args: {
  provider: aws.Provider;
  network: WorkbenchNetwork;
}) => {
  const { provider, network } = args;

  /**
   * The instance.
   *
   * The properties worth reading twice, because each is a deliberate answer to
   * something in the plan rather than a provider default:
   *
   * - `multiAz: false`. Single-AZ with backups, per the decision recorded in
   *   the plan's open questions. Flipping it to true is the only change
   *   Multi-AZ needs — the subnet group already spans both private subnets,
   *   which is what RDS requires for a standby.
   * - `storageEncrypted: true`, with no `kmsKeyId`. That is the AWS-managed
   *   `aws/rds` key, which is in every account and needs no policy, rotation or
   *   grant to maintain. A customer-managed key buys control nothing here
   *   currently uses; if the plan ever needs to revoke access to the snapshots
   *   independently of the account, this is the property to change.
   * - `manageMasterUserPassword: true` and no `password`. RDS generates the
   *   master password, stores it in a Secrets Manager secret it owns, and
   *   rotates it; nothing in this repo, and no human, ever knows the value.
   *   That is the decision review settled — the alternative, a secret a person
   *   populates, is a credential that has to be typed somewhere. The secret's
   *   ARN is returned below for item 8 to inject as the task's `PG_PASSWORD`;
   *   because the rotation replaces the value in place, a rotated password
   *   reaches the task on its next start, which is also when Bifrost reads its
   *   environment.
   * - `publiclyAccessible: false`, explicitly, because it is the property a
   *   reviewer is looking for. The subnet group has no route to the internet
   *   gateway and the security group admits 5432 only from the task group, so
   *   this is the third layer of the same answer rather than the only one.
   * - `deletionProtection: true`. The instance holds the gateway's virtual
   *   keys, teams, budgets and log; an accidental `pulumi destroy` should be a
   *   refused API call, not a restore.
   * - `copyTagsToSnapshot: true`, so a snapshot is identifiable by the tags
   *   this project's provider applies without opening it.
   *
   * Left at the provider defaults on purpose: `autoMinorVersionUpgrade` (on,
   * per the engine-version comment above), the maintenance and backup windows
   * (RDS picks), and no custom parameter group — Bifrost requires TLS from its
   * side (`ssl_mode: "require"` in both stores), and forcing it at the server
   * as well would be a parameter-group resource for a client already doing it.
   */
  const database = new aws.rds.Instance(
    "bifrostDatabase",
    {
      identifier: DATABASE_IDENTIFIER,
      engine: DATABASE_ENGINE,
      engineVersion: DATABASE_ENGINE_VERSION,
      instanceClass: DATABASE_INSTANCE_CLASS,
      dbName: DATABASE_NAME,
      username: DATABASE_USERNAME,
      manageMasterUserPassword: true,
      allocatedStorage: DATABASE_ALLOCATED_STORAGE_GB,
      storageType: DATABASE_STORAGE_TYPE,
      storageEncrypted: true,
      maxAllocatedStorage: DATABASE_MAX_ALLOCATED_STORAGE_GB,
      multiAz: false,
      publiclyAccessible: false,
      dbSubnetGroupName: network.databaseSubnetGroup.name,
      vpcSecurityGroupIds: [network.databaseSecurityGroup.id],
      backupRetentionPeriod: DATABASE_BACKUP_RETENTION_DAYS,
      deletionProtection: true,
      copyTagsToSnapshot: true,
      skipFinalSnapshot: false,
      finalSnapshotIdentifier: DATABASE_FINAL_SNAPSHOT_IDENTIFIER,
      tags: { Name: DATABASE_IDENTIFIER },
    },
    { provider },
  );

  /**
   * The secret RDS created and owns.
   *
   * `masterUserSecrets` is a list because the API models it as one; there is
   * exactly one entry for a single instance, and it is the secret an ECS task
   * definition injects as `PG_PASSWORD` in item 8. Handed out resolved rather
   * than as the raw list, so a consumer does not have to know the shape or
   * index into it.
   */
  const secretArn = database.masterUserSecrets.apply(
    (secrets) => secrets[0].secretArn,
  );

  return {
    database,
    /**
     * For item 8's `secrets` block and its read grant. Nothing reads it yet.
     */
    secretArn,
    /** Host and port for `config_store`/`logs_store` and the task's env. */
    address: database.address,
    port: database.port,
    endpoint: database.endpoint,
  };
};

/** The shape item 8 and item 9 consume. */
export type BifrostDatabase = ReturnType<typeof createBifrostDatabase>;
