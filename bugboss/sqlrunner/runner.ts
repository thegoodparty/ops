// The SQL runner's state machine and its HTTP surface. Everything that
// decides anything lives here; `slack.ts` and `execute.ts` are the wiring it
// is handed, which is what lets the tests drive it with fakes.
//
// A request is approved by a reaction on the runner's own message, read back
// from Slack, from somebody in the on-call rotation who is not the bot. Not a
// button: the agent holds the signing secret and could forge the click over
// loopback. Not anything the agent can say: it holds the bot token, so the
// bot user is excluded, and it could `chat.update` our message to show a
// person different SQL than we stored, so the message is re-read and compared
// before anything runs. See CLAUDE.md.

import { randomUUID } from "node:crypto";

import { Hono } from "hono";

import { makeAlarm, makeLog } from "../logging";
import { mrkdwn, raw, userMention } from "../slack/format";

const log = makeLog("sqlrunner");
const alarm = makeAlarm("sqlrunner");

export const MAX_SQL_CHARS = 4000;
export const MAX_REASON_CHARS = 1000;
export const ROW_CAP = 200;
export const MAX_RESULT_CHARS = 100_000;
export const MAX_PENDING_TOTAL = 5;
export const PENDING_TTL_MS = 3600 * 1000;
export const TERMINAL_TTL_MS = 2 * 3600 * 1000;
export const ROTATION_TTL_MS = 60 * 1000;
export const APPROVE_REACTION = "arrow_forward";
export const REFUSE_REACTION = "x";

export type RequestStatus =
  | "pending"
  | "running"
  | "done"
  | "refused"
  | "failed"
  | "expired";

export interface Reaction {
  name: string;
  users: string[];
}

export interface PostedReply {
  text: string;
  edited: boolean;
}

/**
 * The four Slack reads and two writes the runner makes. Every one of them is
 * on our own message in an incident thread; nothing here reads anything else.
 */
export interface SqlRunnerSlack {
  /** chat.postMessage in a thread. Returns the message ts and the text as Slack stored it. */
  post(
    channel: string,
    threadTs: string,
    text: string,
  ): Promise<{ ts: string; text: string }>;
  update(channel: string, ts: string, text: string): Promise<void>;
  /** reactions.get. Null when the message no longer exists. */
  reactions(channel: string, ts: string): Promise<Reaction[] | null>;
  /** One reply in a thread, or null when it is not there. */
  reply(
    channel: string,
    threadTs: string,
    ts: string,
  ): Promise<PostedReply | null>;
  rotationMembers(usergroupId: string): Promise<string[]>;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

/**
 * Runs one statement and returns at most ROW_CAP + 1 rows, so the caller can
 * tell "exactly 200" from "more than 200" without ever holding more.
 */
export type QueryExecutor = (sql: string) => Promise<QueryResult>;

export interface SqlRunnerConfig {
  slack: SqlRunnerSlack;
  execute: QueryExecutor;
  channelId: string;
  botUserId: string;
  rotationGroupId: string | null;
  now?: () => number;
}

interface SqlRequest {
  requestId: string;
  incidentId: number;
  threadTs: string;
  sql: string;
  reason: string;
  createdAt: number;
  status: RequestStatus;
  /** Unset until chat.postMessage returns. The poller skips such a request. */
  msgTs?: string;
  sentText?: string;
  storedText?: string;
  decidedBy?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  error?: string;
  finishedAt?: number;
}

type Body = {
  incidentId: number;
  threadTs: string;
  sql: string;
  reason: string;
};

const SLACK_TS = /^\d+\.\d+$/;

export const validateRequest = (
  input: unknown,
): { ok: true; body: Body } | { ok: false; error: string } => {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const { incidentId, threadTs, sql, reason } = input as Record<string, unknown>;
  if (typeof incidentId !== "number" || !Number.isSafeInteger(incidentId) || incidentId < 1) {
    return { ok: false, error: "incidentId must be a positive integer" };
  }
  if (typeof threadTs !== "string" || !SLACK_TS.test(threadTs)) {
    return { ok: false, error: "threadTs must be a Slack message timestamp" };
  }
  if (typeof sql !== "string" || sql.trim() === "") {
    return { ok: false, error: "sql must be a non-empty string" };
  }
  if (sql.length > MAX_SQL_CHARS) {
    return {
      ok: false,
      error: `sql is ${sql.length} characters; the limit is ${MAX_SQL_CHARS}`,
    };
  }
  if (sql.includes(";")) {
    return {
      ok: false,
      error: "sql must be one statement with no ';' anywhere; drop it, including a trailing one",
    };
  }
  // Triple backticks would close the code block the SQL is shown in, so the
  // person approving would read part of the query as prose.
  if (sql.includes("```")) {
    return { ok: false, error: "sql must not contain ``` (it closes the Slack code block)" };
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    return { ok: false, error: "reason must be a non-empty string" };
  }
  if (reason.length > MAX_REASON_CHARS) {
    return {
      ok: false,
      error: `reason is ${reason.length} characters; the limit is ${MAX_REASON_CHARS}`,
    };
  }
  // The reason sits right above the SQL's code block. A backtick could open a
  // decoy block and a newline could fake the layout around the real query, so
  // the approver would read the agent's prose as the thing being approved.
  if (reason.includes("`") || /[\r\n]/.test(reason)) {
    return { ok: false, error: "reason must be one line with no backticks" };
  }
  return { ok: true, body: { incidentId, threadTs, sql, reason } };
};

export const renderRequest = (body: Body): string =>
  mrkdwn`*Incident ${body.incidentId} wants to run a query.*
Reason: ${body.reason}
${raw("```")}
${body.sql}
${raw("```")}
It runs read-only against gp-api prod, capped at ${ROW_CAP} rows with a 30s timeout.
React with :${raw(APPROVE_REACTION)}: to run it or :${raw(REFUSE_REACTION)}: to refuse. Only the on-call rotation counts.`;

const isActive = (r: SqlRequest) => r.status === "pending" || r.status === "running";
const isTerminal = (r: SqlRequest) => !isActive(r);

const pgCode = (err: unknown): string | null => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
};

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export const createSqlRunner = (config: SqlRunnerConfig) => {
  const now = config.now ?? Date.now;
  const requests = new Map<string, SqlRequest>();
  let rotation: { at: number; members: string[] } | null = null;
  let ticking = false;

  const rotationMembers = async (groupId: string): Promise<string[]> => {
    if (rotation && now() - rotation.at < ROTATION_TTL_MS) return rotation.members;
    const members = await config.slack.rotationMembers(groupId);
    rotation = { at: now(), members };
    return members;
  };

  const finish = async (
    req: SqlRequest,
    status: Exclude<RequestStatus, "pending" | "running">,
    outcome: string,
    fields: Partial<SqlRequest> = {},
  ) => {
    Object.assign(req, fields, { status, finishedAt: now() });
    log("request_finished", {
      requestId: req.requestId,
      incidentId: req.incidentId,
      status,
      decidedBy: req.decidedBy,
      rowCount: req.rowCount,
    });
    if (!req.msgTs || !req.sentText) return;
    try {
      await config.slack.update(
        config.channelId,
        req.msgTs,
        `${req.sentText}\n\n${outcome}`,
      );
    } catch (err) {
      alarm("outcome_update_failed", {
        requestId: req.requestId,
        error: errorMessage(err),
      });
    }
  };

  const run = async (req: SqlRequest, approver: string) => {
    req.status = "running";
    req.decidedBy = approver;
    log("request_approved", { requestId: req.requestId, incidentId: req.incidentId, decidedBy: approver });

    const current = await config.slack.reply(config.channelId, req.threadTs, req.msgTs!);
    const tampered =
      current === null
        ? "the approval message is gone"
        : current.edited
          ? "the approval message was edited after it was posted"
          : current.text !== req.storedText
            ? "the approval message no longer shows the SQL that was stored"
            : null;
    if (tampered) {
      alarm("approval_message_tampered", { requestId: req.requestId, incidentId: req.incidentId, reason: tampered });
      await finish(req, "failed", `Failed: ${tampered}, so nothing ran.`, {
        error: `${tampered}; nothing ran. Ask again.`,
      });
      return;
    }

    let result: QueryResult;
    try {
      result = await config.execute(req.sql);
    } catch (err) {
      const code = pgCode(err);
      // A Postgres message can quote a value out of the table ("invalid input
      // syntax for type integer: ..."), so only the code goes to Slack and to
      // the log. The agent gets the whole message: that is who has to fix it.
      log("query_failed", { requestId: req.requestId, code });
      const slackReason = code ? `Postgres error ${code}; the agent has the message` : "the query did not run; the agent has the error";
      await finish(req, "failed", `Failed: ${slackReason}.`, { error: errorMessage(err) });
      return;
    }

    const duplicates = result.columns.filter((c, i) => result.columns.indexOf(c) !== i);
    if (duplicates.length > 0) {
      const error = `duplicate column names (${[...new Set(duplicates)].join(", ")}); alias them so no column is lost`;
      await finish(req, "failed", `Failed: ${error}.`, { error });
      return;
    }
    if (result.rows.length > ROW_CAP) {
      const error = `more than ${ROW_CAP} rows; aggregate or narrow the query`;
      await finish(req, "failed", `Failed: ${error}.`, { error });
      return;
    }
    const size = JSON.stringify(result.rows).length;
    if (size > MAX_RESULT_CHARS) {
      const error = `result is ${size} characters; select fewer columns or rows`;
      await finish(req, "failed", `Failed: ${error}.`, { error });
      return;
    }

    await finish(
      req,
      "done",
      `Ran for ${userMention(approver)}: ${result.rows.length} rows returned to the agent.`,
      { columns: result.columns, rows: result.rows, rowCount: result.rows.length },
    );
  };

  const poll = async (req: SqlRequest, members: Set<string>) => {
    const reactions = await config.slack.reactions(config.channelId, req.msgTs!);
    if (reactions === null) {
      await finish(req, "failed", "Failed: the approval message is gone.", {
        error: "the approval message was deleted; nothing ran. Ask again.",
      });
      return;
    }
    const counted = (name: string) =>
      (reactions.find((r) => r.name === name)?.users ?? []).filter(
        (u) => u !== config.botUserId && members.has(u),
      );

    const refusers = counted(REFUSE_REACTION);
    if (refusers.length > 0) {
      await finish(req, "refused", `Refused by ${userMention(refusers[0])}.`, {
        decidedBy: refusers[0],
      });
      return;
    }
    const approvers = counted(APPROVE_REACTION);
    if (approvers.length > 0) {
      await run(req, approvers[0]);
      return;
    }
    if (now() - req.createdAt > PENDING_TTL_MS) {
      await finish(req, "expired", "Expired with no decision.");
    }
  };

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const [id, req] of requests) {
        if (isTerminal(req) && req.finishedAt !== undefined && now() - req.finishedAt > TERMINAL_TTL_MS) {
          requests.delete(id);
        }
      }
      const pending = [...requests.values()].filter((r) => r.status === "pending" && r.msgTs);
      if (pending.length === 0 || !config.rotationGroupId) return;

      let members: Set<string>;
      try {
        members = new Set(await rotationMembers(config.rotationGroupId));
      } catch (err) {
        alarm("rotation_read_failed", { error: errorMessage(err) });
        return;
      }

      await Promise.all(
        pending.map(async (req) => {
          try {
            await poll(req, members);
          } catch (err) {
            if (req.status === "running") {
              await finish(req, "failed", "Failed: the runner hit an error before the query ran.", {
                error: errorMessage(err),
              });
            }
            alarm("poll_failed", { requestId: req.requestId, error: errorMessage(err) });
          }
        }),
      );
    } finally {
      ticking = false;
    }
  };

  const app = new Hono();

  app.onError((err, c) => {
    alarm("route_failed", { path: c.req.path, error: errorMessage(err) });
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/requests", async (c) => {
    if (!config.rotationGroupId) {
      return c.json({ error: "no on-call rotation group is configured, so nobody can approve a query" }, 503);
    }
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const valid = validateRequest(input);
    if (!valid.ok) return c.json({ error: valid.error }, 400);
    const body = valid.body;

    const active = [...requests.values()].filter(isActive);
    if (active.some((r) => r.incidentId === body.incidentId)) {
      return c.json({ error: "this incident already has a query waiting for a decision or running" }, 409);
    }
    if (active.length >= MAX_PENDING_TOTAL) {
      return c.json({ error: `${MAX_PENDING_TOTAL} queries are already waiting across all incidents` }, 409);
    }

    // Reserved before the post so two concurrent requests cannot both pass
    // the limits above while the first is still waiting on Slack.
    const req: SqlRequest = {
      requestId: randomUUID(),
      ...body,
      createdAt: now(),
      status: "pending",
    };
    requests.set(req.requestId, req);

    const text = renderRequest(body);
    try {
      const posted = await config.slack.post(config.channelId, body.threadTs, text);
      req.msgTs = posted.ts;
      req.sentText = text;
      req.storedText = posted.text;
    } catch (err) {
      requests.delete(req.requestId);
      alarm("request_post_failed", { incidentId: body.incidentId, error: errorMessage(err) });
      return c.json({ error: `could not post the approval request to Slack: ${errorMessage(err)}` }, 502);
    }

    log("request_received", {
      requestId: req.requestId,
      incidentId: req.incidentId,
      msgTs: req.msgTs,
      sql: req.sql,
      reason: req.reason,
    });
    return c.json({ requestId: req.requestId }, 201);
  });

  app.get("/requests/:requestId", (c) => {
    const req = requests.get(c.req.param("requestId"));
    if (!req) return c.json({ error: "no such request" }, 404);
    return c.json({
      requestId: req.requestId,
      status: req.status,
      decidedBy: req.decidedBy,
      columns: req.columns,
      rows: req.rows,
      rowCount: req.rowCount,
      error: req.error,
    });
  });

  return { app, tick };
};
