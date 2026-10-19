/**
 * The group-sync Lambda's entrypoint, step 3 of `docs/google-group-sync.md`.
 *
 * The thin shell around `run.ts`: it reads the SSM config and the Google
 * service-account secret, assumes `identity-group-sync-grant`, and hands the
 * injected pieces to the algorithm. Everything with a decision in it lives in
 * `run.ts`, `./guards` and `./identity` so the tests never need AWS.
 *
 * The invocation shapes:
 *
 *   { "action": "sync" }                                    the scheduled run
 *   { "action": "sync", "pairId": "engineers-google" }       one pair only
 *   { "action": "sync", "pairId": "...", "overrideRemovalCap": true }
 *
 * The override is a payload and not a config field, per "Override" in the
 * plan: it cannot be left on by accident, it needs `lambda:InvokeFunction` on
 * the function, and CloudTrail records who made the call. Something that is not
 * a recognised `action` is refused rather than treated as a scheduled run, so a
 * typo cannot turn into an apply.
 *
 * Environment (set by `group-sync-lambda.ts`):
 *
 *   PARAMETER_NAME             `/identity-group-sync/pairs`
 *   SECRET_ARN                 the service-account secret
 *   GOOGLE_IMPERSONATION_EMAIL the dedicated impersonation admin (`sub`)
 *
 * Until the engineer finishes the manual Google setup, the secret has no value
 * and every run aborts here with `source-read-failed`, applying nothing. That
 * is the designed behaviour of a missing credential, not a failure mode to work
 * around.
 */
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import type { SyncPair } from "./config";
import { isSyncAbortError, SyncAbortError } from "./errors";
import { createDirectoryClient } from "./google";
import {
  assumeGrantRole,
  createIdentityDirectory,
  type IdentityDirectory,
} from "./identity";
import { audit, type Logger } from "./log";
import { CloudWatchMetrics, METRIC_NAMES, type Metrics } from "./metrics";
import {
  parseSyncConfig,
  runSync,
  type PairOutcome,
} from "./run";
import type { DirectoryClient } from "./source";

/** The parameter Pulumi writes; the plan names it explicitly. */
export const DEFAULT_PARAMETER_NAME = "/identity-group-sync/pairs";

/**
 * The session name the grant trusts. Imported from the grant's own module in
 * `group-sync-lambda.ts`, which passes it in as `GRANT_SESSION_NAME`; the
 * bundle reads it from the environment so the handler file stays free of the
 * `deploy/` tree.
 */
export const SESSION_NAME_ENV = "GRANT_SESSION_NAME";

export type HandlerDeps = {
  /** The raw SSM value. Throws when SSM cannot be read: that aborts the run. */
  readParameter: () => Promise<string>;
  /** Built on first use, so a credential failure aborts every pair, no writes. */
  buildDirectory: () => Promise<DirectoryClient>;
  buildIdentity: (pair: SyncPair) => Promise<IdentityDirectory>;
  metrics: Metrics;
  log: Logger;
  now: () => number;
};

export type Override = { pairId?: string; overrideRemovalCap?: boolean };

/**
 * Reads the manual-invocation payload. `undefined` means "a scheduled run of
 * every pair"; a thrown `invalid-config` means an unrecognised action, which
 * must not silently become a run.
 */
export const parseOverride = (event: unknown): Override | undefined => {
  if (event === null || typeof event !== "object") return undefined;
  const payload = event as Record<string, unknown>;
  if (!("action" in payload)) return undefined;
  if (payload.action !== "sync") {
    throw new SyncAbortError(
      "invalid-config",
      `unknown action ${JSON.stringify(payload.action)}`,
    );
  }
  const pairId =
    typeof payload.pairId === "string" && payload.pairId
      ? payload.pairId
      : undefined;
  return {
    ...(pairId ? { pairId } : {}),
    // Only a `true` is an override. A string "true" or 1 is a mistake, and
    // defaulting it to false is the safe reading.
    overrideRemovalCap: payload.overrideRemovalCap === true,
  };
};

/** Memoizes a promise so a credential failure is attempted once per run. */
const once = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
  let promise: Promise<T> | undefined;
  return () => (promise ??= fn());
};

const errorDetail = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * The whole invocation, with every dependency injected. Returns the per-pair
 * outcomes so the tests can assert on them and so a manual invoke sees what
 * happened.
 */
export const handle = async (
  event: unknown,
  deps: HandlerDeps,
): Promise<PairOutcome[]> => {
  let override: Override | undefined;
  try {
    override = parseOverride(event);
  } catch (err) {
    deps.log("sync.aborted", {
      reason: "invalid-config",
      detail: errorDetail(err),
    });
    return [];
  }

  let raw: string;
  try {
    raw = await deps.readParameter();
  } catch (err) {
    // Running with no config is indistinguishable from running with an empty
    // one, and an empty one would compute an empty source for every pair. The
    // invocation aborts; the `sync.aborted` line is what the failures alarm
    // keys on.
    deps.log("sync.aborted", {
      reason: "invalid-config",
      detail: `could not read ${DEFAULT_PARAMETER_NAME}: ${errorDetail(err)}`,
    });
    return [];
  }

  let config;
  try {
    config = parseSyncConfig(raw);
  } catch (err) {
    deps.log("sync.aborted", {
      reason: "invalid-config",
      detail: errorDetail(err),
    });
    return [];
  }

  // Lazily built so a missing Google credential or an AssumeRole failure
  // becomes a per-pair `sync.aborted` with no writes, rather than an exception
  // outside the pair loop.
  const getDirectory = once(deps.buildDirectory);
  const directory: DirectoryClient = {
    getGroup: async (request) => (await getDirectory()).getGroup(request),
    listMembers: async (request) =>
      (await getDirectory()).listMembers(request),
  };
  const identityFor = (pair: SyncPair): IdentityDirectory => {
    const get = once(async () => deps.buildIdentity(pair));
    return {
      resolveUserId: async (email) => (await get()).resolveUserId(email),
      createUser: async (email) => (await get()).createUser(email),
      addMembership: async (userId) => (await get()).addMembership(userId),
      removeMembership: async (membershipId) =>
        (await get()).removeMembership(membershipId),
      listMemberships: async () => (await get()).listMemberships(),
    };
  };

  try {
    return await runSync({
      config,
      directory,
      identityFor,
      metrics: deps.metrics,
      log: deps.log,
      now: deps.now,
      ...(override ? { override } : {}),
    });
  } finally {
    // Metrics are flushed even when a pair threw, so the counts gathered
    // before the failure are not lost with the invocation.
    await deps.metrics.flush();
  }
};

// ---------------------------------------------------------------------------
// The real wiring.
// ---------------------------------------------------------------------------

export const handler = async (event: unknown): Promise<PairOutcome[]> => {
  const parameterName = process.env.PARAMETER_NAME ?? DEFAULT_PARAMETER_NAME;
  const secretArn = process.env.SECRET_ARN ?? "";
  const impersonationEmail = process.env.GOOGLE_IMPERSONATION_EMAIL ?? "";
  const sessionName = process.env[SESSION_NAME_ENV] ?? "identity-group-sync";

  const ssm = new SSMClient({});
  const secrets = new SecretsManagerClient({});

  const readParameter = async (): Promise<string> => {
    const result = await ssm.send(
      new GetParameterCommand({ Name: parameterName }),
    );
    const value = result.Parameter?.Value;
    if (!value) {
      throw new Error(`parameter ${parameterName} has no value`);
    }
    return value;
  };

  const readSecret = once(async (): Promise<string> => {
    if (!secretArn) {
      throw new SyncAbortError(
        "source-read-failed",
        "SECRET_ARN is not configured",
      );
    }
    const result = await secrets.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    if (!result.SecretString) {
      // Empty is the expected state until the manual Google setup is done and
      // the key JSON is stored by hand; Pulumi creates the container only.
      throw new SyncAbortError(
        "source-read-failed",
        "the service-account secret has no value yet",
      );
    }
    return result.SecretString;
  });

  return handle(event, {
    readParameter,
    buildDirectory: async () =>
      createDirectoryClient({
        keyJson: await readSecret(),
        impersonationEmail,
      }),
    buildIdentity: async (pair) => {
      let client;
      try {
        client = await assumeGrantRole({ sessionName });
      } catch (err) {
        throw isSyncAbortError(err)
          ? err
          : new SyncAbortError(
              "identity-read-failed",
              `AssumeRole failed: ${errorDetail(err)}`,
            );
      }
      return createIdentityDirectory({
        client,
        groupId: pair.targetGroupId,
      });
    },
    metrics: new CloudWatchMetrics(),
    log: audit as Logger,
    now: () => Date.now(),
  });
};

/** The metric names, exported so the alarm definitions and tests share one list. */
export { METRIC_NAMES };
