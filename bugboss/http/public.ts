// The public face: the webhook paths the ALB routes, and the health check its
// target group polls.
//
// Design spec: bugboss/docs/architecture.md, "Topology". The listener rules in
// deploy/components/bugboss.ts are an allowlist, so a path added here also has
// to be added there before anything outside can reach it. /health is the
// exception: the target group polls the task directly.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";

import { IngestRejected } from "./errors";
import { classifySlackEvent, type SlackConfig } from "../ingress/slack";
import type { SlackEvent } from "../slack/relay";
import type { IncomingRequest } from "../types";
import { makeAlarm, makeLog } from "../logging";

const log = makeLog("boss-http");

const alarm = makeAlarm("boss-http");

/**
 * Both webhook paths take the same handshake: the part that has to be durable
 * before the source is answered has already happened, and the part that costs
 * model calls is a promise nobody here waits on. Stated in the minimum these
 * routes read rather than in the composition root's types, so this file stays
 * a leaf for the same reason IngestRejected lives beside it.
 */
interface Accepted {
  settled: Promise<unknown>;
}

export interface PublicAppDeps {
  /** Records the delivery; placing it runs past the response. */
  ingestAccepted: (
    source: string,
    req: IncomingRequest,
  ) => Promise<Accepted & { recorded: number }>;
  /** Relays the event; answering it, if it earns one, runs past the response. */
  slackEventAccepted: (event: SlackEvent) => Promise<Accepted>;
  /** The same config the slack ingress adapter was built with. */
  slackConfig: SlackConfig;
}

const incoming = async (c: Context): Promise<IncomingRequest> => ({
  headers: Object.fromEntries(c.req.raw.headers.entries()),
  rawBody: await c.req.text(),
});

/**
 * The half that outlives the response. Nothing is left to return it to, so an
 * unhandled rejection here is a dropped alert with no record of the drop; the
 * work itself alarms per signal, and this is the backstop under that.
 */
const settle = (work: Promise<unknown>, route: string): void => {
  void work.catch((err: unknown) =>
    alarm("deferred_failed", { route, error: String(err) }),
  );
};

export const createPublicApp = (deps: PublicAppDeps): Hono => {
  const app = new Hono();

  // Hono catches anything a handler throws and answers 500 on its own, which
  // is the one failure path that would otherwise leave no trace: a DB write
  // failure in ingest is a dropped alert, and dropping it quietly is the
  // thing this system exists not to do. Registered on the app rather than
  // per route so a route added later cannot forget it. The routes that
  // answer 401 return that response rather than throwing, so they do not
  // come through here — anything reaching this really is unexpected.
  app.onError((err, c) => {
    alarm("route_failed", {
      method: c.req.method,
      path: c.req.path,
      error: String(err),
    });
    return c.json({ ok: false, error: "internal error" }, 500);
  });

  // Flat 200. The container is the only thing serving ingest, so a degraded
  // Boss still beats no Boss: failing this check would have ECS replace a
  // task that is losing alerts rather than one that cannot take them.
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Both webhook handlers read the whole body before anything authenticates
  // it, because the HMAC is over the raw bytes and there is nothing to verify
  // until all of them are here. That order cannot change, so the bound has to
  // come first: without it an anonymous caller makes one 16 GiB task hold an
  // arbitrary number of arbitrary-length bodies and answers each 401, which is
  // the deploy-window outage handed to whoever wants it.
  //
  // A megabyte is far above any real delivery. The contact point runs with
  // `maxAlerts: 0` so a burst is never truncated, and a refusal here would
  // silently recreate the truncation that setting exists to prevent — hence an
  // alarm rather than a log. If this fires for a real burst, raise the
  // ceiling; it must not become routine.
  const ingestBodyLimit = bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => {
      alarm("body_rejected", {
        path: c.req.path,
        contentLength: c.req.header("content-length") ?? "unset",
        note: "a delivery exceeded the ingest body limit and was refused unread",
      });
      return c.json({ ok: false, error: "body too large" }, 413);
    },
  });

  app.post("/grafana", ingestBodyLimit);
  app.post("/slack", ingestBodyLimit);

  // The contact point runs uncapped, so a burst arrives as one delivery and
  // costs a prefetch and a triage call per alert. Held open, that outlasts
  // Grafana's own webhook timeout and the ALB's 60s idle timeout, and the
  // retry that follows arrives while the first delivery is still working. So
  // the rows go down inside the request and the placement runs after it.
  app.post("/grafana", async (c) => {
    const req = await incoming(c);
    let accepted: Accepted & { recorded: number };
    try {
      accepted = await deps.ingestAccepted("grafana", req);
    } catch (err) {
      if (err instanceof IngestRejected) {
        log("grafana_rejected", { error: err.message });
        return c.json({ ok: false, error: err.message }, 401);
      }
      throw err;
    }
    settle(accepted.settled, "grafana");
    return c.json({ ok: true, recorded: accepted.recorded });
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
      const accepted = await deps.ingestAccepted("slack", req);
      settle(accepted.settled, "slack_report");
      return c.json({ ok: true });
    }

    let event: SlackEvent | undefined;
    try {
      event = (JSON.parse(req.rawBody) as { event?: SlackEvent }).event;
    } catch {
      event = undefined;
    }
    // Slack wants an ack in three seconds and retries three times without
    // one, and the agent behind a mention runs for up to two minutes.
    if (event) settle((await deps.slackEventAccepted(event)).settled, "slack");
    return c.json({ ok: true });
  });

  return app;
};
