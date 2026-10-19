/**
 * The real Google read client for the group sync -- the "thin wrapper over the
 * real client" that step 2's `./source` deliberately left out.
 *
 * `docs/google-group-sync.md` keeps the Google read behind one module so that
 * open question 1 (Admin SDK Directory vs Cloud Identity) is a one-file
 * change. This is that file. `fetchSourceMembers` in `./source` only needs the
 * structural `DirectoryClient` (`getGroup`, `listMembers`, with the
 * `pageToken` chain), so everything below is transport: a service-account JWT,
 * a domain-wide-delegation token exchange, and two GETs.
 *
 * **No `googleapis` dependency.** The official client is a very large tree, and
 * this repo builds every image from one `package.json`
 * (`.github/CODEOWNERS` records that as a security property, not a
 * convenience): adding it installs it into the delegate worker that holds the
 * GitHub App token, to make two HTTP GETs. The Admin SDK Directory API is a
 * plain REST API, so the call is a signed JWT and `fetch`, using `node:crypto`
 * which is already there.
 *
 * **The credentials.** The service account key (the JSON file Google hands
 * out) is in Secrets Manager, and the TwoLeggedOAuth flow below impersonates a
 * dedicated admin account (`sub`). Both the scopes and the impersonation are
 * fixed by "IAM -> Google access, read-only" in the plan: exactly the two
 * group read scopes, nothing else. There is no write path here and no scope
 * that could become one.
 *
 * Until the manual Google setup is done (service account, Admin SDK enablement,
 * domain-wide delegation, impersonation admin, key into the secret), a run
 * fails here with a `source-read-failed` abort and changes nothing. That is
 * the intended behaviour, not a bug: an unreadable source is never an empty
 * group.
 */
import { createSign } from "node:crypto";

import { SyncAbortError } from "./errors";
import type { DirectoryClient } from "./source";

/** The two delegated scopes, and the whole of the job's Google access. */
export const GOOGLE_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.member.readonly",
];

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DIRECTORY_ROOT = "https://admin.googleapis.com/admin/directory/v1";
/** The API maximum for `members.list`; fewer pages is fewer chances to fail. */
export const GOOGLE_PAGE_SIZE = 200;

/** The fields of Google's service-account key file this client uses. */
export type ServiceAccountKey = {
  client_email: string;
  private_key: string;
};

/** The shape of `fetch` the client needs, so a test can supply a fake. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * Unpadded, URL-safe base64 (RFC 7515 `base64url`).
 *
 * Takes the bytes themselves, so a caller cannot hand it an already-encoded
 * string by mistake: `Buffer.from(string)` encodes UTF-8, which re-encodes
 * base64 text instead of decoding it. The RSA signature is raw binary and goes
 * through here as a `Buffer`; Node's own `base64url` encoding does the work, so
 * there is one encoding step and no hand-rolled alphabet.
 */
const base64url = (value: Buffer | string): string =>
  Buffer.from(value).toString("base64url");

/**
 * Parses the secret's JSON into the two fields used, failing loudly on
 * anything else. The error never quotes the value: a malformed secret must not
 * put a private key fragment into CloudWatch.
 */
export const parseServiceAccountKey = (raw: string): ServiceAccountKey => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SyncAbortError(
      "source-read-failed",
      "service-account secret is not valid JSON",
    );
  }
  const key = parsed as Partial<ServiceAccountKey>;
  if (typeof key.client_email !== "string" || !key.client_email) {
    throw new SyncAbortError(
      "source-read-failed",
      "service-account secret has no client_email",
    );
  }
  if (typeof key.private_key !== "string" || !key.private_key) {
    throw new SyncAbortError(
      "source-read-failed",
      "service-account secret has no private_key",
    );
  }
  return { client_email: key.client_email, private_key: key.private_key };
};

/**
 * The signed assertion for the two-legged OAuth exchange. `sub` is what makes
 * it domain-wide delegation: the token is issued to the service account but
 * acts as the impersonated admin, which is the only identity the delegated
 * scopes were granted to.
 */
export const buildAssertion = (options: {
  key: ServiceAccountKey;
  impersonationEmail: string;
  nowSeconds: number;
  lifetimeSeconds?: number;
}): string => {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: options.key.client_email,
      sub: options.impersonationEmail,
      scope: GOOGLE_SCOPES.join(" "),
      aud: GOOGLE_TOKEN_URL,
      iat: options.nowSeconds,
      exp: options.nowSeconds + (options.lifetimeSeconds ?? 3600),
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(options.key.private_key);
  // The signature is raw bytes: encode it once. Passing its base64 text through
  // `base64url` would encode it twice and Google would reject every assertion.
  return `${signingInput}.${base64url(signature)}`;
};

type MemberPage = {
  members?: Array<{ email?: string | null; type?: string | null }>;
  nextPageToken?: string | null;
};

/**
 * Builds the Directory client over an access token obtained once per client
 * (one per invocation, which is one run of every pair).
 *
 * Every failure is a `SyncAbortError("source-read-failed")`: the plan's rule is
 * that "any error, any non-2xx, or a page chain that ends without exhausting
 * the token aborts the pair ... a failed or partially paginated read is never
 * treated as an empty group". `./source` turns the throw into the abort; this
 * layer only has to not swallow anything.
 */
export const createDirectoryClient = async (options: {
  keyJson: string;
  impersonationEmail: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<DirectoryClient> => {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const now = options.now ?? (() => Date.now());
  const key = parseServiceAccountKey(options.keyJson);
  if (!options.impersonationEmail) {
    throw new SyncAbortError(
      "source-read-failed",
      "no impersonation admin configured (GOOGLE_IMPERSONATION_EMAIL)",
    );
  }

  let accessToken: string | undefined;
  const getToken = async (): Promise<string> => {
    if (accessToken) return accessToken;
    const assertion = buildAssertion({
      key,
      impersonationEmail: options.impersonationEmail,
      nowSeconds: Math.floor(now() / 1000),
    });
    const response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!response.ok) {
      throw new SyncAbortError(
        "source-read-failed",
        `Google token exchange failed with HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new SyncAbortError(
        "source-read-failed",
        "Google token exchange returned no access_token",
      );
    }
    accessToken = body.access_token;
    return accessToken;
  };

  const getJson = async (path: string): Promise<unknown> => {
    const token = await getToken();
    const response = await fetchImpl(`${DIRECTORY_ROOT}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new SyncAbortError(
        "source-read-failed",
        `Google Directory request failed with HTTP ${response.status}`,
      );
    }
    return response.json();
  };

  return {
    async getGroup({ groupKey }) {
      const body = (await getJson(
        `/groups/${encodeURIComponent(groupKey)}`,
      )) as { id?: string; email?: string };
      return { id: body.id ?? null, email: body.email ?? null };
    },

    async listMembers({ groupKey, pageToken }) {
      const query = new URLSearchParams({
        maxResults: String(GOOGLE_PAGE_SIZE),
      });
      if (pageToken) query.set("pageToken", pageToken);
      const body = (await getJson(
        `/groups/${encodeURIComponent(groupKey)}/members?${query.toString()}`,
      )) as MemberPage;
      return {
        members: (body.members ?? []).map((member) => ({
          email: member.email ?? null,
          type: member.type ?? null,
        })),
        nextPageToken: body.nextPageToken ?? null,
      };
    },
  };
};
