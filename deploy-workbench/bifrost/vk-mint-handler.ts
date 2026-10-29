/**
 * The mint Lambda's entrypoint: step 3 of `docs/bifrost-virtual-keys.md`.
 *
 * The thin shell around `vk-mint-core.ts`. It reads the Function URL event,
 * assumes the read-only membership role, reads the template and the setup
 * token, and speaks to the gateway over HTTP. The decisions — who may mint, the
 * exact-name filter, reactivate-not-recreate, the `409`-then-reread — are in
 * the core so they can be tested without an AWS mock; this file is the wiring,
 * plus the one thing that must not be got wrong here: **it logs neither the key
 * nor a request or response body.** A virtual key appears in both, in
 * plaintext, and the setup token is a deployment-wide admin credential
 * (decision 3).
 *
 * The caller is SigV4-verified by AWS (Function URL, `AuthType: AWS_IAM`) and
 * arrives as `requestContext.authorizer.iam.userArn`. The request body is
 * deliberately never parsed: a caller who posts `{"email": "someone@..."}`
 * gets their own key, because there is no code path that could read it.
 *
 * Environment, all set by `deploy-workbench/bifrost-vk-mint.ts`:
 *
 *   BIFROST_BASE_URL          http://bifrost.workbench.local:8080 — the task,
 *                             via Cloud Map, not the ALB (`/api` there is
 *                             behind oauth2-proxy and Google SSO)
 *   TEMPLATE_PARAMETER_NAME   the SSM String parameter holding the template
 *   SETUP_TOKEN_SECRET_NAME   `bifrost/vk-mint` (decision 3's open item)
 *   SETUP_TOKEN_SECRET_JSON_KEY  BIFROST_SETUP_TOKEN
 *   READER_ROLE_ARN           the management-account `bifrost-vk-reader`
 *   READER_SESSION_NAME       `VK_READER_SESSION_NAME`, imported from the role
 *
 * Nothing here is allowed to grow. Decision 3's requirement is that this
 * function stays small and boring: "it reads a name, a template and the setup
 * token; it makes one or two calls; it returns a key."
 */

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  GetUserIdCommand,
  IdentitystoreClient,
  ListGroupMembershipsCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-identitystore";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

import { IDENTITY_STORE_ID } from "../../utils/accounts";
import {
  ENGINEERS_GROUP_ID,
  GatewayFailure,
  KeyNameConflict,
  MintFailure,
  mintVirtualKey,
  requireEngineer,
  workbenchAccessCaller,
  type MembershipDirectory,
  type VirtualKey,
  type VirtualKeyGateway,
  type VirtualKeyTemplate,
} from "./vk-mint-core";

export const SETUP_TOKEN_JSON_KEY = "BIFROST_SETUP_TOKEN";

/** The Identity Store and STS calls go to the directory's own region. */
const AWS_REGION = process.env.AWS_REGION ?? "us-west-2";

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

export type HttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

export type HandlerDeps = {
  /** Reads and parses the SSM template. Throws when it cannot. */
  readTemplate: () => Promise<VirtualKeyTemplate>;
  /** Reads the setup token out of the secret. Throws when it cannot. */
  readSetupToken: () => Promise<string>;
  /** Assumes the reader role and builds the two directory reads. */
  createDirectory: () => Promise<MembershipDirectory>;
  /** The gateway client, carrying the setup token. */
  createGateway: (setupToken: string) => VirtualKeyGateway;
  /** One structured line per invocation; never given a key or a body. */
  log: (entry: Record<string, unknown>) => void;
};

const json = (statusCode: number, body: unknown): HttpResponse => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * The handler, with its AWS and Bifrost dependencies injected.
 *
 * The order of the checks is the design's: identity first (nothing else costs
 * anything if the caller is wrong), then live membership, then the template,
 * then the gateway. A refusal before the gateway is reached has not read the
 * key name into any log but its own.
 */
export const createHandler =
  (deps: HandlerDeps) =>
  async (event: unknown): Promise<HttpResponse> => {
    const caller = workbenchAccessCaller(event);
    if (!caller) {
      // No email to log: the ARN did not parse as one of ours. Direct
      // `lambda:Invoke` calls arrive here, since they carry no authorizer.
      deps.log({ event: "vk-mint", outcome: "refused", reason: "caller" });
      return json(403, { error: "this endpoint mints a key for a WorkbenchAccess session only" });
    }

    try {
      // Decision 1's second half, before anything is minted. A directory read
      // that fails becomes a 503 in `requireEngineer`, so this cannot fall
      // through to a create.
      let directory: MembershipDirectory;
      try {
        directory = await deps.createDirectory();
      } catch {
        throw new MintFailure(
          "membership-unavailable",
          "could not assume the directory role",
        );
      }
      await requireEngineer(directory, caller.email);

      let template: VirtualKeyTemplate;
      try {
        template = await deps.readTemplate();
      } catch {
        throw new MintFailure(
          "template-unavailable",
          "could not read the key template",
        );
      }

      let setupToken: string;
      try {
        setupToken = await deps.readSetupToken();
      } catch {
        throw new MintFailure(
          "template-unavailable",
          "could not read the setup token",
        );
      }

      const result = await mintVirtualKey({
        gateway: deps.createGateway(setupToken),
        template,
        email: caller.email,
      });

      deps.log({
        event: "vk-mint",
        outcome: result.action,
        email: result.email,
      });
      // The response is the one place the key appears, and it is the caller's
      // own key: the Function URL response is not logged by Lambda.
      return json(200, { key: result.key, email: result.email });
    } catch (error) {
      if (error instanceof MintFailure) {
        deps.log({
          event: "vk-mint",
          outcome: "refused",
          reason: error.code,
          email: caller.email,
        });
        return json(error.status, { error: error.message });
      }
      // Anything else is a bug or an outage. The message is the error's class
      // and, for a GatewayFailure, its status — never a body, because a body
      // could be a key.
      const reason =
        error instanceof GatewayFailure
          ? `gateway-${error.status}`
          : error instanceof Error
            ? error.name
            : "unknown";
      deps.log({
        event: "vk-mint",
        outcome: "failed",
        reason,
        email: caller.email,
      });
      return json(502, { error: "could not mint a key" });
    }
  };

/**
 * The real dependency set. Clients are built inside each function rather than
 * at module load, so importing this module (in a test, or in a bundler) does
 * not construct one.
 */
export const handler = createHandler({
  readTemplate: async () => {
    const ssm = new SSMClient({ region: AWS_REGION });
    const response = await ssm.send(
      new GetParameterCommand({ Name: requireEnv("TEMPLATE_PARAMETER_NAME") }),
    );
    const value = response.Parameter?.Value;
    if (!value) throw new Error("the template parameter has no value");
    return JSON.parse(value) as VirtualKeyTemplate;
  },

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
    const identitystore = new IdentitystoreClient({
      region: AWS_REGION,
      credentials: {
        accessKeyId: credentials.AccessKeyId,
        secretAccessKey: credentials.SecretAccessKey,
        sessionToken: credentials.SessionToken,
      },
    });

    return {
      getUserId: async (email: string) => {
        try {
          const response = await identitystore.send(
            new GetUserIdCommand({
              IdentityStoreId: IDENTITY_STORE_ID,
              AlternateIdentifier: {
                UniqueAttribute: {
                  AttributePath: "emails.value",
                  AttributeValue: email,
                },
              },
            }),
          );
          return response.UserId ?? null;
        } catch (error) {
          // No such user is "not a member", not an outage. Every other error
          // is thrown so the caller fails closed with a 503.
          if (error instanceof ResourceNotFoundException) return null;
          throw error;
        }
      },

      listMemberUserIds: async () => {
        const ids: string[] = [];
        let nextToken: string | undefined;
        do {
          const page = await identitystore.send(
            new ListGroupMembershipsCommand({
              IdentityStoreId: IDENTITY_STORE_ID,
              GroupId: ENGINEERS_GROUP_ID,
              ...(nextToken ? { NextToken: nextToken } : {}),
            }),
          );
          for (const membership of page.GroupMemberships ?? []) {
            const userId = membership.MemberId?.UserId;
            if (userId) ids.push(userId);
          }
          nextToken = page.NextToken;
        } while (nextToken);
        return ids;
      },
    };
  },

  createGateway: (setupToken: string) => {
    const base = requireEnv("BIFROST_BASE_URL").replace(/\/+$/, "");

    /**
     * One request. The setup token goes in `X-Bifrost-Setup-Token`, which is
     * the header the OSS setup lock requires on every non-public `/api` call
     * (`SetupTokenHeader` in `handlers/middlewares.go` at `transports/v2.3.0`).
     * The response text is parsed but never logged, and a non-2xx is turned
     * into a status-only error.
     */
    const call = async (
      method: "GET" | "POST" | "PUT",
      path: string,
      body?: Record<string, unknown>,
    ): Promise<{ status: number; json: unknown }> => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          "X-Bifrost-Setup-Token": setupToken,
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
        value: typeof raw.value === "string" ? raw.value : null,
        is_active: typeof raw.is_active === "boolean" ? raw.is_active : null,
        expires_at: typeof raw.expires_at === "string" ? raw.expires_at : null,
        delete_after_expire:
          typeof raw.delete_after_expire === "boolean"
            ? raw.delete_after_expire
            : null,
        description:
          typeof raw.description === "string" ? raw.description : null,
      };
    };

    /**
     * `virtual_keys` is `null` rather than `[]` on an empty result — observed
     * against the deployed gateway, and worth handling explicitly rather than
     * with a `??` that would hide a malformed body.
     */
    const listFrom = (value: unknown): VirtualKey[] =>
      Array.isArray(value) ? value.map(toKey) : [];

    return {
      list: async ({ search, limit, offset }) => {
        const { status, json: payload } = await call(
          "GET",
          `/api/governance/virtual-keys?search=${encodeURIComponent(search)}&limit=${limit}&offset=${offset}`,
        );
        if (status !== 200) throw new GatewayFailure(status);
        const body = record(payload);
        const totalCount =
          typeof body.total_count === "number" ? body.total_count : undefined;
        return {
          keys: listFrom(body.virtual_keys),
          ...(totalCount === undefined ? {} : { totalCount }),
        };
      },

      create: async (body) => {
        const { status, json: payload } = await call(
          "POST",
          "/api/governance/virtual-keys",
          body,
        );
        // Decision 4: the unique name index is what makes a concurrent first
        // call safe, and the loser's answer is a re-read.
        if (status === 409) throw new KeyNameConflict();
        if (status !== 200) throw new GatewayFailure(status);
        return toKey(record(payload).virtual_key);
      },

      update: async (id, body) => {
        const { status, json: payload } = await call(
          "PUT",
          `/api/governance/virtual-keys/${encodeURIComponent(id)}`,
          body,
        );
        if (status !== 200) throw new GatewayFailure(status);
        return toKey(record(payload).virtual_key);
      },
    };
  },

  log: (entry) => console.log(JSON.stringify(entry)),
});
