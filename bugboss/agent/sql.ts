// request_sql_query: one read-only SELECT against gp-api's production
// database, run only after a person on the rotation approves it.
//
// The agent never reaches the database or the sidecar's password. The tool
// calls the Boss's own SQL port in-process, which names the incident's thread
// and forwards to the sidecar, and the sidecar checks that thread with Slack,
// asks for approval with a message of its own and reads the reaction back.
// Everything here is the waiting: it is a blocking tool like monitor, costs one
// turn however long the person takes, and is cut short by a Boss message the
// same way.

import type { Db } from "../db";
import { makeAlarm, makeLog } from "../logging";
import type { Context, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "./harness";
import { MAX_BLOCK_SECONDS } from "./tools";
import { waitUntil, type WaitOptions, type WaitResult } from "./wait";

const log = makeLog("agent-sql");
const alarm = makeAlarm("agent-sql");

export const SQL_QUERY_TOOL_NAME = "request_sql_query";

/**
 * Between reads of the request. A read is a loopback hop and a map lookup in
 * the sidecar, so this is about how soon the agent sees an approval land, not
 * about load.
 */
export const SQL_POLL_SECONDS = 5;

export type SqlRequestStatus =
  | "pending"
  | "running"
  | "done"
  | "refused"
  | "failed"
  | "expired";

const SETTLED: SqlRequestStatus[] = ["done", "refused", "failed", "expired"];

/** The sidecar's GET /requests/:id body, as the Boss passes it through. */
export interface SqlRequestView {
  requestId: string;
  status: SqlRequestStatus;
  /** The Slack user id of whoever approved or refused it. */
  decidedBy?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  error?: string;
}

/**
 * Status and body, unparsed. The sidecar's refusals are its own words and
 * reach the agent verbatim, so nothing between it and the tool result gets to
 * reword one by throwing it as a harness error.
 */
export interface SidecarReply {
  status: number;
  text: string;
}

export interface SqlRequestPort {
  createSqlRequest(args: { sql: string; reason: string }): Promise<SidecarReply>;
  getSqlRequest(requestId: string): Promise<SidecarReply>;
}

export interface SqlQueryArgs {
  sql: string;
  reason: string;
  /** An earlier request to keep waiting on, instead of asking again. */
  requestId?: string;
}

export type SqlQueryOutcome =
  | { kind: "rejected"; status: number; text: string }
  | { kind: "lost"; requestId: string }
  | { kind: "unreadable"; requestId: string; status: number; text: string }
  | {
      kind: "waiting";
      requestId: string;
      status: SqlRequestStatus;
      /** What ended the wait: the block cap, a Boss message, or the harness deadline. */
      endedBy: "cap" | "interrupt" | "deadline";
    }
  | { kind: "settled"; view: SqlRequestView };

/** What a check saw: a request still waiting, or the end of the wait. */
type SqlCheck = SqlQueryOutcome | { kind: "pending"; requestId: string; status: SqlRequestStatus };

export interface SqlQueryDeps {
  port: SqlRequestPort;
  /** The blocking wait; `waitUntil` over the tool call in production. */
  wait: (options: WaitOptions<SqlCheck>) => Promise<WaitResult<SqlCheck>>;
  /**
   * Remembers a request the moment the sidecar accepted it, so a rerun of
   * this call after a crash resumes it rather than posting a second approval
   * request into the thread.
   */
  remember?: (requestId: string) => Promise<unknown>;
  pollSeconds?: number;
  maxBlockSeconds?: number;
}

const parse = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

/**
 * Ask, or pick an earlier request back up, then wait for a decision.
 *
 * A read the Boss cannot answer ends the wait rather than being retried: the
 * sidecar holds requests in memory, so a sidecar that went away and came back
 * has lost this one and the next read is a 404, and one that stays away is
 * alarmed on by the Boss for every read made of it.
 */
export const runSqlQuery = async (
  args: SqlQueryArgs,
  deps: SqlQueryDeps,
): Promise<SqlQueryOutcome> => {
  const pollMs = (deps.pollSeconds ?? SQL_POLL_SECONDS) * 1000;
  const blockMs = (deps.maxBlockSeconds ?? MAX_BLOCK_SECONDS) * 1000;

  let requestId = args.requestId;
  if (!requestId) {
    const created = await deps.port.createSqlRequest({ sql: args.sql, reason: args.reason });
    const body = parse<{ requestId?: unknown }>(created.text);
    if (!(created.status >= 200 && created.status < 300) || typeof body?.requestId !== "string") {
      return { kind: "rejected", status: created.status, text: created.text };
    }
    requestId = body.requestId;
    await deps.remember?.(requestId);
  }
  const id = requestId;

  const waited = await deps.wait({
    timeoutMs: blockMs,
    intervalMs: pollMs,
    check: async () => {
      const read = await deps.port.getSqlRequest(id);
      if (read.status === 404) return { done: true, value: { kind: "lost", requestId: id } };
      const view = read.status === 200 ? parse<SqlRequestView>(read.text) : null;
      if (!view) {
        return { done: true, value: { kind: "unreadable", requestId: id, status: read.status, text: read.text } };
      }
      if (SETTLED.includes(view.status)) return { done: true, value: { kind: "settled", view } };
      return { done: false, value: { kind: "pending", requestId: id, status: view.status } };
    },
  });

  const last = waited.value;
  if (waited.ended === "met" && last && last.kind !== "pending") return last;
  const status = last?.kind === "pending" ? last.status : "pending";
  const endedBy = waited.ended === "inbox" ? "interrupt" : waited.ended === "aborted" ? "deadline" : "cap";
  return { kind: "waiting", requestId: id, status, endedBy };
};

const decided = (view: SqlRequestView): string =>
  view.decidedBy ? ` by Slack user ${view.decidedBy}` : "";

/**
 * What the model reads. Rows arrive whole: the sidecar caps the query at 200
 * rows, which is the bound, and nothing here cuts what a person approved and
 * the database returned.
 */
export const renderSqlOutcome = (outcome: SqlQueryOutcome): string => {
  switch (outcome.kind) {
    case "rejected":
      return [
        `Not asked: the request was refused with HTTP ${outcome.status}.`,
        outcome.text,
        ...(outcome.status === 409
          ? [
              "If you already have a request waiting, call again with its requestId to keep waiting on it.",
            ]
          : []),
      ].join("\n\n");
    case "lost":
      return `Request ${outcome.requestId} was lost (the SQL runner restarted). Ask again.`;
    case "unreadable":
      return [
        `Could not read request ${outcome.requestId}: HTTP ${outcome.status}.`,
        outcome.text,
        `Call request_sql_query again with requestId "${outcome.requestId}" to keep waiting.`,
      ].join("\n\n");
    case "waiting": {
      const again = `call request_sql_query again with requestId "${outcome.requestId}"; it will not be asked twice.`;
      if (outcome.endedBy === "interrupt") {
        return `STOPPED WAITING on request ${outcome.requestId}, still ${outcome.status} (interrupted). The Boss spoke: its message reaches you next. If none does, call get_incident before you do anything else. To keep waiting afterwards, ${again}`;
      }
      if (outcome.endedBy === "deadline") {
        return `Your deadline ended this wait. Request ${outcome.requestId} is still ${outcome.status}.`;
      }
      return `STILL WAITING on request ${outcome.requestId}, which is ${outcome.status}. This call was capped at ${MAX_BLOCK_SECONDS}s so the prompt cache stays warm. To keep waiting, ${again}`;
    }
    case "settled": {
      const { view } = outcome;
      if (view.status === "done") {
        return [
          `Request ${view.requestId} ran, approved${decided(view)}. ${view.rowCount ?? view.rows?.length ?? 0} rows.`,
          JSON.stringify({ columns: view.columns ?? [], rows: view.rows ?? [] }),
        ].join("\n\n");
      }
      return [
        `Request ${view.requestId} is ${view.status}${decided(view)}. Nothing was returned.`,
        ...(view.error ? [view.error] : []),
      ].join("\n\n");
    }
  }
};

const DESCRIPTION = [
  "Run ONE read-only SELECT on the gp-api PRODUCTION database (reader), once a",
  "person on the rotation approves it in the incident thread. Wrapped as a",
  "subquery: 200 rows max, 30s timeout, no semicolons, printable ASCII, 40 lines",
  "of 200 chars, no double blank lines. Never react to the approval message.",
  "Schema: the Prisma models",
  "under packages/gp-api/prisma/schema/ in your checkout (mind @@map). Rows",
  "come back to you only, never to Slack. Select the narrowest columns you need,",
  "never secrets or personal data you do not need.",
  `Waits at most ${MAX_BLOCK_SECONDS}s. If it returns still waiting, call again with`,
  "`requestId` to keep waiting without asking twice.",
].join("\n");

export const createSqlQueryTool = async (deps: {
  portFor: (api: ToolExecutionApi, ctx: Context) => Promise<SqlRequestPort>;
  pollSeconds?: number;
  maxBlockSeconds?: number;
  now?: () => number;
}): Promise<ToolRegistration> => {
  const { Type } = await import("typebox");
  const parameters = Type.Object({
    sql: Type.String({ description: "One SELECT, no semicolon." }),
    reason: Type.String({ description: "Why, in a sentence or two, for the approver." }),
    requestId: Type.Optional(
      Type.String({ description: "An earlier request to keep waiting on; sql is then ignored." }),
    ),
  });

  return {
    name: SQL_QUERY_TOOL_NAME,
    description: DESCRIPTION,
    parameters,
    // Safe because the request it made is remembered: a rerun finds the memo
    // and waits on that request instead of asking the rotation twice.
    replay: "safe",
    outputLimits: { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER },
    execute: async (params, api, ctx): Promise<ToolExecutionResult> => {
      const args = params as SqlQueryArgs;
      const port = await deps.portFor(api, ctx);
      const sent = args.requestId ? undefined : await api.memo<string>("sent", ctx);
      const outcome = await runSqlQuery(
        { ...args, ...(sent ? { requestId: sent } : {}) },
        {
          port,
          wait: (options) => waitUntil(api, ctx, { ...options, ...(deps.now ? { now: deps.now } : {}) }),
          remember: (requestId) => api.memo<string>("sent", requestId, ctx),
          ...(deps.pollSeconds === undefined ? {} : { pollSeconds: deps.pollSeconds }),
          ...(deps.maxBlockSeconds === undefined ? {} : { maxBlockSeconds: deps.maxBlockSeconds }),
        },
      );
      return {
        content: [{ type: "text", text: renderSqlOutcome(outcome) }],
        details: { kind: outcome.kind },
      };
    },
  };
};

const reply = (status: number, body: unknown): SidecarReply => ({
  status,
  text: JSON.stringify(body),
});

/**
 * The Boss's side of request_sql_query: it adds the incident's thread and
 * forwards to the SQL sidecar (`bugboss/sqlrunner`), which holds the database
 * password and asks a person in that thread before it runs anything.
 *
 * Unset `sqlRunnerUrl` (BUGBOSS_SQL_RUNNER_URL) leaves request_sql_query in
 * the agent's tool list answering with an error and an alarm, so the prompt
 * prefix does not change with configuration.
 */
export const createSidecarSqlPort = (deps: {
  db: Db;
  incidentId: string;
  sqlRunnerUrl?: string;
  /** Reaches the sidecar. Tests inject a fake one. */
  fetchImpl?: typeof fetch;
}): SqlRequestPort => {
  const sqlRunner = deps.sqlRunnerUrl?.replace(/\/$/, "");
  const sidecarFetch = deps.fetchImpl ?? fetch;
  const { incidentId } = deps;

  /**
   * The sidecar's answer goes back verbatim, status and body, because it is
   * the side that decides: a semicolon, a second pending request, a missing
   * rotation group are its refusals to word, and the agent reads them as
   * they were written. Everything that stops the call before the sidecar
   * answers alarms as well as erroring. An agent told "try again later" with
   * nobody else told is how a capability stays broken for weeks.
   */
  const forwardToSqlRunner = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<SidecarReply> => {
    if (!sqlRunner) {
      alarm("sql_runner_unconfigured", { incidentId });
      return reply(503, {
        error: "the SQL runner is not configured on this Boss (BUGBOSS_SQL_RUNNER_URL is unset); nothing was asked",
      });
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
      return reply(502, { error: `the SQL runner could not be reached: ${String(err)}` });
    }

    const text = await response.text();
    if (response.status >= 500) {
      alarm("sql_runner_error", { incidentId, path, status: response.status, body: text });
    } else if (!response.ok) {
      log("sql_runner_refused", { incidentId, path, status: response.status });
    }
    return { status: response.status, text };
  };

  return {
    /**
     * The Boss adds the thread, and that is all it adds. It is a convenience,
     * not a check: the agent can reach the sidecar on loopback directly and
     * name any incident and thread it likes, so the sidecar confirms with
     * Slack that the thread is this incident's before it posts anything.
     */
    createSqlRequest: async ({ sql, reason }) => {
      // The sidecar's contract takes an integer, and every production id is
      // one (`MAX(id)+1`). Anything else is a row nothing here should exist for.
      const numericId = Number(incidentId);
      if (!Number.isSafeInteger(numericId)) {
        alarm("sql_request_bad_incident_id", { incidentId });
        return reply(500, { error: `incident ${incidentId} has no integer id; nothing was asked` });
      }

      const row = deps.db.get<{ slackThreadTs: string | null }>(
        "SELECT slackThreadTs FROM incident WHERE id = ?",
        [incidentId],
      );
      if (!row) {
        alarm("sql_request_unknown_incident", { incidentId });
        return reply(404, { error: `unknown incident ${incidentId}; nothing was asked` });
      }
      if (!row.slackThreadTs) {
        alarm("sql_request_no_thread", { incidentId });
        return reply(409, {
          error: `incident ${incidentId} has no Slack thread yet, so there is nowhere to ask for approval; nothing was asked`,
        });
      }

      return forwardToSqlRunner("POST", "/requests", {
        incidentId: numericId,
        threadTs: row.slackThreadTs,
        sql,
        reason,
      });
    },

    // Not checked against the caller's incident: the sidecar's answer does
    // not say whose request it was, and the id is a random UUID only its
    // creator was handed. Reads are not contained here anyway
    // (toolapi/CLAUDE.md).
    getSqlRequest: async (requestId) => {
      // It goes into the sidecar's path, so nothing in it may move the path.
      if (!/^[A-Za-z0-9-]+$/.test(requestId)) {
        return reply(400, { error: "requestId is not a request id" });
      }
      return forwardToSqlRunner("GET", `/requests/${requestId}`);
    },
  };
};
