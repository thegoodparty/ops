// Two listeners, deliberately. The public one carries the webhooks, the MCP
// endpoint and the health check; the loopback one carries the agent tool API
// and is bound to 127.0.0.1 so it has no route from outside the task at all.
// The per-incident token is the boundary that matters, but binding is free.

import { makeLog } from "../logging";
import { serve, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";

export { IngestRejected } from "./errors";
export { createPublicApp, type PublicAppDeps } from "./public";
export { createToolApiRoutes, type ToolApiHttpDeps } from "./toolapi";

const log = makeLog("boss-http");

export const DEFAULT_PUBLIC_PORT = 3000;
/** Matches createBossClient's default base URL in bugboss/agent/run.ts. */
export const DEFAULT_LOOPBACK_PORT = 8080;

export interface HttpConfig {
  publicPort?: number;
  loopbackPort?: number;
}

export interface BugBossServers {
  publicServer: ServerType;
  loopbackServer: ServerType;
  close: () => void;
}

export const startServers = (args: {
  publicApp: Hono;
  loopbackApp: Hono;
  config?: HttpConfig;
}): BugBossServers => {
  const publicPort = args.config?.publicPort ?? DEFAULT_PUBLIC_PORT;
  const loopbackPort = args.config?.loopbackPort ?? DEFAULT_LOOPBACK_PORT;

  const publicServer = serve({ fetch: args.publicApp.fetch, port: publicPort }, () =>
    log("public_listening", { port: publicPort }),
  );
  const loopbackServer = serve(
    {
      fetch: args.loopbackApp.fetch,
      port: loopbackPort,
      hostname: "127.0.0.1",
    },
    () => log("loopback_listening", { port: loopbackPort }),
  );

  return {
    publicServer,
    loopbackServer,
    close: () => {
      publicServer.close();
      loopbackServer.close();
    },
  };
};
