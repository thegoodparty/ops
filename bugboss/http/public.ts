// The public face: the webhook paths the ALB routes, and the health check its
// target group polls.
//
// Design spec: bugboss/docs/architecture.md, "Topology". The listener rules in
// deploy/components/bugboss.ts are an allowlist, so a path added here also has
// to be added there before anything outside can reach it. /health is the
// exception: the target group polls the task directly.

import { Hono } from "hono";
import type { Context, Next } from "hono";

import { BodyUnreadable, IngestRejected } from "./errors";
import { classifySlackEvent, type SlackConfig } from "../ingress/slack";
import type { SlackEvent } from "../slack/relay";
import type { IncomingRequest } from "../types";
import { makeAlarm, makeLog } from "../logging";

const log = makeLog("boss-http");

const alarm = makeAlarm("boss-http");

/** Far above any real Grafana or Slack delivery. */
const MAX_BODY_BYTES = 1024 * 1024;


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
  // come through here.
  //
  // A caller hanging up mid-body is the exception, and `incoming` names it as
  // BodyUnreadable so this does not have to guess. Reading the body is the
  // first thing both webhook routes do, before anything authenticates the
  // request, so an anonymous caller that declares a length and then
  // disconnects makes it throw. Alarming on that lets anyone on the internet
  // bury a real `route_failed` — the backstop for a dropped alert — under any
  // volume of identical lines, which is precisely the "an alarm that fires
  // during normal operation teaches people to ignore alarms" failure,
  // arriving from outside.
  app.onError((err, c) => {
    if (err instanceof BodyUnreadable) {
      log("client_aborted", { method: c.req.method, path: c.req.path });
      return c.json({ ok: false, error: "bad request" }, 400);
    }
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
  // Written out rather than using hono/body-limit, which reads the stream
  // itself when there is no content-length. A read that fails there throws
  // from inside the middleware, where the only thing left to classify it by is
  // the error message — and an attacker picks whether to send a content-length.
  // Reading it here means the limit and the disconnect are decided in the one
  // place that knows a body read is what failed.
  //
  // A megabyte is far above any real delivery. The contact point runs with
  // `maxAlerts: 0` so a burst is never truncated, and a refusal here would
  // silently recreate the truncation that setting exists to prevent — hence an
  // alarm rather than a log. If this fires for a real burst, raise the
  // ceiling; it must not become routine.
  const tooLarge = (c: Context, declared: string | null): Response => {
    alarm("body_rejected", {
      path: c.req.path,
      contentLength: declared ?? "unset",
      note: "a delivery exceeded the ingest body limit and was refused",
    });
    return c.json({ ok: false, error: "body too large" }, 413);
  };

  const ingestBody = async (c: Context, next: Next): Promise<Response | void> => {
    const raw = c.req.raw;
    if (!raw.body) return next();

    const declared = raw.headers.get("content-length");
    if (declared && Number(declared) > MAX_BODY_BYTES) return tooLarge(c, declared);

    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = raw.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BODY_BYTES) {
          // Cancel rather than just return. getReader() takes an exclusive
          // lock on the body, and abandoning it holds that lock and whatever
          // the sender is still pushing until GC gets round to it — which is
          // the resource the limit exists to bound, kept alive by the path
          // that enforces it.
          await reader.cancel();
          return tooLarge(c, declared);
        }
        chunks.push(value);
      }
    } catch (err) {
      // The caller went away mid-body. Named as a type here, where a failed
      // read is the only thing that can have happened, so the error handler
      // never has to infer it from a message.
      //
      // Cancelling a stream that already failed is a no-op, and it throwing
      // must not replace the reason we are here.
      await reader.cancel().catch(() => {});
      throw new BodyUnreadable(String(err));
    }

    c.req.raw = new Request(raw, {
      body: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      // @ts-expect-error required by undici for a stream body, and absent from
      // the standard RequestInit the DOM types describe.
      duplex: "half",
    });
    return next();
  };

  app.post("/grafana", ingestBody);
  app.post("/slack", ingestBody);

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
