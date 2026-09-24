// Our own tokens: the signed state we hand Google, the 60-second
// authorization code, and the access token the MCP endpoint accepts.
//
// Design spec: docs/bugboss/design.md, "The shape". State is nearly nil
// because everything durable is carried inside a signed JWT. The only
// server-side memory is a redeemed-code set for replay prevention, which a
// single process holds in a Map.

import { createHash, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
} from "@modelcontextprotocol/server";
import { type McpConfig, issuerUrl, mcpUrl } from "./config";

/** A verified Google Workspace member. The only identity we ever mint for. */
export interface WorkspaceIdentity {
  /** Google `sub`, stable per user. */
  sub: string;
  email: string;
  name?: string;
}

export interface FlowState {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  scopes: string[];
  /** The client's own `state`, handed back untouched. */
  clientState: string | null;
  nonce: string;
}

export interface AuthorizationCodeClaims extends FlowState {
  identity: WorkspaceIdentity;
  jti: string;
}

const TOKEN_TYPE_STATE = "bugboss-flow-state";
const TOKEN_TYPE_CODE = "bugboss-auth-code";
const TOKEN_TYPE_ACCESS = "bugboss-access";

const base64UrlSha256 = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");

const invalidGrant = (message: string) =>
  new OAuthError(OAuthErrorCode.InvalidGrant, message);

export interface TokenService {
  mintFlowState(state: Omit<FlowState, "nonce">): { token: string; nonce: string };
  verifyFlowState(token: string): FlowState;
  mintAuthorizationCode(state: FlowState, identity: WorkspaceIdentity): string;
  /** Verifies, enforces single use, and returns the binding. */
  redeemAuthorizationCode(code: string): AuthorizationCodeClaims;
  mintAccessToken(args: {
    identity: WorkspaceIdentity;
    clientId: string;
    scopes: string[];
  }): { token: string; expiresIn: number };
  /** The `OAuthTokenVerifier` the bearer gate runs. Throws `OAuthError`. */
  verifyAccessToken(token: string): Promise<AuthInfo>;
}

export const createTokenService = (config: McpConfig): TokenService => {
  const issuer = issuerUrl(config);
  const audience = mcpUrl(config);
  // Codes already redeemed, held until they would have expired anyway.
  const redeemed = new Map<string, number>();

  const pruneRedeemed = () => {
    const now = Date.now();
    for (const [jti, expiresAt] of redeemed) {
      if (expiresAt <= now) redeemed.delete(jti);
    }
  };

  const sign = (payload: object, ttlSeconds: number, aud: string) =>
    jwt.sign({ ...payload }, config.jwtSecret, {
      algorithm: "HS256",
      issuer,
      audience: aud,
      expiresIn: ttlSeconds,
    });

  const verify = <T>(token: string, aud: string, onFail: string): T => {
    try {
      return jwt.verify(token, config.jwtSecret, {
        algorithms: ["HS256"],
        issuer,
        audience: aud,
      }) as T;
    } catch (err) {
      throw invalidGrant(`${onFail}: ${(err as Error).message}`);
    }
  };

  return {
    mintFlowState: (state) => {
      const nonce = randomUUID();
      const token = sign(
        { ...state, nonce, typ: TOKEN_TYPE_STATE },
        config.flowStateTtlSeconds,
        TOKEN_TYPE_STATE,
      );
      return { token, nonce };
    },

    // Projected field by field rather than returned whole: a verified payload
    // still carries iss/aud/exp/iat, and passing those back into sign() makes
    // jsonwebtoken refuse the next token outright.
    verifyFlowState: (token) => {
      const claims = verify<FlowState>(
        token,
        TOKEN_TYPE_STATE,
        "invalid authorization state",
      );
      return {
        clientId: claims.clientId,
        redirectUri: claims.redirectUri,
        codeChallenge: claims.codeChallenge,
        resource: claims.resource,
        scopes: claims.scopes,
        clientState: claims.clientState,
        nonce: claims.nonce,
      };
    },

    mintAuthorizationCode: (state, identity) =>
      sign(
        { ...state, identity, jti: randomUUID(), typ: TOKEN_TYPE_CODE },
        config.authCodeTtlSeconds,
        TOKEN_TYPE_CODE,
      ),

    redeemAuthorizationCode: (code) => {
      const claims = verify<AuthorizationCodeClaims & { exp: number }>(
        code,
        TOKEN_TYPE_CODE,
        "invalid authorization code",
      );
      pruneRedeemed();
      if (redeemed.has(claims.jti)) {
        throw invalidGrant("authorization code already redeemed");
      }
      redeemed.set(claims.jti, claims.exp * 1000);
      return claims;
    },

    mintAccessToken: ({ identity, clientId, scopes }) => ({
      token: sign(
        {
          sub: identity.sub,
          email: identity.email,
          name: identity.name,
          client_id: clientId,
          scope: scopes.join(" "),
          typ: TOKEN_TYPE_ACCESS,
        },
        config.accessTokenTtlSeconds,
        audience,
      ),
      expiresIn: config.accessTokenTtlSeconds,
    }),

    // Every failure path here throws OAuthError. A plain Error would surface
    // as a 500, and a 500 never triggers Claude Code's OAuth flow — it
    // presents as auth silently not working.
    verifyAccessToken: async (token) => {
      let claims: jwt.JwtPayload;
      try {
        claims = jwt.verify(token, config.jwtSecret, {
          algorithms: ["HS256"],
          issuer,
          audience,
        }) as jwt.JwtPayload;
      } catch (err) {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          `invalid access token: ${(err as Error).message}`,
        );
      }

      if (claims.typ !== TOKEN_TYPE_ACCESS) {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "token is not an access token",
        );
      }
      if (typeof claims.exp !== "number") {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "access token has no expiry",
        );
      }

      const email = claims.email;
      if (typeof email !== "string" || !email) {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "access token carries no email",
        );
      }

      const scopes =
        typeof claims.scope === "string" ? claims.scope.split(" ") : [];

      return {
        token,
        clientId: typeof claims.client_id === "string" ? claims.client_id : "",
        scopes,
        expiresAt: claims.exp,
        resource: new URL(audience),
        extra: { sub: claims.sub, email, name: claims.name },
      };
    },
  };
};

/** RFC 7636 S256. The only method we accept; `plain` is not OAuth 2.1. */
export const verifyPkce = (verifier: string, challenge: string): void => {
  if (base64UrlSha256(verifier) !== challenge) {
    throw invalidGrant("PKCE verification failed");
  }
};

export const identityFromAuthInfo = (
  authInfo: AuthInfo | undefined,
): WorkspaceIdentity | null => {
  const extra = authInfo?.extra;
  if (!extra || typeof extra.email !== "string") return null;
  return {
    sub: typeof extra.sub === "string" ? extra.sub : "",
    email: extra.email,
    name: typeof extra.name === "string" ? extra.name : undefined,
  };
};
