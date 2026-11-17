import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { GetSecretValueCommand, SecretsManagerClient, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { Client } from "pg";

import {
  GRANTED_COLUMNS,
  USAGE_EXPORT_BOOTSTRAP_TIMEOUT_SECONDS,
  USAGE_EXPORT_DB_ROLE,
  USAGE_EXPORT_SECRET_JSON_KEY,
  USAGE_EXPORT_SECRET_NAME,
  type BootstrapOutcome,
} from "./usage-export-contract";

/**
 * The one-purpose function that creates the export's read-only Postgres role and
 * writes its password.
 *
 * **This is the only thing in the ticket that touches the RDS master credential,
 * and it exists to be removed.** Its resource is deleted in a follow-up PR once
 * it has run; the source stays committed because that is what makes rotation
 * possible later.
 *
 * ## The no-op, which is the whole reason this is safe to run on every deploy
 *
 * `deploy-workbench.yml` invokes this after every apply. A second invocation must
 * not rotate a working credential out from under the export, so the first thing
 * this handler does is read the export's secret and look for a non-empty
 * `password`. If it finds one, it returns `already-provisioned` and touches
 * nothing else — no master secret read, no connection, no DDL, no write.
 *
 * **The export's secret is the marker.** Its existence with a password in it
 * means provisioned. There is no second source of truth to drift and no state
 * file. The consequence worth being explicit about: if the secret exists but the
 * role does not, this no-ops and the export fails a login the next morning. That
 * is the correct direction — a hand-deleted role is not something a routine
 * deploy should silently recreate — and the recovery is the rotation procedure in
 * `docs/runbooks.md`.
 *
 * ## Why the write happens after the DDL commits
 *
 * The order is DDL, commit, then `PutSecretValue`. The reverse is a silent trap:
 * a secret written first and a DDL that then failed leaves the export
 * authenticating with a password the database does not hold, and every nightly
 * run fails until someone opens a breakglass session. On a secret-write failure
 * after commit the run is safe to repeat, because the DDL below is idempotent
 * (`DO $$ ... EXCEPTION WHEN duplicate_object THEN ALTER ROLE ...`).
 *
 * ## What it must not log
 *
 * Neither password, and no part of either secret. Only the outcome.
 *
 * Environment, set by `deploy-workbench/usage-export.ts`:
 *
 *   EXPORT_SECRET_NAME          `bifrost/usage-export`, where it writes
 *   MASTER_SECRET_ARN           the RDS-managed master secret's ARN
 *   PG_HOST / PG_PORT / PG_DATABASE
 *   PG_MASTER_USER              the master user, from the same module's constants
 */

/** Where the Lambda runtime keeps Amazon's CA bundle. */
const RDS_CA_PATH = "/var/runtime/ca-cert.pem";

type BootstrapEnvironment = {
  exportSecretName: string;
  masterSecretArn: string;
  pgHost: string;
  pgPort: number;
  pgDatabase: string;
  pgMasterUser: string;
};

const readEnvironment = (env: NodeJS.ProcessEnv): BootstrapEnvironment => {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set; the Lambda's environment did not reach it`);
    return value;
  };
  const port = Number(required("PG_PORT"));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PG_PORT is not a port: ${env.PG_PORT}`);
  }
  return {
    exportSecretName: required("EXPORT_SECRET_NAME"),
    masterSecretArn: required("MASTER_SECRET_ARN"),
    pgHost: required("PG_HOST"),
    pgPort: port,
    pgDatabase: required("PG_DATABASE"),
    pgMasterUser: required("PG_MASTER_USER"),
  };
};

/**
 * Whether the export's secret already holds a password.
 *
 * A missing secret is `false`, not an error: the secret is a Pulumi resource, so
 * it exists before this function can be invoked, but a `ResourceNotFoundException`
 * is still the honest answer to "is there a password" if it ever does not.
 */
export const hasProvisionedPassword = async (
  client: SecretsManagerClient,
  secretName: string,
): Promise<boolean> => {
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
    const raw = response.SecretString;
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[USAGE_EXPORT_SECRET_JSON_KEY];
    return typeof value === "string" && value !== "";
  } catch (error) {
    if (error instanceof Error && error.name === "ResourceNotFoundException") return false;
    throw error;
  }
};

/**
 * The master user's password, from the secret RDS owns.
 *
 * `manageMasterUserPassword: true` in `rds.ts` means RDS generates this and
 * rotates it on its own schedule, writing each rotation as the `AWSCURRENT`
 * version of the same secret. Reading `AWSCURRENT` therefore converges on its own
 * and needs no version handling, which is the same choice
 * `bifrost/pg-password.sh` makes for the gateway.
 */
export const readMasterPassword = async (
  client: SecretsManagerClient,
  masterSecretArn: string,
): Promise<string> => {
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: masterSecretArn, VersionStage: "AWSCURRENT" }),
  );
  const raw = response.SecretString;
  if (!raw) throw new Error("the master secret has no SecretString");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const value = parsed.password;
  if (typeof value !== "string" || value === "") {
    throw new Error("the master secret has no non-empty password key");
  }
  return value;
};

/**
 * The DDL, and it is one statement so it is one transaction.
 *
 * `exported_at` and `loaded_at` are absent from the column grant on purpose:
 * neither exists in the gateway's `logs` table, and Postgres rejects a `GRANT`
 * naming a column that does not exist. That is the trap the design record calls
 * out, and this is the statement that would hit it.
 *
 * `GRANT USAGE ON SCHEMA public` is here because Postgres needs `USAGE` on a
 * schema to resolve a table name inside it; the role gets `SELECT` on these
 * columns and nothing else, so there is no other route to the table. It is
 * idempotent and stated explicitly rather than relied on as a default, so a later
 * `REVOKE ... FROM PUBLIC` cannot break the export silently.
 *
 * The `GRANT` succeeds because the master user owns `logs`: Bifrost runs its
 * startup migrations as the user it connects with, which is the master
 * (`rds.ts` says so and explains why the split role was rejected), so the table
 * it creates is owned by the same role this function connects as. If that ever
 * stops being true the `GRANT` fails here, naming the privilege, rather than
 * producing a role that cannot read.
 *
 * The `DO` block makes a second invocation converge rather than error, which is
 * what makes a failed secret write safe to retry.
 */
export const bootstrapSql = (args: { password: string; database: string }): string => {
  const quotedPassword = quoteLiteral(args.password);
  const columns = GRANTED_COLUMNS.map((name) =>
    name === "timestamp" || name === "alias" ? `"${name}"` : name,
  ).join(", ");
  return `do $$ begin
  create role ${USAGE_EXPORT_DB_ROLE} login password ${quotedPassword};
exception when duplicate_object then
  alter role ${USAGE_EXPORT_DB_ROLE} password ${quotedPassword};
end $$;
grant connect on database ${quoteIdent(args.database)} to ${USAGE_EXPORT_DB_ROLE};
grant usage on schema public to ${USAGE_EXPORT_DB_ROLE};
grant select (${columns}) on logs to ${USAGE_EXPORT_DB_ROLE};`;
};

/**
 * A SQL string literal, with the quote doubled.
 *
 * The password is generated here from `randomBytes`, so it is base64url and cannot
 * contain a quote. This escapes anyway: a future change to the generator should
 * not be the thing that turns a password into SQL.
 */
const quoteLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** An identifier, quoted. Only used for the database name, which is a constant. */
const quoteIdent = (value: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`database name is not a plain identifier: ${JSON.stringify(value)}`);
  }
  return value;
};

/**
 * A password with no characters that need escaping in a URL or a shell.
 *
 * 32 bytes of base64url is 43 characters of `[A-Za-z0-9_-]`. It never reaches a
 * log, a URL or a shell here, but keeping it to a safe alphabet means a human
 * pasting it somewhere during a recovery does not have to think about quoting.
 */
export const generatePassword = (): string => randomBytes(32).toString("base64url");

export const handler = async (): Promise<BootstrapOutcome> => {
  const environment = readEnvironment(process.env);
  const secrets = new SecretsManagerClient({});

  if (await hasProvisionedPassword(secrets, environment.exportSecretName)) {
    console.log("bifrost usage export bootstrap: already provisioned, nothing to do");
    return { outcome: "already-provisioned" };
  }

  const masterPassword = await readMasterPassword(secrets, environment.masterSecretArn);
  const ca = readFileSync(RDS_CA_PATH, "utf8");
  const password = generatePassword();

  const client = new Client({
    host: environment.pgHost,
    port: environment.pgPort,
    database: environment.pgDatabase,
    user: environment.pgMasterUser,
    password: masterPassword,
    ssl: { ca, rejectUnauthorized: true },
    // Well inside the function's timeout, not the export's 300s: this run is a
    // handful of DDL statements, and a statement timeout longer than the function
    // meant Lambda killed the run with a bare "Task timed out" instead of
    // Postgres saying what it was waiting for.
    statement_timeout: 60_000,
    // The real guard against a lock. `connectionTimeoutMillis` only bounds the TCP
    // and TLS connect, so a `GRANT` waiting on a lock held by the gateway's
    // startup migrations would have run to the statement timeout above. Thirty
    // seconds is long enough for a normal contention blip and short enough to
    // fail with Postgres's own "lock timeout" message while the function is still
    // alive to report it.
    lock_timeout: 30_000,
    // Connect only. Named for what it does; it is not the lock guard.
    connectionTimeoutMillis: (USAGE_EXPORT_BOOTSTRAP_TIMEOUT_SECONDS - 10) * 1000,
  });

  try {
    await client.connect();
    await client.query(bootstrapSql({ password, database: environment.pgDatabase }));
  } finally {
    await client.end().catch(() => undefined);
  }

  // After the DDL commits, never before. See the header.
  await secrets.send(
    new PutSecretValueCommand({
      SecretId: environment.exportSecretName,
      SecretString: JSON.stringify({ [USAGE_EXPORT_SECRET_JSON_KEY]: password }),
    }),
  );

  console.log("bifrost usage export bootstrap: provisioned the read-only role and wrote its password");
  return { outcome: "provisioned" };
};
