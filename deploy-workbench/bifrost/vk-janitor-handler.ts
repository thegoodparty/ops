/**
 * The janitor Lambda's entrypoint: step 5 of `docs/bifrost-virtual-keys.md` and,
 * since step 3 of `docs/bifrost-reconciler.md`, the reconciler's as well.
 *
 * The thin shell around `vk-janitor-core.ts`. It assumes the read-only
 * membership role, reads the setup token, reads the three SSM parameters the
 * desired state lives in, reads the gateway's keys over HTTP, writes the `PUT`s
 * the two loops decide on, and logs what it did. The decisions — marker only,
 * empty group aborts, the once-only retention timer, every read before the first
 * write, diff before write — are in the core so they can be tested without an
 * AWS mock.
 *
 * One function and two jobs, which is decision 3 of the reconciler plan: a
 * second Lambda would have duplicated the VPC attachment, the setup-token read,
 * the directory hop, the network and the tests, for a job that shares the same
 * credential and the same target. Step 4 adds the `rate(5 minutes)` schedule and
 * the deploy's `RequestResponse` invoke (both in
 * `bifrost-vk-janitor.ts` and `scripts/verify-convergence.ts`) and the config
 * half this handler now runs last. What the triggers need from this file is one
 * thing: the summary it returns, so a caller can tell "ran and converged" from
 * "ran and did not" instead of reading a status code and guessing.
 *
 * Two things must not be got wrong here, for the same reasons as the mint:
 *
 * - **It logs neither a key's plaintext nor a request or response body.** The
 *   setup token is a deployment-wide admin credential and a virtual key appears
 *   in both, in plaintext (decision 3). The gateway adapter below does not even
 *   copy `value` out of a response, so no code path here can log what it never
 *   held; the log lines name the owner and the verdict, which is all an
 *   operator needs.
 * - **A failed read is a failed run.** The handler rethrows, so EventBridge
 *   records a failed invocation rather than a silent success, and CloudWatch
 *   has the error line either way. Nothing disables itself (decision 15 of the
 *   reconciler plan).
 *
 * The directory read is `createMembershipDirectory` from `vk-mint-handler.ts`,
 * not a second copy: decision 6 says both jobs make the identical read through
 * the same management-account role, so one adapter is the honest shape.
 *
 * Environment, all set by `deploy-workbench/bifrost-vk-janitor.ts`:
 *
 *   BIFROST_BASE_URL          http://bifrost.workbench.local:8080 — the task,
 *                             via Cloud Map, not the ALB
 *   SETUP_TOKEN_SECRET_NAME   `bifrost/gateway`, the same container the mint
 *                             reads (decision 6)
 *   SETUP_TOKEN_SECRET_JSON_KEY  BIFROST_SETUP_TOKEN
 *   READER_ROLE_ARN           the management-account `bifrost-vk-reader`
 *   READER_SESSION_NAME       `VK_READER_SESSION_NAME`, imported from the role
 *   TEMPLATE_PARAMETER_NAME   `/bifrost/vk-mint-template`, the default shape
 *   OVERRIDES_PARAMETER_NAME  `/bifrost/governance-overrides`, the per-person
 *                             document
 */

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

import {
  GatewayFailure,
  type KeyPage,
  type MembershipDirectory,
  type VirtualKey,
} from "./vk-mint-core";
import {
  createMembershipDirectory,
  SETUP_TOKEN_JSON_KEY,
} from "./vk-mint-handler";
import {
  JanitorFailure,
  reconcileGovernance,
  reconcileVirtualKeys,
  type GovernanceTemplate,
  type JanitorGateway,
  type JanitorResult,
  type ReconcileResult,
} from "./vk-janitor-core";
import type { GovernanceOverrides } from "./governance-desired-state";
import {
  configConvergenceNotRun,
  convergeConfig,
  liveConfigDesiredState,
  type ConfigConvergenceResult,
  type ConfigGateway,
} from "./config-convergence-core";
import {
  reconcilerTrigger,
  summarizeRun,
  type ReconcilerSummary,
} from "./reconciler-summary";

/** The Identity Store and STS calls go to the directory's own region. */
const AWS_REGION = process.env.AWS_REGION ?? "us-west-2";

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

export type JanitorDeps = {
  /** Reads the setup token out of the shared secret. Throws when it cannot. */
  readSetupToken: () => Promise<string>;
  /**
   * Reads the two governance documents out of SSM: the template and the
   * per-person overrides. Throws when either cannot be read or does not parse.
   */
  readGovernance: () => Promise<{
    template: GovernanceTemplate;
    overrides: GovernanceOverrides;
  }>;
  /**
   * Reads `/bifrost/config`, the committed gateway file step 1's digest covers
   * and step 4 converges the live half of.
   *
   * Text rather than parsed JSON, because the parse and the live/boot-only
   * selection belong to `config-convergence-core.ts` and nothing here should be
   * able to disagree about which fields are live. The grant for this parameter
   * landed with step 3 (`bifrost-vk-janitor.ts`, `RECONCILER_PARAMETERS`) and it
   * is exercised from here on, which is the point the plan makes about issuing
   * the permission before the loop that reads it.
   */
  readConfig: () => Promise<string>;
  /** Assumes the reader role and builds the two directory reads. */
  createDirectory: () => Promise<MembershipDirectory>;
  /** The governance half's gateway client, carrying the setup token. */
  createGateway: (setupToken: string) => JanitorGateway;
  /**
   * The config half's gateway client: the same base URL and token, over the
   * routes config convergence writes (`/api/config`, `/api/providers`).
   *
   * Separate from `createGateway` because the two interfaces are deliberately
   * different shapes — the governance half lists every virtual key and updates
   * one, the config half reads and patches providers — and one object pretending
   * to be both would blur which loop may write what.
   */
  createConfigGateway: (setupToken: string) => ConfigGateway;
  /** One structured line per decision; never given a body or a key. */
  log: (entry: Record<string, unknown>) => void;
  /** Injectable so a test's retention deadline is deterministic. */
  now: () => Date;
};

/**
 * What one invocation did: both halves of the reconciler, in the order they run.
 *
 * Two results rather than a merged one, because the janitor's summary (who was
 * revoked, and the shape of its counts) is already a contract with the run log
 * and with `docs/bifrost-virtual-keys.md`, and folding a second job's counts
 * into it would make "deactivated: 0" ambiguous between the two. Step 4's poll
 * reads `governance.outcome` for "converged".
 */
export type JanitorRun = {
  revocation: JanitorResult;
  governance: ReconcileResult;
  config: ConfigConvergenceResult;
  /**
   * The one field a caller reads. It is what the deploy's poll asserts, and it
   * distinguishes "ran and converged" from "ran and did not converge" — the
   * third state, "never ran", is the caller's own (a throttle it never got past)
   * and cannot be known here.
   */
  summary: ReconcilerSummary;
};

/**
 * The handler, with its AWS and Bifrost dependencies injected.
 *
 * Two jobs, in a fixed order, on one set of reads:
 *
 * 1. **Revocation** (step 5 of `docs/bifrost-virtual-keys.md`): the loop that
 *    deactivates a key whose owner has left `Engineers`.
 * 2. **Governance convergence** (step 3 of `docs/bifrost-reconciler.md`): the
 *    diff-and-apply loop that brings every existing managed key to template
 *    plus override.
 *
 * 3. **Config convergence** (step 4 of `docs/bifrost-reconciler.md`): the same
 *    diff-and-apply shape over the live subset of `config.json`, which is the
 *    half the deploy's invoke exists to run.
 *
 * Revocation first because it is the fail-closed half: a run that has just
 * deactivated a departed owner's key must not then converge that key's
 * governance, and running the other way round would spend a `PUT` on a key
 * about to be deactivated. Neither loop mints, so nothing here grants access.
 * Config convergence comes last because it does not depend on the rest and a
 * failure in it must not leave governance half-written.
 *
 * A run that reaches the gateway but fails a read logs one `failed` line and
 * rethrows, so the invocation fails and step 6's alarm can count it. A run that
 * reads an empty group logs `aborted` and returns: the read succeeded and said
 * "nobody", which is a state to look at rather than a failure to retry into a
 * fleet-wide rewrite.
 *
 * The event is read for one thing only, the trigger label (`reconcilerTrigger`):
 * the scheduled rule sends `{action: "reconcile"}` and the deploy sends the same
 * object with `trigger: "deploy"`. Both run the whole reconciler, because a
 * converged state is idempotent and a deploy that also re-converges governance
 * has done something useful rather than something surprising.
 */
export const createJanitorHandler =
  (deps: JanitorDeps) =>
  async (event: unknown): Promise<JanitorRun> => {
    const trigger = reconcilerTrigger(event);
    let revocation: JanitorResult;
    let governance: ReconcileResult;
    let config: ConfigConvergenceResult;
    try {
      let directory: MembershipDirectory;
      try {
        directory = await deps.createDirectory();
      } catch {
        throw new JanitorFailure(
          "membership-unavailable",
          "could not assume the directory role",
        );
      }

      let setupToken: string;
      try {
        setupToken = await deps.readSetupToken();
      } catch {
        throw new JanitorFailure(
          "gateway-unavailable",
          "could not read the setup token",
        );
      }

      const gateway = deps.createGateway(setupToken);
      revocation = await reconcileVirtualKeys({
        directory,
        gateway,
        now: deps.now(),
      });

      // The revocation half is logged the moment it returns, before the
      // convergence half can throw. "Who was revoked, when and why" is the
      // audit trail the retention window exists to make reviewable, and it must
      // not be lost because the run failed one step later: on the next tick those
      // keys carry their deletion timer, so they are counted as
      // `already-inactive` and their names never appear again.
      if (revocation.outcome === "aborted") {
        // The group read succeeded and returned nobody. Decision 6: do nothing
        // and say so. Convergence reads the same group and would abort for the
        // same reason, so it is not run at all — the one line is the record.
        //
        // The config half still runs. It reads no group and writes no
        // governance: it converges the process's own configuration to the file
        // the deploy just applied, which is exactly the job a deploy's invoke
        // is making, and skipping it here would make an unrelated directory
        // read decide whether a config change landed.
        deps.log({
          event: "vk-janitor",
          outcome: "aborted",
          reason: revocation.abortReason,
          members: revocation.memberCount,
        });
        governance = abortedReconcile();
        config = await runConfigConvergence(deps, setupToken, trigger);
        return finishRun(deps, trigger, revocation, governance, config);
      }
      logRevocation(deps, revocation);

      // The desired state, read after the revocation half has already decided
      // and written. Revocation is the fail-closed job and must not wait on a
      // parameter: a deploy that has not written `/bifrost/governance-overrides`
      // yet, or a parameter somebody deleted, would otherwise leave a departed
      // person's key active for as long as it took to notice. Convergence fails
      // the run on the same read, which is decision 15's "report it, do not
      // disable" — the alarm counts it and nothing keeps a working key active.
      let governanceDocuments: {
        template: GovernanceTemplate;
        overrides: GovernanceOverrides;
      };
      try {
        governanceDocuments = await deps.readGovernance();
      } catch {
        throw new JanitorFailure(
          "desired-state-unavailable",
          "could not read the governance documents",
        );
      }

      governance = await reconcileGovernance({
        directory,
        gateway,
        template: governanceDocuments.template,
        overrides: governanceDocuments.overrides,
      });

      config = await runConfigConvergence(deps, setupToken, trigger);
    } catch (error) {
      deps.log({
        event: "vk-janitor",
        outcome: "failed",
        reason: failureReason(error),
        trigger,
        // Nobody read the summary on a failed invocation: the platform reports
        // the throw as a `FunctionError`, and the deploy's poll reads that. The
        // line is here so a scheduled tick's failure says which attempt it was.
      });
      throw error;
    }

    logConvergence(deps, governance);
    return finishRun(deps, trigger, revocation, governance, config);
  };

/**
 * The config half: the parameter's text, the live subset, and the loop.
 *
 * **The deploy is the only trigger for this half, and that is decision 16 read
 * literally.** The plan bounds config convergence at one deploy ("it waits for a
 * tick or a deploy", and for config it is the deploy), and decision 4 gives the
 * scheduled rule governance and revocation only. Running it on the tick as well
 * would be a different bound than the one the plan promises, and it would make a
 * person's dashboard edit disappear within five minutes without anybody having
 * deployed anything — a privacy decision dressed as an optimisation.
 *
 * A scheduled tick therefore returns `not-run` rather than skipping the call
 * silently, so the summary says which halves ran. A deploy that gets `not-run`
 * back is a failed run (`reconciler-summary.ts`), which cannot happen here but is
 * where the guarantee lives.
 */
const runConfigConvergence = async (
  deps: JanitorDeps,
  setupToken: string,
  trigger: ReconcilerSummary["trigger"],
): Promise<ConfigConvergenceResult> => {
  if (trigger !== "deploy") return configConvergenceNotRun();

  let text: string;
  try {
    text = await deps.readConfig();
  } catch {
    throw new JanitorFailure(
      "desired-state-unavailable",
      "could not read /bifrost/config",
    );
  }
  return convergeConfig({
    gateway: deps.createConfigGateway(setupToken),
    desired: liveConfigDesiredState(text),
  });
};

/** The run's summary and its one log line, after both halves have returned. */
const finishRun = (
  deps: JanitorDeps,
  trigger: ReconcilerSummary["trigger"],
  revocation: JanitorResult,
  governance: ReconcileResult,
  config: ConfigConvergenceResult,
): JanitorRun => {
  logConfig(deps, config);
  const summary = summarizeRun({
    trigger,
    revocation: {
      outcome: revocation.outcome,
      kept: revocation.kept.length,
      deactivated: revocation.deactivated.length,
      skipped: revocation.skipped.length,
    },
    governance: {
      outcome: governance.outcome,
      changed: governance.changed,
      unchanged: governance.unchanged,
      skipped: governance.skipped.length,
    },
    config: {
      outcome: config.outcome,
      changed: config.changed,
      unchanged: config.unchanged,
      skipped: config.skipped.length,
    },
  });
  // One line, after the per-key lines: the summary a caller asserts and the one
  // step 6's alarm will count (`outcome`), with the trigger so a throttle-driven
  // pattern and a convergence failure are told apart by whoever reads the log.
  // A separate event name from the governance loop's summary lines above, which
  // are per-loop; this one is the run.
  deps.log({ event: "reconciler-run", ...summary });
  return { revocation, governance, config, summary };
};

/** The config half's summary and one line per section it changed. */
const logConfig = (deps: JanitorDeps, result: ConfigConvergenceResult): void => {
  // A run with nothing to converge and nothing missing says so in the counts the
  // per-section lines would not reach; a steady stream of "changed" is the
  // fight worth looking at, so the summary is worth a line only when it is not
  // the empty one.
  const missing = result.skipped.filter((entry) => entry.reason === "not-present");
  if (result.changed > 0 || missing.length > 0) {
    deps.log({
      event: "bifrost-config-reconciler",
      outcome: result.outcome,
      changed: result.changed,
      unchanged: result.unchanged,
      skipped: result.skipped.length,
    });
  }
  for (const entry of result.applied) {
    // The section and the field names that differed. No value, ever: a client
    // config holds nothing secret but a provider's block is where a credential
    // would be if one were ever misplaced, and a field name cannot leak either.
    deps.log({
      event: "bifrost-config-reconciler",
      outcome: "converged",
      section: entry.section,
      fields: entry.fields,
    });
  }
  for (const entry of result.skipped) {
    // The two constant skips (`$schema` has no runtime effect, `governance` holds
    // `env.` references) are the same every tick, so the summary counts them and
    // only a divergence a human has to act on gets a line: a provider or key in
    // the file that the running gateway does not have.
    if (entry.reason !== "not-present") continue;
    deps.log({
      event: "bifrost-config-reconciler",
      outcome: "skipped",
      path: entry.path,
      reason: entry.reason,
    });
  }
};

/** A run's revocation summary and its per-key lines. */
const logRevocation = (deps: JanitorDeps, result: JanitorResult): void => {
  deps.log({
    event: "vk-janitor",
    outcome: "ok",
    members: result.memberCount,
    managedKeys: result.managedKeyCount,
    kept: result.kept.length,
    deactivated: result.deactivated.length,
    skipped: result.skipped.length,
  });
  // One line per key, because "who was revoked, when and why" is the audit
  // trail the deactivation window exists to make reviewable. The name is the
  // owner's email and the reason is a verdict; no key value and no body.
  for (const entry of result.deactivated) {
    deps.log({
      event: "vk-janitor",
      outcome: "deactivated",
      name: entry.name,
      reason: entry.reason,
    });
  }
  for (const entry of result.skipped) {
    // The `already-inactive` skip is the steady state and would be one line per
    // deactivated key per tick; the summary counts it. The open-item-6
    // guard is the one worth a name on every run, because it is a mismatch a
    // human has to fix.
    if (entry.reason !== "owner-not-an-email") continue;
    deps.log({
      event: "vk-janitor",
      outcome: "skipped",
      name: entry.name,
      reason: entry.reason,
    });
  }
};

/** The convergence summary and one line per key it changed or skipped. */
const logConvergence = (deps: JanitorDeps, result: ReconcileResult): void => {
  if (result.outcome === "aborted") {
    deps.log({
      event: "vk-reconciler",
      outcome: "aborted",
      reason: result.abortReason,
      members: result.memberCount,
    });
    return;
  }

  // `changed` is the number decision 6 makes the signal: a run with nothing to
  // do and a run that keeps finding the same difference must not read the same
  // in the log.
  deps.log({
    event: "vk-reconciler",
    outcome: result.outcome,
    members: result.memberCount,
    managedKeys: result.managedKeyCount,
    changed: result.changed,
    unchanged: result.unchanged,
    skipped: result.skipped.length,
    minted: result.minted,
  });
  // One line per key that changed, with the fields that differed. A steady
  // stream of the same names is the fight worth looking at, so the names are as
  // load-bearing here as the count.
  for (const entry of result.applied) {
    deps.log({
      event: "vk-reconciler",
      outcome: "converged",
      name: entry.name,
      fields: entry.fields,
    });
  }
  for (const entry of result.skipped) {
    deps.log({
      event: "vk-reconciler",
      outcome: "skipped",
      name: entry.name,
      reason: entry.reason,
    });
  }
};

/** The convergence result a run reports when it never got that far. */
const abortedReconcile = (): ReconcileResult => ({
  outcome: "aborted",
  abortReason: "group-empty",
  memberCount: 0,
  managedKeyCount: 0,
  changed: 0,
  unchanged: 0,
  applied: [],
  skipped: [],
  minted: 0,
});

/** A failure's reason for the log line: a code, never a body or a key. */
const failureReason = (error: unknown): string =>
  error instanceof JanitorFailure
    ? error.code
    : error instanceof GatewayFailure
      ? `gateway-${error.status}`
      : error instanceof Error
        ? error.name
        : "unknown";

/**
 * The gateway client, over `fetch`, carrying the setup token.
 *
 * The header is `X-Bifrost-Setup-Token`, the OSS setup lock's header at the
 * pinned tag (`bifrost-vk-mint.ts` and `bifrost-gateway.md`, "Protecting the
 * admin surface"). A non-2xx becomes a `GatewayFailure` that carries only the
 * status, so no error path can put a response body — or a key — into a log.
 *
 * `toKey` deliberately does not read `value`: the janitor never needs a
 * plaintext key, and a field it never stores is a field no log line can leak.
 */
export const createJanitorGateway = (args: {
  baseUrl: string;
  setupToken: string;
}): JanitorGateway => {
  const base = args.baseUrl.replace(/\/+$/, "");

  const call = async (
    method: "GET" | "PUT",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; json: unknown }> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "X-Bifrost-Setup-Token": args.setupToken,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: response.status, json: parsed };
  };

  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};

  const toKey = (value: unknown): VirtualKey => {
    const raw = record(value);
    return {
      id: String(raw.id ?? ""),
      name: String(raw.name ?? ""),
      // Never copied. See the comment above.
      value: null,
      is_active: typeof raw.is_active === "boolean" ? raw.is_active : null,
      expires_at: typeof raw.expires_at === "string" ? raw.expires_at : null,
      delete_after_expire:
        typeof raw.delete_after_expire === "boolean"
          ? raw.delete_after_expire
          : null,
      description: typeof raw.description === "string" ? raw.description : null,
      // The governance the diff reads. Copied as-is rather than reshaped:
      // `differingFields` reads only the fields a `PUT` can set, so passing the
      // runtime-owned numbers through costs nothing and rebuilding them here
      // would be a second place that has to know the wire shape.
      calendar_aligned:
        typeof raw.calendar_aligned === "boolean" ? raw.calendar_aligned : null,
      ...(Array.isArray(raw.budgets) ? { budgets: raw.budgets } : {}),
      ...(Array.isArray(raw.provider_configs)
        ? { provider_configs: raw.provider_configs }
        : {}),
      ...(record(raw.rate_limit) && Object.keys(record(raw.rate_limit)).length > 0
        ? { rate_limit: record(raw.rate_limit) }
        : { rate_limit: null }),
    } as VirtualKey;
  };

  /**
   * `virtual_keys` is `null` rather than `[]` on an empty result, the shape
   * step 3 observed against the deployed gateway; handled explicitly rather
   * than with a `??` that would hide a malformed body.
   */
  const listFrom = (value: unknown): VirtualKey[] =>
    Array.isArray(value) ? value.map(toKey) : [];

  return {
    list: async ({ limit, offset }) => {
      const { status, json: payload } = await call(
        "GET",
        `/api/governance/virtual-keys?limit=${limit}&offset=${offset}`,
      );
      if (status !== 200) throw new GatewayFailure(status);
      const body = record(payload);
      const totalCount =
        typeof body.total_count === "number" ? body.total_count : undefined;
      const page: KeyPage = {
        keys: listFrom(body.virtual_keys),
        ...(totalCount === undefined ? {} : { totalCount }),
      };
      return page;
    },

    update: async (id, requestBody) => {
      const { status, json: payload } = await call(
        "PUT",
        `/api/governance/virtual-keys/${encodeURIComponent(id)}`,
        requestBody,
      );
      if (status !== 200) throw new GatewayFailure(status);
      return toKey(record(payload).virtual_key);
    },
  };
};

/**
 * The config half's client, over the same `fetch` and the same setup-token
 * header as `createJanitorGateway`, on the routes config convergence uses.
 *
 * A separate function from the governance client rather than one object with
 * both sets of methods: they speak to different route families and return
 * different shapes, and the two are never used interchangeably. What they do
 * share is the transport and the credential, which is the setup token's own
 * story (`bifrost-gateway.md`, "Protecting the admin surface").
 *
 * `getProvider` answers `null` for a `404` rather than throwing. A provider the
 * running gateway does not have is not an outage: it is a boot-only change, and
 * convergence names it as skipped instead of pretending to have written it.
 * Every other non-2xx is a `GatewayFailure` carrying only the status, so no
 * error path can put a response body into a log.
 */
export const createConfigGateway = (args: {
  baseUrl: string;
  setupToken: string;
}): ConfigGateway => {
  const base = args.baseUrl.replace(/\/+$/, "");

  const call = async (
    method: "GET" | "PUT",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; json: unknown }> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "X-Bifrost-Setup-Token": args.setupToken,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: response.status, json: parsed };
  };

  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};

  return {
    getConfig: async () => {
      const { status, json: payload } = await call("GET", "/api/config");
      if (status !== 200) throw new GatewayFailure(status);
      return record(payload);
    },

    putConfig: async (body) => {
      const { status } = await call("PUT", "/api/config", body);
      if (status !== 200) throw new GatewayFailure(status);
    },

    getProvider: async (provider) => {
      const { status, json: payload } = await call(
        "GET",
        `/api/providers/${encodeURIComponent(provider)}`,
      );
      if (status === 404) return null;
      if (status !== 200) throw new GatewayFailure(status);
      return record(payload);
    },

    putProvider: async (provider, body) => {
      const { status } = await call(
        "PUT",
        `/api/providers/${encodeURIComponent(provider)}`,
        body,
      );
      if (status !== 200) throw new GatewayFailure(status);
    },

    listProviderKeys: async (provider) => {
      const { status, json: payload } = await call(
        "GET",
        `/api/providers/${encodeURIComponent(provider)}/keys`,
      );
      if (status !== 200) throw new GatewayFailure(status);
      const keys = record(payload).keys;
      return Array.isArray(keys) ? keys.map(record) : [];
    },

    putProviderKey: async (provider, keyId, body) => {
      const { status } = await call(
        "PUT",
        `/api/providers/${encodeURIComponent(provider)}/keys/${encodeURIComponent(keyId)}`,
        body,
      );
      if (status !== 200) throw new GatewayFailure(status);
    },
  };
};

/**
 * The real dependency set. Clients are built inside each function rather than
 * at module load, so importing this module (in a test, or in a bundler) does
 * not construct one.
 */
export const handler = createJanitorHandler({
  readSetupToken: async () => {
    const secrets = new SecretsManagerClient({ region: AWS_REGION });
    const response = await secrets.send(
      new GetSecretValueCommand({
        SecretId: requireEnv("SETUP_TOKEN_SECRET_NAME"),
      }),
    );
    const raw = response.SecretString;
    if (!raw) throw new Error("the setup-token secret has no string value");
    const parsed: unknown = JSON.parse(raw);
    const token =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)[
            process.env.SETUP_TOKEN_SECRET_JSON_KEY ?? SETUP_TOKEN_JSON_KEY
          ]
        : undefined;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("the setup-token secret has no BIFROST_SETUP_TOKEN");
    }
    return token;
  },

  createDirectory: async () => {
    const sts = new STSClient({ region: AWS_REGION });
    const assumed = await sts.send(
      new AssumeRoleCommand({
        RoleArn: requireEnv("READER_ROLE_ARN"),
        // Imported from the role's own module and passed in as configuration,
        // so CloudTrail records every directory read under one name.
        RoleSessionName: requireEnv("READER_SESSION_NAME"),
      }),
    );
    const credentials = assumed.Credentials;
    if (
      !credentials?.AccessKeyId ||
      !credentials.SecretAccessKey ||
      !credentials.SessionToken
    ) {
      throw new Error("the reader role returned no credentials");
    }
    return createMembershipDirectory({
      client: new IdentitystoreClient({
        region: AWS_REGION,
        credentials: {
          accessKeyId: credentials.AccessKeyId,
          secretAccessKey: credentials.SecretAccessKey,
          sessionToken: credentials.SessionToken,
        },
      }),
    });
  },

  readGovernance: async () => {
    const ssm = new SSMClient({ region: AWS_REGION });
    const read = async (name: string): Promise<unknown> => {
      const response = await ssm.send(
        new GetParameterCommand({ Name: requireEnv(name) }),
      );
      const value = response.Parameter?.Value;
      if (!value) throw new Error(`${name} has no value`);
      return JSON.parse(value) as unknown;
    };

    // Both documents in one dependency, so a run either has the whole desired
    // state or fails before it has written anything. The template's shape and
    // the overrides' are validated at apply time (decision 10), so what is read
    // here is trusted to have been reviewed; a malformed one still fails the
    // run rather than converging to a guess.
    return {
      template: (await read("TEMPLATE_PARAMETER_NAME")) as GovernanceTemplate,
      overrides: (await read(
        "OVERRIDES_PARAMETER_NAME",
      )) as GovernanceOverrides,
    };
  },

  createGateway: (setupToken: string) =>
    createJanitorGateway({
      baseUrl: requireEnv("BIFROST_BASE_URL"),
      setupToken,
    }),

  readConfig: async () => {
    const ssm = new SSMClient({ region: AWS_REGION });
    const response = await ssm.send(
      new GetParameterCommand({ Name: requireEnv("CONFIG_PARAMETER_NAME") }),
    );
    const value = response.Parameter?.Value;
    if (!value) throw new Error("CONFIG_PARAMETER_NAME has no value");
    return value;
  },

  createConfigGateway: (setupToken: string) =>
    createConfigGateway({
      baseUrl: requireEnv("BIFROST_BASE_URL"),
      setupToken,
    }),

  log: (entry) => console.log(JSON.stringify(entry)),

  now: () => new Date(),
});
