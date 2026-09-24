// The MCP server and its authorization server, in one process on four paths.
//
//   POST /mcp                                       the MCP endpoint
//   GET  /.well-known/oauth-protected-resource/mcp  RFC 9728 metadata
//   GET  /.well-known/oauth-authorization-server    our AS metadata
//        /authorize /callback /token                the AS leg
//
// Design spec: docs/bugboss/design.md, "The MCP server".

import { Hono } from "hono";
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { MCP_SCOPE, type McpConfig, mcpUrl, scopesSupported } from "./config";
import { createGoogleClient, type FetchLike, type GoogleClient } from "./google";
import { createAuthorizationServer } from "./oauth";
import { createTokenService, identityFromAuthInfo } from "./tokens";
import { createIncidentServer, type McpToolDeps } from "./tools";

export interface McpServerDeps extends McpToolDeps {
  config: McpConfig;
  /** Injectable so tests never reach Google. */
  google?: GoogleClient;
  /** Injectable so CIMD resolution never reaches the network in tests. */
  fetchImpl?: FetchLike;
}

export interface BugBossMcp {
  app: Hono;
  /** Web-standard face. Mount this anywhere, or hand it to a node server. */
  fetch: (request: Request) => Promise<Response>;
  close: () => Promise<void>;
}

const methodNotAllowed = () =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
    {
      status: 405,
      headers: { "content-type": "application/json", allow: "POST" },
    },
  );

export const createMcpServer = (deps: McpServerDeps): BugBossMcp => {
  const { config } = deps;
  const tokens = createTokenService(config);
  const google =
    deps.google ?? createGoogleClient(config.google, deps.fetchImpl);
  const authServer = createAuthorizationServer({
    config,
    tokens,
    google,
    fetchImpl: deps.fetchImpl,
  });

  const resourceServerUrl = new URL(mcpUrl(config));
  const resourceMetadataUrl =
    getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  const metadataOptions = {
    oauthMetadata: authServer.metadata,
    resourceServerUrl,
    resourceName: "BugBoss",
    scopesSupported: scopesSupported(config),
  };

  const gate = requireBearerAuth({
    verifier: { verifyAccessToken: tokens.verifyAccessToken },
    requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl,
  });

  const handler = createMcpHandler(
    (ctx) => {
      const identity = identityFromAuthInfo(ctx.authInfo);
      if (!identity) {
        throw new Error("unauthenticated request reached the MCP factory");
      }
      return createIncidentServer(deps, identity);
    },
    {
      // Revision 2026-07-28 removed protocol sessions, the initialize
      // handshake and the GET SSE endpoint, so stateless is the only legal
      // mode. GET and DELETE are answered 405 here too.
      legacy: "stateless",
      // No mid-call notifications, so never upgrade to SSE.
      responseMode: "json",
      // subscriptions/listen is refused outright: a held-open stream bills
      // for its whole duration and clients degrade gracefully without it.
      maxSubscriptions: 0,
      onerror: (error) =>
        console.log(
          JSON.stringify({
            component: "mcp",
            event: "handler_error",
            error: error.message,
          }),
        ),
    },
  );

  const app = new Hono();

  // RFC 9728 and RFC 8414 discovery. Both documents are public by design:
  // an unauthenticated client has to read them to know where to log in.
  app.get("/.well-known/*", (c) => {
    const res = oauthMetadataResponse(c.req.raw, metadataOptions);
    return res ?? c.notFound();
  });

  app.get("/authorize", (c) => authServer.authorize(c.req.raw));
  app.get("/callback", (c) => authServer.callback(c.req.raw));
  app.post("/token", (c) => authServer.token(c.req.raw));

  app.get(config.mcpPath, () => methodNotAllowed());
  app.delete(config.mcpPath, () => methodNotAllowed());

  app.post(config.mcpPath, async (c) => {
    // The 401 from here carries the WWW-Authenticate challenge that starts
    // Claude Code's OAuth flow. API Gateway REST renames that header to
    // X-Amzn-Remapped-WWW-Authenticate and discovery silently never starts;
    // an ALB should pass it through. `curl -i` the 401 through the real front
    // door and confirm the header arrives unrenamed before debugging anything
    // else about auth.
    const auth = await gate(c.req.raw);
    if (auth instanceof Response) return auth;
    return handler.fetch(c.req.raw, { authInfo: auth });
  });

  return {
    app,
    fetch: async (request) => app.fetch(request),
    close: () => handler.close(),
  };
};

export { mcpConfigFromEnv, mcpUrl, MCP_SCOPE } from "./config";
export type { McpConfig } from "./config";
export { createS3SessionStore } from "./sessions";
export type { AgentSession, SessionStore } from "./sessions";
export type {
  HumanBugReport,
  McpToolDeps,
  ReportSignal,
  ReportSignalResult,
} from "./tools";
export type { WorkspaceIdentity } from "./tokens";
