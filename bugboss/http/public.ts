// The public face: the three webhook paths the ALB routes, the health check
// its target group polls, and the MCP server mounted at its own paths.
//
// Design spec: docs/bugboss/design.md, "Topology" and "The MCP server". The
// listener rules in deploy/components/bugboss.ts are an allowlist, so a path
// added here also has to be added there before anything outside can reach it.
// /health is the exception: the target group polls the task directly.

import { Hono } from "hono";
import type { Context } from "hono";

import { IngestRejected } from "./errors";
import { classifySlackEvent, type SlackConfig } from "../ingress/slack";
import type { BugBossMcp } from "../mcp";
import type { SlackEvent } from "../slack/relay";
import type { IncomingRequest } from "../types";

const log = (event: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ component: "boss-http", event, ...data }));

export interface PublicAppDeps {
  ingest: (source: string, req: IncomingRequest) => Promise<unknown>;
  /** Relay plus, where the event warrants one, the Slack agent. */
  slackEvent: (event: SlackEvent) => Promise<void>;
  /** The same config the slack ingress adapter was built with. */
  slackConfig: SlackConfig;
  mcp?: BugBossMcp;
}

const incoming = async (c: Context): Promise<IncomingRequest> => ({
  headers: Object.fromEntries(c.req.raw.headers.entries()),
  rawBody: await c.req.text(),
});

export const createPublicApp = (deps: PublicAppDeps): Hono => {
  const app = new Hono();

  // Flat 200. The container is the only thing serving ingest, so a degraded
  // Boss still beats no Boss: failing this check would have ECS replace a
  // task that is losing alerts rather than one that cannot take them.
  app.get("/health", (c) => c.json({ status: "ok" }));

  app.post("/grafana", async (c) => {
    const req = await incoming(c);
    try {
      await deps.ingest("grafana", req);
    } catch (err) {
      if (err instanceof IngestRejected) {
        log("grafana_rejected", { error: err.message });
        return c.json({ ok: false, error: err.message }, 401);
      }
      throw err;
    }
    return c.json({ ok: true });
  });

  app.post("/slack", async (c) => {
    const req = await incoming(c);

    let classification: Awaited<ReturnType<typeof classifySlackEvent>>;
    try {
      classification = await classifySlackEvent(req, deps.slackConfig);
    } catch (err) {
      log("slack_rejected", { error: String(err) });
      return c.json({ ok: false, error: (err as Error).message }, 401);
    }

    if (classification.kind === "url_verification") {
      return c.text(classification.challenge);
    }

    // A report is a signal, not a question, so it must not also reach the
    // Slack agent: it arrives as an @bugboss mention and would otherwise be
    // answered as one while the incident it opened runs in parallel.
    if (classification.kind === "bug_report") {
      await deps.ingest("slack", req);
      return c.json({ ok: true });
    }

    let event: SlackEvent | undefined;
    try {
      event = (JSON.parse(req.rawBody) as { event?: SlackEvent }).event;
    } catch {
      event = undefined;
    }
    if (event) await deps.slackEvent(event);
    return c.json({ ok: true });
  });

  if (deps.mcp) app.route("/", deps.mcp.app);

  return app;
};
