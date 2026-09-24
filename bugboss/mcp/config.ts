// Configuration for the MCP server and the colocated authorization server.
// Design spec: docs/bugboss/design.md, "The MCP server".

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface McpConfig {
  /** Public origin the ALB serves, no trailing slash. */
  publicUrl: string;
  /** Path the MCP endpoint is mounted at. */
  mcpPath: string;
  /**
   * HS256 secret for our authorization codes and access tokens. The AS and
   * the resource server are the same process, so one shared secret does it:
   * no JWKS, no KMS.
   */
  jwtSecret: string;
  google: GoogleOAuthConfig;
  /** Google Workspace domain. The `hd` claim must equal this exactly. */
  workspaceDomain: string;
  /**
   * clientId -> allowed redirect URIs. CIMD covers Claude Code, which
   * publishes its own document; this covers anything that does not.
   */
  preRegisteredClients: Record<string, string[]>;
  accessTokenTtlSeconds: number;
  authCodeTtlSeconds: number;
  /** Lifetime of the signed state we hand Google on the way out. */
  flowStateTtlSeconds: number;
  /**
   * Claude Code's `appendOfflineAccess` defaults on, and Google does not
   * advertise `offline_access`. We advertise it so the appended scope is not
   * an unknown one, and strip it before anything reaches Google. Turn this
   * off if a client rejects the advertisement.
   */
  advertiseOfflineAccess: boolean;
}

export const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** The scope an access token needs to reach the MCP endpoint. */
export const MCP_SCOPE = "mcp";

/** Scopes we ask Google for. Identity only; we never call a Google API. */
export const GOOGLE_SCOPES = ["openid", "email", "profile"];

const required = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key];
  if (!value) throw new Error(`missing required env var ${key}`);
  return value;
};

const optionalInt = (
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number => {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`env var ${key} must be a positive number, got ${raw}`);
  }
  return parsed;
};

/**
 * Pre-registered clients as `clientId=uri1,uri2;clientId2=uri3`. Empty when
 * unset, which leaves CIMD as the only way in.
 */
const parsePreRegisteredClients = (raw: string | undefined) => {
  const clients: Record<string, string[]> = {};
  if (!raw) return clients;
  for (const entry of raw.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      throw new Error(`malformed BUGBOSS_MCP_CLIENTS entry: ${trimmed}`);
    }
    const clientId = trimmed.slice(0, separator).trim();
    const uris = trimmed
      .slice(separator + 1)
      .split(",")
      .map((uri) => uri.trim())
      .filter(Boolean);
    if (!clientId || uris.length === 0) {
      throw new Error(`malformed BUGBOSS_MCP_CLIENTS entry: ${trimmed}`);
    }
    clients[clientId] = uris;
  }
  return clients;
};

export const mcpConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): McpConfig => ({
  publicUrl: required(env, "BUGBOSS_PUBLIC_URL").replace(/\/+$/, ""),
  mcpPath: env.BUGBOSS_MCP_PATH ?? "/mcp",
  jwtSecret: required(env, "BUGBOSS_MCP_JWT_SECRET"),
  google: {
    clientId: required(env, "BUGBOSS_GOOGLE_CLIENT_ID"),
    clientSecret: required(env, "BUGBOSS_GOOGLE_CLIENT_SECRET"),
    authorizationEndpoint:
      env.BUGBOSS_GOOGLE_AUTH_ENDPOINT ?? GOOGLE_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: env.BUGBOSS_GOOGLE_TOKEN_ENDPOINT ?? GOOGLE_TOKEN_ENDPOINT,
  },
  workspaceDomain: env.BUGBOSS_WORKSPACE_DOMAIN ?? "goodparty.org",
  preRegisteredClients: parsePreRegisteredClients(env.BUGBOSS_MCP_CLIENTS),
  accessTokenTtlSeconds: optionalInt(env, "BUGBOSS_MCP_TOKEN_TTL", 3600),
  authCodeTtlSeconds: optionalInt(env, "BUGBOSS_MCP_CODE_TTL", 60),
  flowStateTtlSeconds: optionalInt(env, "BUGBOSS_MCP_FLOW_TTL", 600),
  advertiseOfflineAccess: env.BUGBOSS_MCP_OFFLINE_ACCESS !== "false",
});

export const mcpUrl = (config: McpConfig): string =>
  `${config.publicUrl}${config.mcpPath}`;

/** RFC 8707 resource identifier. Same as the MCP URL, fragment stripped. */
export const resourceIdentifier = (config: McpConfig): string =>
  mcpUrl(config);

export const issuerUrl = (config: McpConfig): string => config.publicUrl;

export const scopesSupported = (config: McpConfig): string[] =>
  config.advertiseOfflineAccess ? [MCP_SCOPE, "offline_access"] : [MCP_SCOPE];
