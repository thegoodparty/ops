// The authorization server, colocated with the resource server.
//
// Three legs: /authorize sends the engineer to Google, /callback checks the
// ID token and mints our 60-second authorization code, /token swaps that code
// for an HS256 access token whose `aud` is the MCP URL.
//
// Design spec: bugboss/docs/architecture.md, "The shape".

import type { OAuthMetadata } from "@modelcontextprotocol/server";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import {
  MCP_SCOPE,
  type McpConfig,
  issuerUrl,
  resourceIdentifier,
  scopesSupported,
} from "./config";
import {
  assertWorkspaceIdentity,
  type FetchLike,
  type GoogleClient,
  verifyGoogleIdToken,
} from "./google";
import { type FlowState, type TokenService, verifyPkce } from "./tokens";

export interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
}

export interface AuthorizationServer {
  /** RFC 8414 document served at /.well-known/oauth-authorization-server. */
  metadata: OAuthMetadata;
  authorize(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
  token(request: Request): Promise<Response>;
}

const CIMD_CACHE_TTL_MS = 5 * 60 * 1000;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const oauthErrorResponse = (err: unknown): Response => {
  if (OAuthError.isInstance(err)) {
    const status = err.code === OAuthErrorCode.InvalidClient ? 401 : 400;
    return json(err.toResponseObject(), status);
  }
  return json(
    { error: OAuthErrorCode.ServerError, error_description: "unexpected error" },
    500,
  );
};

/** The origin, or null when the value will not parse as a URL at all. */
const originOf = (value: string): string | null => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const invalidRequest = (message: string) =>
  new OAuthError(OAuthErrorCode.InvalidRequest, message);

/**
 * Claude Code's `appendOfflineAccess` defaults on and Google does not
 * advertise `offline_access`, so it arrives here and must never reach Google
 * or cause a refusal. We grant `mcp` and drop the rest.
 */
const grantedScopes = (requested: string | null): string[] => {
  const asked = (requested ?? "").split(" ").filter(Boolean);
  const granted = new Set<string>([MCP_SCOPE]);
  for (const scope of asked) {
    if (scope === MCP_SCOPE) granted.add(scope);
  }
  return [...granted];
};

export const createAuthorizationServer = (deps: {
  config: McpConfig;
  tokens: TokenService;
  google: GoogleClient;
  fetchImpl?: FetchLike;
}): AuthorizationServer => {
  const { config, tokens, google } = deps;
  const fetchImpl =
    deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const issuer = issuerUrl(config);
  const callbackUri = `${config.publicUrl}/callback`;
  const resource = resourceIdentifier(config);
  const cimdCache = new Map<
    string,
    { client: RegisteredClient; expiresAt: number }
  >();

  // CIMD covers Claude Code, which publishes its own document, so engineers
  // configure nothing. DCR stays off: it is deprecated in the current spec
  // and would expose an unauthenticated write endpoint.
  const resolveViaCimd = async (clientId: string): Promise<RegisteredClient> => {
    const cached = cimdCache.get(clientId);
    if (cached && cached.expiresAt > Date.now()) return cached.client;

    const res = await fetchImpl(clientId, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new OAuthError(
        OAuthErrorCode.InvalidClient,
        `client id metadata document unreachable (${res.status})`,
      );
    }

    let doc: { client_id?: string; redirect_uris?: unknown };
    try {
      doc = JSON.parse(await res.text()) as typeof doc;
    } catch {
      throw new OAuthError(
        OAuthErrorCode.InvalidClientMetadata,
        "client id metadata document is not JSON",
      );
    }

    if (doc.client_id !== clientId) {
      throw new OAuthError(
        OAuthErrorCode.InvalidClientMetadata,
        "client id metadata document does not claim this client_id",
      );
    }
    const redirectUris = Array.isArray(doc.redirect_uris)
      ? doc.redirect_uris.filter((uri): uri is string => typeof uri === "string")
      : [];
    if (redirectUris.length === 0) {
      throw new OAuthError(
        OAuthErrorCode.InvalidClientMetadata,
        "client id metadata document lists no redirect_uris",
      );
    }

    const client = { clientId, redirectUris };
    cimdCache.set(clientId, {
      client,
      expiresAt: Date.now() + CIMD_CACHE_TTL_MS,
    });
    return client;
  };

  const resolveClient = async (
    clientId: string | null,
  ): Promise<RegisteredClient> => {
    if (!clientId) throw invalidRequest("client_id is required");
    const preRegistered = config.preRegisteredClients[clientId];
    if (preRegistered) return { clientId, redirectUris: preRegistered };
    if (clientId.startsWith("https://")) {
      // A CIMD client_id is a URL this server then fetches, and /authorize is
      // unauthenticated by design at the start of an OAuth flow. Without an
      // allowlist any internet caller picks the destination of an outbound
      // request from inside the VPC, which is a server-side request forgery:
      // the task has a public IP and unrestricted egress, so that reaches
      // link-local metadata, internal services, and anything that acts on a
      // GET.
      //
      // Allowlisted by origin, and empty means allow nothing. The spec does
      // not require accepting an arbitrary URL — which clients are trusted is
      // a deployment decision, and ours is a short list.
      const origin = originOf(clientId);
      if (!origin || !config.cimdAllowedOrigins.includes(origin)) {
        throw new OAuthError(
          OAuthErrorCode.InvalidClient,
          "client_id origin is not permitted",
        );
      }
      return resolveViaCimd(clientId);
    }
    throw new OAuthError(OAuthErrorCode.InvalidClient, "unknown client_id");
  };

  const redirectWithError = (
    redirectUri: string,
    clientState: string | null,
    err: unknown,
  ): Response => {
    const target = new URL(redirectUri);
    const body = OAuthError.isInstance(err)
      ? err.toResponseObject()
      : { error: OAuthErrorCode.ServerError, error_description: "unexpected error" };
    target.searchParams.set("error", body.error);
    if (body.error_description) {
      target.searchParams.set("error_description", body.error_description);
    }
    if (clientState) target.searchParams.set("state", clientState);
    return Response.redirect(target.toString(), 302);
  };

  const metadata: OAuthMetadata = {
    issuer,
    authorization_endpoint: `${config.publicUrl}/authorize`,
    token_endpoint: `${config.publicUrl}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: scopesSupported(config),
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };

  return {
    metadata,

    authorize: async (request) => {
      const params = new URL(request.url).searchParams;
      const clientState = params.get("state");

      let client: RegisteredClient;
      let redirectUri: string;
      try {
        client = await resolveClient(params.get("client_id"));
        const requested = params.get("redirect_uri");
        if (!requested) throw invalidRequest("redirect_uri is required");
        if (!client.redirectUris.includes(requested)) {
          throw new OAuthError(
            OAuthErrorCode.InvalidRedirectUri,
            "redirect_uri is not registered for this client",
          );
        }
        redirectUri = requested;
      } catch (err) {
        // Nothing here is safe to redirect: an unvalidated redirect_uri is an
        // open redirect, so the refusal is rendered instead.
        return oauthErrorResponse(err);
      }

      try {
        if (params.get("response_type") !== "code") {
          throw new OAuthError(
            OAuthErrorCode.UnsupportedResponseType,
            "only response_type=code is supported",
          );
        }
        const codeChallenge = params.get("code_challenge");
        if (!codeChallenge) throw invalidRequest("code_challenge is required");
        if (params.get("code_challenge_method") !== "S256") {
          throw invalidRequest("code_challenge_method must be S256");
        }

        const requestedResource = params.get("resource");
        if (requestedResource && requestedResource !== resource) {
          throw new OAuthError(
            OAuthErrorCode.InvalidTarget,
            `resource must be ${resource}`,
          );
        }

        const { token, nonce } = tokens.mintFlowState({
          clientId: client.clientId,
          redirectUri,
          codeChallenge,
          resource: requestedResource,
          scopes: grantedScopes(params.get("scope")),
          clientState,
        });

        return Response.redirect(
          google.authorizationUrl({
            redirectUri: callbackUri,
            state: token,
            nonce,
            hd: config.workspaceDomain,
          }),
          302,
        );
      } catch (err) {
        return redirectWithError(redirectUri, clientState, err);
      }
    },

    callback: async (request) => {
      const params = new URL(request.url).searchParams;

      let state: FlowState;
      try {
        const rawState = params.get("state");
        if (!rawState) throw invalidRequest("state is required");
        state = tokens.verifyFlowState(rawState);
      } catch (err) {
        return oauthErrorResponse(err);
      }

      try {
        const googleError = params.get("error");
        if (googleError) {
          throw new OAuthError(
            OAuthErrorCode.AccessDenied,
            `google refused the login: ${googleError}`,
          );
        }
        const code = params.get("code");
        if (!code) throw invalidRequest("code is required");

        const { idToken } = await google.exchangeCode({
          code,
          redirectUri: callbackUri,
        });
        const claims = verifyGoogleIdToken(idToken, {
          clientId: config.google.clientId,
          nonce: state.nonce,
        });
        const identity = assertWorkspaceIdentity(claims, config.workspaceDomain);

        const target = new URL(state.redirectUri);
        target.searchParams.set(
          "code",
          tokens.mintAuthorizationCode(state, identity),
        );
        if (state.clientState) {
          target.searchParams.set("state", state.clientState);
        }
        target.searchParams.set("iss", issuer);
        return Response.redirect(target.toString(), 302);
      } catch (err) {
        return redirectWithError(state.redirectUri, state.clientState, err);
      }
    },

    token: async (request) => {
      try {
        if (request.method !== "POST") {
          throw new OAuthError(
            OAuthErrorCode.MethodNotAllowed,
            "token endpoint accepts POST only",
          );
        }
        const form = new URLSearchParams(await request.text());

        if (form.get("grant_type") !== "authorization_code") {
          throw new OAuthError(
            OAuthErrorCode.UnsupportedGrantType,
            "only authorization_code is supported",
          );
        }
        const code = form.get("code");
        if (!code) throw invalidRequest("code is required");
        const verifier = form.get("code_verifier");
        if (!verifier) throw invalidRequest("code_verifier is required");

        const claims = tokens.redeemAuthorizationCode(code);
        verifyPkce(verifier, claims.codeChallenge);

        const clientId = form.get("client_id");
        if (clientId && clientId !== claims.clientId) {
          throw new OAuthError(
            OAuthErrorCode.InvalidGrant,
            "client_id does not match the authorization code",
          );
        }
        const redirectUri = form.get("redirect_uri");
        if (redirectUri && redirectUri !== claims.redirectUri) {
          throw new OAuthError(
            OAuthErrorCode.InvalidGrant,
            "redirect_uri does not match the authorization code",
          );
        }
        const requestedResource = form.get("resource");
        if (requestedResource && requestedResource !== resource) {
          throw new OAuthError(
            OAuthErrorCode.InvalidTarget,
            `resource must be ${resource}`,
          );
        }

        const { token, expiresIn } = tokens.mintAccessToken({
          identity: claims.identity,
          clientId: claims.clientId,
          scopes: claims.scopes,
        });

        return json(
          {
            access_token: token,
            token_type: "Bearer",
            expires_in: expiresIn,
            scope: claims.scopes.join(" "),
          },
          200,
        );
      } catch (err) {
        return oauthErrorResponse(err);
      }
    },
  };
};
