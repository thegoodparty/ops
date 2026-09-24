// The Google login leg, and the Workspace restriction.
//
// Google is the login upstream, never the authorization server: it has no
// RFC 8707 support so it cannot mint a token bound to our MCP server, and the
// access token it issues is opaque and carries no `hd`. Accepting one would
// be the confused-deputy pattern the spec forbids. So we take an ID token
// once, at /callback, check it, and mint our own.
//
// Design spec: docs/bugboss/design.md, "Restricting to our Workspace".

import jwt from "jsonwebtoken";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { GOOGLE_SCOPES, type GoogleOAuthConfig } from "./config";
import type { WorkspaceIdentity } from "./tokens";

export interface GoogleIdClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nonce?: string;
  hd?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export interface GoogleClient {
  authorizationUrl(args: {
    redirectUri: string;
    state: string;
    nonce: string;
    hd: string;
  }): string;
  /** Swaps Google's code for an ID token. Never returns the access token. */
  exchangeCode(args: {
    code: string;
    redirectUri: string;
  }): Promise<{ idToken: string }>;
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const GOOGLE_ISSUERS = new Set([
  "accounts.google.com",
  "https://accounts.google.com",
]);

const accessDenied = (message: string) =>
  new OAuthError(OAuthErrorCode.AccessDenied, message);

export const createGoogleClient = (
  google: GoogleOAuthConfig,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): GoogleClient => ({
  authorizationUrl: ({ redirectUri, state, nonce, hd }) => {
    const url = new URL(google.authorizationEndpoint);
    url.searchParams.set("client_id", google.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    // A UI hint that pre-fills the account chooser. It is not a control —
    // only the `hd` claim on the returned ID token is.
    url.searchParams.set("hd", hd);
    return url.toString();
  },

  exchangeCode: async ({ code, redirectUri }) => {
    const res = await fetchImpl(google.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: google.clientId,
        client_secret: google.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });

    const body = await res.text();
    if (!res.ok) {
      throw accessDenied(`google token exchange failed (${res.status})`);
    }

    let parsed: { id_token?: string };
    try {
      parsed = JSON.parse(body) as { id_token?: string };
    } catch {
      throw accessDenied("google token endpoint returned non-JSON");
    }
    if (!parsed.id_token) {
      throw accessDenied("google token response carried no id_token");
    }
    return { idToken: parsed.id_token };
  },
});

/**
 * Validates the ID token's envelope claims.
 *
 * The signature is deliberately not checked, and this is spec-compliant
 * rather than a shortcut: OIDC Core 3.1.3.7 step 6 allows TLS server
 * validation in place of signature checking when the token arrives by direct
 * client-to-token-endpoint communication, which is exactly this flow,
 * authenticated with our client secret.
 *
 * Do not "fix" this by adding a JWKS fetch. If we ever do want that second
 * layer, it belongs behind the `GoogleClient` port, not here.
 */
export const verifyGoogleIdToken = (
  idToken: string,
  args: { clientId: string; nonce: string; now?: number },
): GoogleIdClaims => {
  const decoded = jwt.decode(idToken);
  if (!decoded || typeof decoded !== "object") {
    throw accessDenied("google id_token could not be decoded");
  }
  const claims = decoded as GoogleIdClaims;

  if (!claims.iss || !GOOGLE_ISSUERS.has(claims.iss)) {
    throw accessDenied(`unexpected id_token issuer: ${claims.iss}`);
  }

  const audiences = Array.isArray(claims.aud)
    ? claims.aud
    : claims.aud
      ? [claims.aud]
      : [];
  if (!audiences.includes(args.clientId)) {
    throw accessDenied("id_token audience is not our client");
  }

  const now = args.now ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) {
    throw accessDenied("id_token is expired");
  }

  if (claims.nonce !== args.nonce) {
    throw accessDenied("id_token nonce does not match the authorization flow");
  }

  return claims;
};

/**
 * The Workspace restriction. All three claims are checked and each one alone
 * is enough to refuse.
 *
 * `email_verified` is not optional: a consumer Google account can carry an
 * `email` claim nobody verified, so omitting it is a real bypass. `hd` is the
 * stronger assertion — it says the account is managed by that Workspace, not
 * merely that an address was verified — and costs one comparison.
 */
export const assertWorkspaceIdentity = (
  claims: GoogleIdClaims,
  domain: string,
): WorkspaceIdentity => {
  if (claims.hd !== domain) {
    throw accessDenied(`account is not managed by ${domain}`);
  }
  if (claims.email_verified !== true) {
    throw accessDenied("google account email is not verified");
  }
  if (!claims.email || !claims.email.endsWith(`@${domain}`)) {
    throw accessDenied(`account email is not an @${domain} address`);
  }
  if (!claims.sub) {
    throw accessDenied("id_token carries no subject");
  }
  return { sub: claims.sub, email: claims.email, name: claims.name };
};
