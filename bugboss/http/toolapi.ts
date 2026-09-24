// The Boss's loopback API: how a real child agent reaches the in-process
// ToolApi. Design spec: docs/bugboss/design.md, "Authentication" — "a scoped
// token on a local socket or loopback HTTP, carrying incidentId -> that one
// incident".
//
// The routes here are the server side of createBossClient in
// bugboss/agent/run.ts, and the two must stay in step. Nothing on this app is
// routed by the ALB: the listener rules are an allowlist and /incidents is not
// on it, which is the second fence behind the token.
//
// Two of the ten routes are not ToolApi at all. contact_human needs to record
// that a question is outstanding before it posts, so a restarted agent resumes
// waiting instead of asking a human the same thing twice, and ToolApi has
// nowhere to put that. It lives in the pending_question table, reached through
// the four routes at the bottom of this file.

import { Hono } from "hono";
import type { Context } from "hono";

import type { Db } from "../db";
import type { ThreadPoster } from "../toolapi";
import { verifyAgentToken } from "../toolapi";
import type { ToolApi } from "../types";

const log = (event: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ component: "boss-http", event, ...data }));

export interface ToolApiHttpDeps {
  db: Db;
  /** The secret the dispatcher's tokens were minted with. */
  tokenSecret: string;
  /** Built against the token the caller presented, not a freshly minted one. */
  toolApiFor: (incidentId: string, token: string) => ToolApi;
  slack: ThreadPoster;
  now?: () => number;
}

interface Caller {
  incidentId: string;
  token: string;
}

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
  const tool = (
    run: (api: ToolApi, body: Record<string, unknown>) => Promise<unknown>,
  ) =>
    async (c: Context) => {
      const caller = authorize(c);
      if (caller instanceof Response) return caller;

      let body: Record<string, unknown> = {};
      if (c.req.method !== "GET") {
        try {
          body = (await c.req.json()) as Record<string, unknown>;
        } catch {
          return c.json(
            { ok: false, error: "body was not JSON", directives: [] },
            400,
          );
        }
      }

      const api = deps.toolApiFor(caller.incidentId, caller.token);
      return c.json(await run(api, body));
    };

  app.get("/incidents/:id", tool((api) => api.getIncident()));

  app.post(
    "/incidents/:id/root-cause",
    tool((api, body) =>
      api.reportRootCause(
        body as unknown as Parameters<ToolApi["reportRootCause"]>[0],
      ),
    ),
  );

  app.post(
    "/incidents/:id/impact",
    tool((api, body) =>
      api.reportImpact(body as unknown as Parameters<ToolApi["reportImpact"]>[0]),
    ),
  );

  app.post(
    "/incidents/:id/resolved",
    tool((api, body) =>
      api.reportResolved(
        body as unknown as Parameters<ToolApi["reportResolved"]>[0],
      ),
    ),
  );

  app.post(
    "/incidents/:id/analysis",
    tool((api, body) =>
      api.reportAnalysis(
        body as unknown as Parameters<ToolApi["reportAnalysis"]>[0],
      ),
    ),
  );

  app.post(
    "/incidents/:id/handoff",
    tool((api, body) =>
      api.handOff(body as unknown as Parameters<ToolApi["handOff"]>[0]),
    ),
  );

  // -------------------------------------------------------------------------
  // contact_human: the outstanding-question marker and the thread post
  // -------------------------------------------------------------------------

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
   * Idempotent on purpose. A restarted agent replays the tool call that has no
   * result yet, and the second attempt has to find the first question rather
   * than overwrite its askedAt, which is the watermark replies are matched
   * against.
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
        `INSERT OR IGNORE INTO pending_question (incidentId, messageTs, askedAt, message)
         VALUES (?, '', ?, ?)`,
      ).run(caller.incidentId, now(), message);
      return w
        .prepare(
          "SELECT message, askedAt FROM pending_question WHERE incidentId = ?",
        )
        .get(caller.incidentId) as { message: string; askedAt: number };
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

    const { ts } = await deps.slack.post(incident.slackThreadTs, message);

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
