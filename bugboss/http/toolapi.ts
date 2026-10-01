// The Boss's loopback API: how a real child agent reaches the in-process
// ToolApi. Design spec: bugboss/docs/architecture.md, "The agent boundary" —
// a scoped token on loopback HTTP, carrying incidentId -> that one incident.
//
// The routes here are the server side of createBossClient in
// bugboss/agent/run.ts, and the two must stay in step. Nothing on this app is
// routed by the ALB: the listener rules are an allowlist and /incidents is not
// on it, which is the second fence behind the token.
//
// The routes at the bottom of this file are not ToolApi at all. message_boss
// needs to record that a question is outstanding, so a restarted agent
// resumes waiting instead of asking the Boss the same thing twice, and ToolApi
// has nowhere to put that; it lives in the pending_question table. It also
// has to watch for an answer without draining, which no ToolApi call can do,
// so the directive read lives here too. And everything an agent says to a
// person arrives at the Boss's inbox through here: no route on this app posts
// to Slack. The last two forward request_sql_query to the SQL sidecar, which
// posts its own approval request; the Boss only names the thread.

import { makeAlarm, makeLog } from "../logging";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { recordForBoss } from "../boss/inbox";
import type { Db } from "../db";
import { readTimelineEvents, verifyAgentToken } from "../toolapi";
import { TIMELINE_EVENT_KINDS } from "../types";
import type { Directive, ToolApi, WakeBoss } from "../types";

const log = makeLog("boss-http");
const alarm = makeAlarm("boss-http");

export interface ToolApiHttpDeps {
  db: Db;
  /** The secret the dispatcher's tokens were minted with. */
  tokenSecret: string;
  /** Built against the token the caller presented, not a freshly minted one. */
  toolApiFor: (incidentId: string, token: string) => ToolApi;
  /** Runs the Boss for an incident whose inbox just gained a row. */
  wakeBoss: WakeBoss;
  /**
   * Tells the dispatcher the agent sent up its own escalation brief, so its
   * deadline does not post a placeholder over it. A harness rung while the
   * agent waits is not a brief and does not count. A real child reaches this
   * route with no dispatcher in the call.
   */
  noteEscalated: (incidentId: string) => void;
  /**
   * The SQL sidecar (`bugboss/sqlrunner`), from BUGBOSS_SQL_RUNNER_URL. It
   * holds the database password and asks a person in the incident thread
   * before it runs anything; this side only names the thread. Unset leaves
   * request_sql_query in the agent's tool list answering with an error and an
   * alarm, so the prompt prefix does not change with configuration.
   */
  sqlRunnerUrl?: string;
  /** Reaches the sidecar. Tests inject a fake one. */
  fetchImpl?: typeof fetch;
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
  proposeMerge: z.object({
    incidentId: z.string().min(1),
    reason: z.string().min(1),
  }),
  // Length is not checked here. The tool API refuses an over-long summary
  // with a sentence the model can act on; a zod max would come back as
  // "String must contain at most 80 character(s)", which names no field and
  // says nothing about what to do instead.
  summary: z.object({
    summary: z.string().min(1),  }),
  impact: z.object({
    usersImpacted: z.number(),
    query: z.string().min(1),
  }),
  resolved: z.object({
    // A url, because it is rendered as a Slack link and anything else inside
    // `<…>` is a directive: `<!channel>` pages everyone.
    prUrls: z.array(z.url()),
    evidence: z.string().min(1),
  }),
  // Shape only. Empty sections, the five whys' count and practiceChanges'
  // length are refused by the tool API, with a sentence naming the section
  // and what to write instead.
  analysis: z.object({
    atAGlance: z.string(),
    timeline: z.array(
      z.object({
        at: z.string().optional(),
        event: z.string(),
        evidenceUrl: z.url().optional(),
        recordedEventId: z.number().int().optional(),
      }),
    ),
    userImpact: z.string(),
    rootCause: z.string(),
    fiveWhys: z.array(z.object({ why: z.string(), because: z.string() })),
    resolutionActions: z.array(z.string()),
    practiceChanges: z.string(),
    usersImpacted: z.number(),
    impactQuery: z.string().min(1),
    recurrence: z
      .object({
        category: z.enum([
          "previous_fix_wrong",
          "previous_fix_incomplete",
          "alert_is_wrong",
          "fix_never_reached_production",
          "resolution_evidence_too_weak",
          "bugboss_defect",
        ]),
        why: z.string().min(1),
        remedy: z.string().min(1),
      })
      .optional(),
  }),
  search: z.object({
    text: z.string().min(1),
  }),
  timeline: z.object({
    kind: z.enum(TIMELINE_EVENT_KINDS),
    occurredAt: z.number().int().positive(),
    summary: z.string().trim().min(1),
    evidenceUrl: z.url().optional(),
  }),
  park: z.object({
    waitingFor: z.string().min(1),
    wakeAfterSeconds: z.number().int().nonnegative().optional(),
    liftsOnReply: z.boolean().optional(),
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
    run: (api: ToolApi, body: z.infer<S>, c: Context) => Promise<unknown>,
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
      return c.json(await run(api, parsed.data, c));
    };

  // `?incident=` reads another incident. The path id still has to be the
  // caller's own -- `authorize` rejects anything else, and the token is what
  // scopes the writes -- so this asks for a read without widening the
  // credential. Absent, it is the caller's own incident, which is every call
  // that existed before reads opened up.
  app.get(
    "/incidents/:id",
    tool(BODIES.none, (api, _body, c) => {
      const other = c.req.query("incident");
      return api.getIncident(other ? { incidentId: other } : undefined);
    }),
  );

  app.post(
    "/incidents/:id/propose-merge",
    tool(BODIES.proposeMerge, (api, body) => api.proposeMerge(body)),
  );

  app.post(
    "/incidents/:id/root-cause",
    tool(BODIES.rootCause, (api, body) => api.reportRootCause(body)),
  );

  app.post(
    "/incidents/:id/summary",
    tool(BODIES.summary, (api, body) => api.setSummary(body)),
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
    "/incidents/:id/park",
    tool(BODIES.park, (api, body) => api.park(body)),
  );

  // POST rather than GET because the query is a body, not a path. It still
  // changes nothing, and it drains directives like every other tool call --
  // which is correct here: unlike the directive poll, its result is read by
  // the model on the turn it returns.
  app.post(
    "/incidents/:id/search",
    tool(BODIES.search, (api, body) => api.searchIncidents(body)),
  );

  app.post(
    "/incidents/:id/timeline",
    tool(BODIES.timeline, (api, body) => api.trackTimelineEvent(body)),
  );

  /**
   * Read-only, for the stage compaction: it runs between turns, and a read
   * through `getIncident` would drain directives into a result the model
   * never sees.
   */
  app.get("/incidents/:id/timeline", (c) => {
    const caller = authorize(c);
    if (caller instanceof Response) return caller;
    return c.json(readTimelineEvents(deps.db, caller.incidentId));
  });

  // -------------------------------------------------------------------------
  // message_boss: the inbox, the directive poll and the outstanding-question
  // marker
  // -------------------------------------------------------------------------

  /**
   * The only way anything an agent writes leaves it for a person. The row is
   * committed before the Boss is woken, so a Boss run that starts on the wake
   * always finds it, and a wake that lands while the Boss is already running
   * is picked up by that run rather than lost.
   *
   * No length limit. The Boss is the reader, not a phone, and what reaches a
   * person is the Boss's own words.
   */
  app.post("/incidents/:id/boss-inbox", async (c) => {
    const caller = authorize(c);
    if (caller instanceof Response) return caller;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body was not JSON" }, 400);
    }
    const parsed = z
      .object({
        kind: z.enum(["message", "question", "escalation"]),
        text: z.string().trim().min(1),
        ownBrief: z.boolean().optional(),
      })
      .safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: describeIssues(parsed.error) }, 400);
    }

    const exists = deps.db.get<{ id: string }>(
      "SELECT id FROM incident WHERE id = ?",
      [caller.incidentId],
    );
    if (!exists) return c.json({ error: "unknown incident" }, 404);

    const id = await deps.db.withWrite((w) =>
      recordForBoss(w, {
        incidentId: caller.incidentId,
        kind: parsed.data.kind,
        text: parsed.data.text,
      }),
    );
    log("boss_inbox_recorded", {
      incidentId: caller.incidentId,
      kind: parsed.data.kind,
      id,
    });
    if (parsed.data.kind === "escalation" && parsed.data.ownBrief) {
      deps.noteEscalated(caller.incidentId);
    }
    deps.wakeBoss(caller.incidentId);
    return c.json({ id });
  });

  /**
   * How many escalations have gone up since a moment, and when the last one
   * did. An unanswered question re-escalates on a doubling gap, and reading
   * the gap off the inbox rather than off a counter is what lets it survive
   * a restart: the rows are the record of what the Boss has been told.
   */
  app.get("/incidents/:id/boss-inbox/escalations", (c) => {
    const caller = authorize(c);
    if (caller instanceof Response) return caller;
    const since = Number(c.req.query("since") ?? "0");
    if (!Number.isFinite(since)) {
      return c.json({ error: "since must be epoch millis" }, 400);
    }
    const row = deps.db.get<{ count: number; lastAt: number | null }>(
      `SELECT COUNT(*) AS count, MAX(createdAt) AS lastAt FROM boss_inbox
        WHERE incidentId = ? AND kind = 'escalation' AND createdAt >= ?`,
      [caller.incidentId, since],
    );
    return c.json(row ?? { count: 0, lastAt: null });
  });

  /**
   * Read-only, and that is the whole point. Every ToolApi response drains the
   * pending directives, so an agent blocked in message_boss polling
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
   * Removes exactly one directive. message_boss uses it for the answer that
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
    const row = deps.db.get<{ message: string; askedAt: number }>(
      "SELECT message, askedAt FROM pending_question WHERE incidentId = ?",
      [caller.incidentId],
    );
    return c.json(row ?? null);
  });

  /**
   * Idempotent for the same question, and only for the same question. A
   * restarted agent replays the tool call that has no result yet, and the
   * second attempt has to find the first question rather than overwrite its
   * askedAt, which is what the unanswered-question clock runs from.
   *
   * A *different* question is the opposite case. clearPending does not run
   * when the child is SIGKILLed mid-wait, so the marker outlives the question
   * it was written for; leaving it in place would give the next question the
   * old one's askedAt, and it would escalate as unanswered the moment it was
   * asked.
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
      // messageTs is written and read by nothing; it is NOT NULL with no
      // default, so an insert still has to name it.
      w.prepare(
        `INSERT INTO pending_question (incidentId, messageTs, askedAt, message)
         VALUES (?, '', ?, ?)
         ON CONFLICT(incidentId) DO UPDATE SET
           askedAt = excluded.askedAt,
           message = excluded.message
         WHERE pending_question.message <> excluded.message`,
      ).run(caller.incidentId, now(), message);
      return w
        .prepare("SELECT message, askedAt FROM pending_question WHERE incidentId = ?")
        .get(caller.incidentId) as { message: string; askedAt: number };
    });

    log("question_recorded", { incidentId: caller.incidentId, askedAt: row.askedAt });
    return c.json(row);
  });

  /**
   * The wait marker monitor keeps while it is blocked on a person. Idempotent
   * for the same command, and only for the same command: a restart replays
   * the tool call and has to find the wait it was already in -- overwriting
   * startedAt there would restart the elapsed clock and defer every reminder for
   * as long as the restarts last. A different command is a different wait, and
   * inherits neither the clock nor the reminder count.
   *
   * `waitingFor` is taken on every call, the same command included: it is
   * the label people read, and a replay that words it better should show.
   */
  app.post("/incidents/:id/pending-wait", async (c) => {
    const caller = authorize(c);
    if (caller instanceof Response) return caller;

    let command = "";
    let waitingFor = "";
    try {
      const body = (await c.req.json()) as { command?: unknown; waitingFor?: unknown };
      command = String(body.command ?? "");
      waitingFor = String(body.waitingFor ?? "").trim();
    } catch {
      return c.json({ error: "body was not JSON" }, 400);
    }
    if (!command.trim()) return c.json({ error: "command is empty" }, 400);

    const row = await deps.db.withWrite((w) => {
      w.prepare(
        `INSERT INTO pending_wait (incidentId, command, waitingFor, startedAt, pings, lastPingAt)
         VALUES (?, ?, ?, ?, 0, NULL)
         ON CONFLICT(incidentId) DO UPDATE SET
           waitingFor = COALESCE(excluded.waitingFor, pending_wait.waitingFor),
           startedAt = CASE WHEN pending_wait.command = excluded.command
             THEN pending_wait.startedAt ELSE excluded.startedAt END,
           pings = CASE WHEN pending_wait.command = excluded.command
             THEN pending_wait.pings ELSE 0 END,
           lastPingAt = CASE WHEN pending_wait.command = excluded.command
             THEN pending_wait.lastPingAt ELSE NULL END,
           command = excluded.command`,
      ).run(caller.incidentId, command, waitingFor || null, now());
      return w
        .prepare(
          "SELECT command, startedAt, pings, lastPingAt FROM pending_wait WHERE incidentId = ?",
        )
        .get(caller.incidentId) as {
        command: string;
        startedAt: number;
        pings: number;
        lastPingAt: number | null;
      };
    });

    return c.json(row);
  });

  /**
   * Counted before the reminder is sent, so a crash between the two costs one
   * reminder rather than repeating it on every resume. A missing marker is an
   * error rather than an upsert: there is no wait to count against, and
   * inventing one would start the clock at the moment of the fault.
   */
  app.post("/incidents/:id/pending-wait/ping", async (c) => {
    const caller = authorize(c);
    if (caller instanceof Response) return caller;

    const row = await deps.db.withWrite((w) => {
      w.prepare(
        "UPDATE pending_wait SET pings = pings + 1, lastPingAt = ? WHERE incidentId = ?",
      ).run(now(), caller.incidentId);
      return w
        .prepare(
          "SELECT command, startedAt, pings, lastPingAt FROM pending_wait WHERE incidentId = ?",
        )
        .get(caller.incidentId) as
        | {
            command: string;
            startedAt: number;
            pings: number;
            lastPingAt: number | null;
          }
        | undefined;
    });
    if (!row) return c.json({ error: "no wait is recorded" }, 404);

    log("wait_ping_recorded", { incidentId: caller.incidentId, pings: row.pings });
    return c.json(row);
  });

  app.delete("/incidents/:id/pending-wait", async (c) => {
    const caller = authorize(c);
    if (caller instanceof Response) return caller;
    await deps.db.withWrite((w) => {
      w.prepare("DELETE FROM pending_wait WHERE incidentId = ?").run(
        caller.incidentId,
      );
    });
    return c.body(null, 204);
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

  // -------------------------------------------------------------------------
  // request_sql_query: forwarded to the SQL sidecar
  // -------------------------------------------------------------------------

  const sqlRunner = deps.sqlRunnerUrl?.replace(/\/$/, "");
  const sidecarFetch = deps.fetchImpl ?? fetch;

  /**
   * The sidecar's answer goes back verbatim, status and body, because it is
   * the side that decides: a semicolon, a second pending request, a missing
   * rotation group are its refusals to word, and the agent reads them as
   * they were written. Everything that stops the call before the sidecar
   * answers alarms as well as erroring. An agent told "try again later" with
   * nobody else told is how a capability stays broken for weeks.
   */
  const forwardToSqlRunner = async (
    c: Context,
    incidentId: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Response> => {
    if (!sqlRunner) {
      alarm("sql_runner_unconfigured", { incidentId });
      return c.json(
        { error: "the SQL runner is not configured on this Boss (BUGBOSS_SQL_RUNNER_URL is unset); nothing was asked" },
        503,
      );
    }

    let response: Response;
    try {
      response = await sidecarFetch(`${sqlRunner}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      alarm("sql_runner_unreachable", { incidentId, path, error: String(err) });
      return c.json(
        { error: `the SQL runner could not be reached: ${String(err)}` },
        502,
      );
    }

    const text = await response.text();
    if (response.status >= 500) {
      alarm("sql_runner_error", { incidentId, path, status: response.status, body: text });
    } else if (!response.ok) {
      log("sql_runner_refused", { incidentId, path, status: response.status });
    }
    return new Response(text, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  };

  /**
   * The Boss adds the thread, and that is all it adds. It is a convenience,
   * not a check: the agent can reach the sidecar on loopback directly and
   * name any incident and thread it likes, so the sidecar confirms with Slack
   * that the thread is this incident's before it posts anything.
   */
  app.post("/incidents/:id/sql-requests", async (c) => {
    const caller = authorize(c);
    if (caller instanceof Response) return caller;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body was not JSON" }, 400);
    }
    // Shape only. What a query may contain is the sidecar's to refuse, so its
    // wording is the only one the agent ever reads about it.
    const parsed = z.object({ sql: z.string(), reason: z.string() }).safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: describeIssues(parsed.error) }, 400);
    }

    // The sidecar's contract takes an integer, and every production id is
    // one (`MAX(id)+1`). Anything else is a row nothing here should exist for.
    const incidentId = Number(caller.incidentId);
    if (!Number.isSafeInteger(incidentId)) {
      alarm("sql_request_bad_incident_id", { incidentId: caller.incidentId });
      return c.json({ error: `incident ${caller.incidentId} has no integer id; nothing was asked` }, 500);
    }

    const row = deps.db.get<{ slackThreadTs: string | null }>(
      "SELECT slackThreadTs FROM incident WHERE id = ?",
      [caller.incidentId],
    );
    if (!row) {
      alarm("sql_request_unknown_incident", { incidentId: caller.incidentId });
      return c.json({ error: `unknown incident ${caller.incidentId}; nothing was asked` }, 404);
    }
    if (!row.slackThreadTs) {
      alarm("sql_request_no_thread", { incidentId: caller.incidentId });
      return c.json(
        {
          error: `incident ${caller.incidentId} has no Slack thread yet, so there is nowhere to ask for approval; nothing was asked`,
        },
        409,
      );
    }

    return forwardToSqlRunner(c, caller.incidentId, "POST", "/requests", {
      incidentId,
      threadTs: row.slackThreadTs,
      sql: parsed.data.sql,
      reason: parsed.data.reason,
    });
  });

  // Not checked against the caller's incident: the sidecar's answer does not
  // say whose request it was, and the id is a random UUID only its creator
  // was handed. Reads are not contained here anyway (toolapi/CLAUDE.md).
  app.get("/incidents/:id/sql-requests/:requestId", (c) => {
    const caller = authorize(c);
    if (caller instanceof Response) return caller;
    const requestId = c.req.param("requestId");
    // It goes into the sidecar's path, so nothing in it may move the path.
    if (!/^[A-Za-z0-9-]+$/.test(requestId)) {
      return c.json({ error: "requestId is not a request id" }, 400);
    }
    return forwardToSqlRunner(c, caller.incidentId, "GET", `/requests/${requestId}`);
  });

  return app;
};
