// One listener. The public app carries the webhooks and the health check;
// the incident agents reach incident state in-process, through ToolApi and
// AgentPort.

import { makeLog } from "../logging";
import { serve, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";

export { IngestRejected } from "./errors";
export { createPublicApp, type PublicAppDeps } from "./public";

const log = makeLog("boss-http");

export const DEFAULT_PUBLIC_PORT = 3000;

export interface HttpConfig {
  publicPort?: number;
}

export interface BugBossServers {
  publicServer: ServerType;
  close: () => void;
}

export const startServers = (args: {
  publicApp: Hono;
  config?: HttpConfig;
}): BugBossServers => {
  const publicPort = args.config?.publicPort ?? DEFAULT_PUBLIC_PORT;

  const publicServer = serve({ fetch: args.publicApp.fetch, port: publicPort }, () =>
    log("public_listening", { port: publicPort }),
  );

  return {
    publicServer,
    close: () => {
      publicServer.close();
    },
  };
};
