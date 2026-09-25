// A standalone listener for this chunk alone. Phase 2's composition root owns
// the real server; this exists so the front door can be checked before that
// lands.
//
// The check it is here for:
//
//   npx tsx bugboss/mcp/serve.ts
//   curl -i -X POST http://localhost:8080/mcp
//
// The 401 must carry `WWW-Authenticate: Bearer ... resource_metadata="..."`
// spelled exactly that way. API Gateway REST renames it to
// X-Amzn-Remapped-WWW-Authenticate, which kills OAuth discovery silently —
// the client never sees the challenge and auth simply never starts. An ALB
// should pass it through. Run the same curl against the ALB hostname and
// confirm before trusting anything else about auth.

import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { S3Client } from "@aws-sdk/client-s3";
import { Db } from "../db";
import { mcpConfigFromEnv } from "./config";
import { createMcpServer, type BugBossMcp, type McpServerDeps } from "./index";
import { createS3SessionStore } from "./sessions";

export interface ServeMcpOptions extends McpServerDeps {
  port?: number;
  hostname?: string;
}

export const serveMcp = (
  options: ServeMcpOptions,
): { mcp: BugBossMcp; server: ServerType } => {
  const { port = 8080, hostname, ...deps } = options;
  const mcp = createMcpServer(deps);
  const server = serve({ fetch: mcp.fetch, port, hostname }, (info) =>
    console.log(
      JSON.stringify({
        component: "mcp",
        event: "listening",
        port: info.port,
        mcpUrl: `${deps.config.publicUrl}${deps.config.mcpPath}`,
      }),
    ),
  );
  return { mcp, server };
};

/**
 * Stands in for S3 so the server starts with no bucket and no credentials.
 * The header check needs no state at all — the bearer gate refuses before
 * anything reaches a tool — and needing AWS to look at a 401 would defeat
 * the point of being able to run this early.
 */
const localOnlyS3 = (): S3Client =>
  ({
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "GetObjectCommand") {
        const err = new Error("local-only mode: no snapshot");
        err.name = "NoSuchKey";
        throw err;
      }
      return {};
    },
  }) as unknown as S3Client;

if (require.main === module) {
  void (async () => {
    const config = mcpConfigFromEnv();
    // No bucket configured means local scratch mode, which is the normal way
    // to run this. Set BUGBOSS_S3_BUCKET to point at real state instead.
    const bucket = process.env.BUGBOSS_S3_BUCKET;

    serveMcp({
      config,
      db: await Db.open({
        path: process.env.BUGBOSS_DB_PATH ?? "/tmp/bugboss-standalone.db",
        bucket: bucket ?? "local-only",
        key: "state/db",
        s3: bucket ? undefined : localOnlyS3(),
      }),
      sessions: createS3SessionStore({ bucket: bucket ?? "local-only" }),
      // Filing a report needs the Boss's ingest path, which this entry point
      // does not have. The tool answers with an error rather than pretending.
      reportSignal: async () => {
        throw new Error("report_signal is not wired in the standalone server");
      },
      port: Number(process.env.PORT ?? 8080),
    });
  })();
}
