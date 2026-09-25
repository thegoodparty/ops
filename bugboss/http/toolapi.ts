// The Boss's loopback API: how a real child agent reaches the in-process
// ToolApi. Design spec: bugboss/docs/architecture.md, "Authentication" — "a scoped
// token on a local socket or loopback HTTP, carrying incidentId -> that one
// incident".
//
// The routes here are the server side of createBossClient in
// bugboss/agent/run.ts, and the two must stay in step. Nothing on this app is
// routed by the ALB: the listener rules are an allowlist and /incidents is not
// on it, which is the second fence behind the token.
//
// The routes at the bottom of this file are not ToolApi at all. contact_human
// needs to record that a question is outstanding before it posts, so a
// restarted agent resumes waiting instead of asking a human the same thing
// twice, and ToolApi has nowhere to put that; it lives in the
// pending_question table. It also has to watch for a reply without draining,
// which no ToolApi call can do, so the directive read lives here too.

import { makeAlarm, makeLog } from "../logging";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import type { Db } from "../db";
import type { AgentCredentialProvider } from "../dispatcher/credentials";
import type { ThreadPoster } from "../toolapi";
import { verifyAgentToken } from "../toolapi";
import { postProse } from "../slack/format";
import type { Directive, ToolApi } from "../types";

const log = makeLog("boss-http");
const alarm = makeAlarm("boss-http");

export interface ToolApiHttpDeps {
  db: Db;
  /** The secret the dispatcher's tokens were minted with. */
  tokenSecret: string;
  /** Built against the token the caller presented, not a freshly minted one. */
  toolApiFor: (incidentId: string, token: string) => ToolApi;
  slack: ThreadPoster;
  /** Mints short-lived AWS credentials for a child. Absent when no role is set. */
  credentials?: AgentCredentialProvider;
  now?: () => number;
}

interface Caller {
  incidentId: string;
  token: string;
}

/**
 * The trust boundary. Everything below this line arrived as JSON a model
 * composed, so it is parsed rather than cast: typebox validates the same
 * arguments in the child, which is the untrusted side of the socket. Without
 * this, `reportRootCause({})` reached `args.explainedSignalIds.filter` and
 * came back as "Cannot read properties of undefined" for the model to
 * interpret.
 */
const BODIES = {
  rootCause: z.object({
    cause: z.string().min(1),
    explainedSignalIds: z.array(z.string()),
    usersImpacted: z.number().optional(),
    impactQuery: z.string().optional(),
    impactStartedAt: z.number().int().positive().optional(),
  }),
  impact: z.object({
    usersImpacted: z.number(),
    query: z.string().min(1),
  }),
  resolved: z.object({
    prUrls: z.array(z.string()),
    evidence: z.string().min(1),
  }),
  analysis: z.object({
    postmortem: z.string().min(1),
    usersImpacted: z.number(),
    impactQuery: z.string().min(1),
  }),
  handoff: z.object({
    reason: z.string().min(1),
    brief: z.string().min(1),
  }),
  none: z.object({}),
};

const describeIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) =>
      issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");

const unauthorized = (c: Context, error: string) =>
  c.json({ ok: false, error, directives: [] }, 401, {
    "www-authenticate": 'Bearer realm="bugboss"',
  });

const bearer = (c: Context): string | null => {
  const header = c.req.header("authorization") ?? "";
  return /^bearer /i.test(header) ? header.slice(7).trim() : null;
};

export const createToolApiRoutes = (deps: ToolApiHttpDeps): Hono => {
  const now = deps.now ?? Date.now;
  const app = new Hono();

  /**
   * The incident comes from the token and is only then checked against the
   * path, so a valid token for incident A cannot be pointed at incident B.
   */
  const authorize = (c: Context): Caller | Response => {
    const token = bearer(c);
    if (!token) return unauthorized(c, "missing bearer token");

    let incidentId: string;
    try {
      incidentId = verifyAgentToken(deps.tokenSecret, token).incidentId;
    } catch (err) {
      log("token_rejected", { path: c.req.path, error: String(err) });
      return unauthorized(c, (err as Error).message);
    }

    const requested = c.req.param("id");
    if (requested !== incidentId) {
      log("token_scope_mismatch", { requested, incidentId });
      return c.json(
        {
          ok: false,
          error: `token is scoped to incident ${incidentId}`,
          directives: [],
        },
        403,
      );
    }
    return { incidentId, token };
  };

  /**
   * A rejected transition comes back as HTTP 200 carrying ok:false. The agent
   * reads it as a tool result it can correct; an HTTP error would surface in
   * createBossClient as a thrown harness failure instead.
   */
  const tool = <S extends z.ZodType>(
    schema: S,
    run: (api: ToolApi, body: z.infer<S>) => Promise<unknown>,
  ) =>
    async (c: Context) => {
      const caller = authorize(c);
      if (caller instanceof Response) return caller;

      let raw: unknown = {};
      if (c.req.method !== "GET") {
        try {
          raw = await c.req.json();
        } catch {
          return c.json(
            { ok: false, error: "body was not JSON", directives: [] },
            400,
          );
        }
      }

      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        log("invalid_arguments", {
          path: c.req.path,
          incidentId: caller.incidentId,
        });
        // 200 for the same reason a rejected transition is: the model reads
        // it as a tool result it can correct.
        return c.json({
          ok: false,
          error: `invalid arguments: ${describeIssues(parsed.error)}`,
          directives: [],
        });
      }

      const api = deps.toolApiFor(caller.incidentId, caller.token);
      return c.json(await run(api, parsed.data));
    };

  app.get("/incidents/:id", tool(BODIES.none, (api) => api.getIncident()));

  app.post(
    "/incidents/:id/root-cause",
    tool(BODIES.rootCause, (api, body) => api.reportRootCause(body)),
  );

  app.post(
    "/incidents/:id/impact",
    tool(BODIES.impact, (api, body) => api.reportImpact(body)),
  );

  app.post(
    "/incidents/:id/resolved",
    tool(BODIES.resolved, (api, body) => api.reportResolved(body)),
  );

  app.post(
    "/incidents/:id/analysis",
    tool(BODIES.analysis, (api, body) => api.reportAnalysis(body)),
  );

  app.post(
    "/incidents/:id/handoff",
    tool(BODIES.handoff, (api, body) => api.handOff(body)),
  );

  // -------------------------------------------------------------------------
  // contact_human: the directive poll, the outstanding-question marker and
  // the thread post
  // -------------------------------------------------------------------------

  /**
   * Read-only, and that is the whole point. Every ToolApi response drains the
   * pending directives, so an agent blocked in contact_human polling
   * `getIncident` for a reply would delete the `merged`, `stop` or
   * `resumed_after` it has not read yet. This route leaves them where they
   * are; the drain stays on the calls whose result the model actually reads.
   */
  app.get("/incidents/:id/directives", (c) => {
    const caller = authorize(c);
    if (caller instanceof Response) return caller;
    // db.query is the read-only connection, so a 30-second poll never queues
    // behind the write lock and its synchronous snapshot PUT.
    const rows = deps.db.query<{ id: number; payload: string }>(
      "SELECT id, payload FROM pending_directive WHERE incidentId = ? ORDER BY id",
      [caller.incidentId],
    );
    return c.json(
      rows.map((row) => ({
        id: row.id,
        directive: JSON.parse(row.payload) as Directive,
      })),
    );
  });

  /**
   * Fresh AWS credentials for the child.
   *
   * A role's maximum session duration is twelve hours and an incident can run
   * for a day, so credentials assumed once at launch expire mid-run and the
   * agent loses Bedrock — which is not a degraded agent, it is a dead one.
   *
   * The child cannot re-assume for itself: doing so needs credentials, and
   * the only ones it could use would be the task role, which reads the
   * secret holding every other credential in the system. So the parent keeps
   * that path and hands down short-lived results through the channel the
   * child is already authenticated on.
   */
  app.get("/incidents/:id/aws-credentials", async (c) => {
    const caller = authorize(c);
    if (caller instanceof Response) return caller;
    if (!deps.credentials) {
      return c.json({ ok: false, error: "no agent role is configured" }, 503);
    }
    try {
      const creds = await deps.credentials(caller.incidentId);
      return c.json({ ok: true, ...creds });
    } catch (error: unknown) {
      alarm("agent_credentials_failed", {
        incidentId: caller.incidentId,
        error: String(error),
      });
      return c.json({ ok: false, error: "could not assume the agent role" }, 502);
    }
  });

  /**
   * Removes exactly one directive. contact_human uses it for the reply that
   * ended its wait, which it has already returned as that call's result;
   * re-delivering that one through get_incident would put "yes, go ahead"
   * in front of the model a second time with nothing marking it as answered.
   * Scoped by incidentId as well as id, so a token cannot reach another
   * incident's queue.
   */
  app.delete("/incidents/:id/directives/:directiveId", async (c) => {
    const caller = authorize(c);
    if (caller instanceof Response) return caller;

    const directiveId = Number(c.req.param("directiveId"));
    if (!Number.isInteger(directiveId)) {
      return c.json({ error: "directiveId must be an integer" }, 400);
    }
    await deps.db.withWrite((w) => {
      w.prepare(
        "DELETE FROM pending_directive WHERE id = ? AND incidentId = ?",
      ).run(directiveId, caller.incidentId);
    });
    return c.body(null, 204);
  });

  app.get("/incidents/:id/pending-question", (c) => {
    const caller = authorize(c);
    if (caller instanceof Response) return caller;
    const row = deps.db.get<{ message: string; messageTs: string; askedAt: number }>(
      "SELECT message, messageTs, askedAt FROM pending_question WHERE incidentId = ?",
      [caller.incidentId],
    );
    return c.json(row ?? null);
  });

  /**
   * Idempotent for the same question, and only for the same question. A
   * restarted agent replays the tool call that has no result yet, and the
   * second attempt has to find the first question rather than overwrite its
   * askedAt, which is the watermark replies are matched against.
   *
   * A *different* question is the opposite case. clearPending does not run
   * when the child is SIGKILLed mid-wait, so the marker outlives the question
   * it was written for; leaving it in place would mean the next question is
   * never posted and the agent waits out its whole timeout on an answer to
   * something nobody was ever asked.
   */
  app.post("/incidents/:id/pending-question", async (c) => {
    const caller = authorize(c);
    if (caller instanceof Response) return caller;

    let message = "";
    try {
      message = String(((await c.req.json()) as { message?: unknown }).message ?? "");
    } catch {
      return c.json({ error: "body was not JSON" }, 400);
    }
    if (!message.trim()) return c.json({ error: "message is empty" }, 400);

    const row = await deps.db.withWrite((w) => {
      // messageTs is empty until the post that follows this call succeeds:
      // the marker has to be durable BEFORE the message exists, or a crash
      // between the two asks the human twice.
      w.prepare(
        `INSERT INTO pending_question (incidentId, messageTs, askedAt, message)
         VALUES (?, '', ?, ?)
         ON CONFLICT(incidentId) DO UPDATE SET
           messageTs = '',
           askedAt = excluded.askedAt,
           message = excluded.message
         WHERE pending_question.message <> excluded.message`,
      ).run(caller.incidentId, now(), message);
      return w
        .prepare(
          "SELECT message, messageTs, askedAt FROM pending_question WHERE incidentId = ?",
        )
        .get(caller.incidentId) as {
        message: string;
        messageTs: string;
        askedAt: number;
      };
    });

    log("question_recorded", { incidentId: caller.incidentId, askedAt: row.askedAt });
    return c.json(row);
  });

  app.delete("/incidents/:id/pending-question", async (c) => {
    const caller = authorize(c);
    if (caller instanceof Response) return caller;
    await deps.db.withWrite((w) => {
      w.prepare("DELETE FROM pending_question WHERE incidentId = ?").run(
        caller.incidentId,
      );
    });
    return c.body(null, 204);
  });

  app.post("/incidents/:id/thread", async (c) => {
    const caller = authorize(c);
    if (caller instanceof Response) return caller;

    let message = "";
    try {
      message = String(((await c.req.json()) as { message?: unknown }).message ?? "");
    } catch {
      return c.json({ error: "body was not JSON" }, 400);
    }
    if (!message.trim()) return c.json({ error: "message is empty" }, 400);

    const incident = deps.db.get<{ slackThreadTs: string | null }>(
      "SELECT slackThreadTs FROM incident WHERE id = ?",
      [caller.incidentId],
    );
    if (!incident) return c.json({ error: "unknown incident" }, 404);

    // The agent writes mrkdwn by instruction (agent/prompt.ts) and this is
    // where that is made true rather than hoped for: the Markdown it slips
    // into is converted, `&`, `<` and `>` are escaped so a quoted log line
    // cannot eat the rest of the post, and anything past one message becomes
    // the next post in the thread instead of being truncated by Slack.
    //
    // Only the Slack copy is converted. What the incident stores stays as the
    // agent wrote it, so the Slack agent reading it back later gets prose and
    // not markup.
    const { ts } = await postProse(
      (part) => deps.slack.post(incident.slackThreadTs, part),
      message,
      { incidentId: caller.incidentId },
    );

    // Fills in the ts the marker could not know when it was written. Scoped to
    // a blank one so a later post does not repoint an older question.
    await deps.db.withWrite((w) => {
      w.prepare(
        "UPDATE pending_question SET messageTs = ? WHERE incidentId = ? AND messageTs = ''",
      ).run(ts, caller.incidentId);
    });

    return c.json({ ts });
  });

  return app;
};
