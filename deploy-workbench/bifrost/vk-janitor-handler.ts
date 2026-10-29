/**
 * The janitor Lambda's entrypoint: step 5 of `docs/bifrost-virtual-keys.md`.
 *
 * The thin shell around `vk-janitor-core.ts`. It assumes the read-only
 * membership role, reads the setup token, reads the gateway's keys over HTTP,
 * writes the one `PUT` per departed owner, and logs what it did. The decisions
 * — marker only, empty group aborts, the once-only retention timer, every read
 * before the first write — are in the core so they can be tested without an
 * AWS mock.
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
 *   has the error line either way.
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
 */

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
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
  reconcileVirtualKeys,
  type JanitorGateway,
  type JanitorResult,
} from "./vk-janitor-core";

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
 * The handler, with its AWS and Bifrost dependencies injected.
 *
 * A run that reaches the gateway but fails a read logs one `failed` line and
 * rethrows. A run that reads an empty group logs `aborted` and returns: the
 * read succeeded and said "nobody", which is a state to look at rather than a
 * failure to retry into a mass deactivation.
 */
export const createJanitorHandler =
  (deps: JanitorDeps) =>
  async (_event: unknown): Promise<JanitorResult> => {
    let result: JanitorResult;
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

      result = await reconcileVirtualKeys({
        directory,
        gateway: deps.createGateway(setupToken),
        now: deps.now(),
      });
    } catch (error) {
      deps.log({
        event: "vk-janitor",
        outcome: "failed",
        reason:
          error instanceof JanitorFailure
            ? error.code
            : error instanceof GatewayFailure
              ? `gateway-${error.status}`
              : error instanceof Error
                ? error.name
                : "unknown",
      });
      throw error;
    }

    if (result.outcome === "aborted") {
      // The group read succeeded and returned nobody. Decision 6: do nothing
      // and say so. No `update` was called, so the message is the whole record.
      deps.log({
        event: "vk-janitor",
        outcome: "aborted",
        reason: result.abortReason,
        members: result.memberCount,
      });
      return result;
    }

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
    return result;
  };

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
    };
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

  createGateway: (setupToken: string) =>
    createJanitorGateway({
      baseUrl: requireEnv("BIFROST_BASE_URL"),
      setupToken,
    }),

  log: (entry) => console.log(JSON.stringify(entry)),

  now: () => new Date(),
});
