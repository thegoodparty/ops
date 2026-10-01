// request_sql_query: one read-only SELECT against gp-api's production
// database, run only after a person on the rotation approves it.
//
// The agent never reaches the database or the sidecar's password. The tool
// calls the Boss's loopback API, the Boss names the incident's thread and
// forwards to the sidecar, and the sidecar checks that thread with Slack, asks
// for approval with a message of its own and reads the reaction back.
// Everything here is the waiting: it is a blocking tool like monitor, costs one
// turn however long the person takes, and is cut short by a Boss message the
// same way.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MAX_BLOCK_SECONDS } from "./tools";

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

export interface SqlQueryDeps {
  port: SqlRequestPort;
  /** The harness's wrap-up signal. */
  signal?: AbortSignal;
  /** The current wait's interrupt, read when a call starts. */
  waitSignal?: () => AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  pollSeconds?: number;
  maxBlockSeconds?: number;
}

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

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
  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? Date.now;
  const pollMs = (deps.pollSeconds ?? SQL_POLL_SECONDS) * 1000;
  const capAt = now() + (deps.maxBlockSeconds ?? MAX_BLOCK_SECONDS) * 1000;
  const interrupt = deps.waitSignal?.();
  const live = [deps.signal, interrupt].filter((signal): signal is AbortSignal => !!signal);
  const signal = live.length > 1 ? AbortSignal.any(live) : live[0];

  let requestId = args.requestId;
  if (!requestId) {
    const created = await deps.port.createSqlRequest({ sql: args.sql, reason: args.reason });
    const body = parse<{ requestId?: unknown }>(created.text);
    if (!(created.status >= 200 && created.status < 300) || typeof body?.requestId !== "string") {
      return { kind: "rejected", status: created.status, text: created.text };
    }
    requestId = body.requestId;
  }

  for (;;) {
    const read = await deps.port.getSqlRequest(requestId);
    if (read.status === 404) return { kind: "lost", requestId };
    const view = read.status === 200 ? parse<SqlRequestView>(read.text) : null;
    if (!view) {
      return { kind: "unreadable", requestId, status: read.status, text: read.text };
    }
    if (SETTLED.includes(view.status)) return { kind: "settled", view };
    if (interrupt?.aborted) {
      return { kind: "waiting", requestId, status: view.status, endedBy: "interrupt" };
    }
    if (deps.signal?.aborted) {
      return { kind: "waiting", requestId, status: view.status, endedBy: "deadline" };
    }
    if (now() >= capAt) {
      return { kind: "waiting", requestId, status: view.status, endedBy: "cap" };
    }
    await sleep(Math.min(pollMs, Math.max(0, capAt - now())), signal);
  }
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

export const createSqlQueryTool = async (deps: SqlQueryDeps): Promise<ToolDefinition> => {
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
    label: "Request SQL query",
    description: DESCRIPTION,
    parameters,
    execute: async (_toolCallId, params, signal) => {
      // Pi's own signal joins the deadline's; the interrupt stays separate so
      // the result can say which one ended the wait.
      const outcome = await runSqlQuery(params as unknown as SqlQueryArgs, {
        ...deps,
        signal: signal && deps.signal ? AbortSignal.any([signal, deps.signal]) : (signal ?? deps.signal),
      });
      return {
        content: [{ type: "text", text: renderSqlOutcome(outcome) }],
        details: { kind: outcome.kind },
      };
    },
  } as ToolDefinition;
};
