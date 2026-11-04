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
 * the deploy's `RequestResponse` invoke; neither is built here, and neither needs
 * anything from this file beyond the function it already exposes.
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
   *
   * The third parameter the reconciler's grant covers, `/bifrost/config`, is not
   * read here: config convergence is step 4's half of the plan, and it is only
   * reachable once the deploy's invoke exists. The grant lands with this step
   * because it is one policy, and the grant without the loop would be a
   * permission nobody exercises.
   */
  readGovernance: () => Promise<{
    template: GovernanceTemplate;
    overrides: GovernanceOverrides;
  }>;
  /** Assumes the reader role and builds the two directory reads. */
  createDirectory: () => Promise<MembershipDirectory>;
  /** The gateway client, carrying the setup token. */
  createGateway: (setupToken: string) => JanitorGateway;
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
 * Revocation first because it is the fail-closed half: a run that has just
 * deactivated a departed owner's key must not then converge that key's
 * governance, and running the other way round would spend a `PUT` on a key
 * about to be deactivated. Neither loop mints, so nothing here grants access.
 *
 * A run that reaches the gateway but fails a read logs one `failed` line and
 * rethrows, so the invocation fails and step 6's alarm can count it. A run that
 * reads an empty group logs `aborted` and returns: the read succeeded and said
 * "nobody", which is a state to look at rather than a failure to retry into a
 * fleet-wide rewrite.
 */
export const createJanitorHandler =
  (deps: JanitorDeps) =>
  async (_event: unknown): Promise<JanitorRun> => {
    let revocation: JanitorResult;
    let governance: ReconcileResult;
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

      // The desired state, before the first write. A missing or malformed
      // document fails the run rather than converging to a guess.
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

      const gateway = deps.createGateway(setupToken);
      revocation = await reconcileVirtualKeys({
        directory,
        gateway,
        now: deps.now(),
      });
      governance = await reconcileGovernance({
        directory,
        gateway,
        template: governanceDocuments.template,
        overrides: governanceDocuments.overrides,
      });
    } catch (error) {
      deps.log({
        event: "vk-janitor",
        outcome: "failed",
        reason: failureReason(error),
      });
      throw error;
    }

    if (revocation.outcome === "aborted" || governance.outcome === "aborted") {
      // The group read succeeded and returned nobody. Decision 6: do nothing and
      // say so. Neither loop called `update`, so the message is the whole record.
      deps.log({
        event: "vk-janitor",
        outcome: "aborted",
        reason: revocation.abortReason ?? governance.abortReason,
        members: revocation.memberCount,
      });
      return { revocation, governance };
    }

    deps.log({
      event: "vk-janitor",
      outcome: "ok",
      members: revocation.memberCount,
      managedKeys: revocation.managedKeyCount,
      kept: revocation.kept.length,
      deactivated: revocation.deactivated.length,
      skipped: revocation.skipped.length,
    });
    // One line per key, because "who was revoked, when and why" is the audit
    // trail the deactivation window exists to make reviewable. The name is the
    // owner's email and the reason is a verdict; no key value and no body.
    for (const entry of revocation.deactivated) {
      deps.log({
        event: "vk-janitor",
        outcome: "deactivated",
        name: entry.name,
        reason: entry.reason,
      });
    }
    for (const entry of revocation.skipped) {
      // The hourly `already-inactive` skip is the steady state and would be one
      // line per deactivated key per hour; the summary counts it. The
      // open-item-6 guard is the one worth a name on every run, because it is a
      // mismatch a human has to fix.
      if (entry.reason !== "owner-not-an-email") continue;
      deps.log({
        event: "vk-janitor",
        outcome: "skipped",
        name: entry.name,
        reason: entry.reason,
      });
    }

    // The convergence summary. `changed` is the number decision 6 makes the
    // signal: a run with nothing to do and a run that keeps finding the same
    // difference must not read the same in the log.
    deps.log({
      event: "vk-reconciler",
      outcome: governance.outcome,
      members: governance.memberCount,
      managedKeys: governance.managedKeyCount,
      changed: governance.changed,
      unchanged: governance.unchanged,
      skipped: governance.skipped.length,
      minted: governance.minted,
    });
    // One line per key that changed, with the fields that differed. A steady
    // stream of the same names is the fight worth looking at, so the names are
    // as load-bearing here as the count.
    for (const entry of governance.applied) {
      deps.log({
        event: "vk-reconciler",
        outcome: "converged",
        name: entry.name,
        fields: entry.fields,
      });
    }
    for (const entry of governance.skipped) {
      deps.log({
        event: "vk-reconciler",
        outcome: "skipped",
        name: entry.name,
        reason: entry.reason,
      });
    }

    return { revocation, governance };
  };

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

  log: (entry) => console.log(JSON.stringify(entry)),

  now: () => new Date(),
});
