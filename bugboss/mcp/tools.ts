// The five tools an engineer reaches from their own Claude Code session.
//
// Design spec: bugboss/docs/architecture.md, "The MCP server" and "Who can query
// it" — the MCP server is one of the control-plane surfaces that gets raw
// read-only SQL, so a person can ask a question nobody wrote a query for.

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Db } from "../db";
import type { Incident, Signal } from "../types";
import type { SessionStore } from "./sessions";
import type { WorkspaceIdentity } from "./tokens";

export interface ReportSignalResult {
  signalId: string;
  /** Null while triage has not placed it yet. */
  incidentId: string | null;
}

/**
 * What the ingress layer's human adapter consumes. Structurally the
 * `HumanReport` in bugboss/ingress/human.ts with `via: "mcp"`, declared here
 * rather than imported so this chunk does not compile against another's file.
 *
 * Shaping a report into a signal belongs to that adapter, not here: it owns
 * the labels triage reads (never_suppress, resolution_policy) and the dedup
 * id that makes one report arriving by both Slack and MCP a single signal.
 */
export interface HumanBugReport {
  text: string;
  /** From the verified bearer identity, never from the tool arguments. */
  reportedBy: string;
  via: "mcp";
}

/** Phase 2 wires this to the human adapter plus the Boss's ingest path. */
export type ReportSignal = (
  report: HumanBugReport,
) => Promise<ReportSignalResult>;

export interface McpToolDeps {
  db: Db;
  sessions: SessionStore;
  reportSignal: ReportSignal;
}

const OPEN_STATUSES = ["INVESTIGATING", "FIXING", "RESOLVED"] as const;

const MAX_SQL_ROWS = 500;
const DEFAULT_SQL_ROWS = 100;
const DEFAULT_SESSION_TAIL_LINES = 80;

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

const failed = (message: string) => ({ ...text(message), isError: true });

interface IncidentRow extends Omit<Incident, "prUrls"> {
  prUrls: string;
}

interface SignalRow extends Omit<Signal, "labels" | "explained"> {
  labels: string;
  explained: number;
}

const toIncident = (row: IncidentRow): Incident => ({
  ...row,
  prUrls: JSON.parse(row.prUrls) as string[],
});

const toSignal = (row: SignalRow): Signal => ({
  ...row,
  labels: JSON.parse(row.labels) as Record<string, string>,
  explained: row.explained === 1,
});

export const createIncidentServer = (
  deps: McpToolDeps,
  identity: WorkspaceIdentity,
): McpServer => {
  const server = new McpServer({ name: "bugboss", version: "1.0.0" });

  server.registerTool(
    "get_incident",
    {
      title: "Read an incident",
      description:
        "Full record for one incident, with every signal attached to it. " +
        "Evidence bodies live in S3 and are not included.",
      inputSchema: z.object({
        incidentId: z.string().describe("The incident id."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ incidentId }) => {
      const row = deps.db.get<IncidentRow>(
        "SELECT * FROM incident WHERE id = ?",
        [incidentId],
      );
      if (!row) return failed(`no incident ${incidentId}`);

      const signals = deps.db.query<SignalRow>(
        "SELECT * FROM signal WHERE incidentId = ? ORDER BY openedAt ASC",
        [incidentId],
      );

      return text({
        incident: toIncident(row),
        signals: signals.map(toSignal),
      });
    },
  );

  server.registerTool(
    "list_open_incidents",
    {
      title: "List open incidents",
      description:
        "Incidents that are not CLOSED or MERGED, newest first. " +
        "An INVESTIGATING or FIXING incident has an agent on it; a RESOLVED " +
        "one is waiting on its post-mortem.",
      inputSchema: z.object({
        statuses: z
          .array(z.enum(OPEN_STATUSES))
          .optional()
          .describe("Narrow to these statuses. Defaults to all three."),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ statuses, limit }) => {
      const wanted = statuses?.length ? statuses : [...OPEN_STATUSES];
      const placeholders = wanted.map(() => "?").join(", ");
      const rows = deps.db.query<IncidentRow>(
        `SELECT * FROM incident WHERE status IN (${placeholders})
         ORDER BY firstSignalAt DESC LIMIT ?`,
        [...wanted, limit ?? 50],
      );

      return text(
        rows.map((row) => {
          const incident = toIncident(row);
          const signalTitles = deps.db
            .query<{ title: string }>(
              "SELECT title FROM signal WHERE incidentId = ? ORDER BY openedAt ASC LIMIT 10",
              [incident.id],
            )
            .map((s) => s.title);
          return {
            id: incident.id,
            status: incident.status,
            owner: incident.owner,
            rootCause: incident.rootCause,
            usersImpacted: incident.usersImpacted,
            prUrls: incident.prUrls,
            firstSignalAt: incident.firstSignalAt,
            ageSeconds: Math.floor(
              (Date.now() - incident.firstSignalAt) / 1000,
            ),
            signalTitles,
          };
        }),
      );
    },
  );

  server.registerTool(
    "query_incidents",
    {
      title: "Run read-only SQL",
      description:
        "One SQL statement against the incident database (SQLite), on a " +
        "connection opened read-only. Tables: incident, signal, " +
        "pending_question, thread_reply, pending_directive. Run " +
        "\"SELECT sql FROM sqlite_master\" for the full schema. Use this for " +
        "questions nobody wrote a query for, such as the most impactful " +
        "incidents of the last 90 days.",
      inputSchema: z.object({
        sql: z.string().describe("A single SELECT statement."),
        params: z
          .array(z.union([z.string(), z.number(), z.null()]))
          .optional()
          .describe("Values for ? placeholders."),
        limit: z.number().int().min(1).max(MAX_SQL_ROWS).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ sql, params, limit }) => {
      const cap = limit ?? DEFAULT_SQL_ROWS;
      try {
        const rows = deps.db.query<Record<string, unknown>>(sql, params ?? []);
        return text({
          rowCount: rows.length,
          truncated: rows.length > cap,
          rows: rows.slice(0, cap),
        });
      } catch (err) {
        return failed(`query failed: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "read_agent_session",
    {
      title: "Read an agent's session",
      description:
        "The incident agent's session transcript from S3, at most one turn " +
        "behind. Returns the tail, which is what says where the agent is now.",
      inputSchema: z.object({
        incidentId: z.string(),
        tailLines: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Lines from the end. Defaults to 80."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ incidentId, tailLines }) => {
      let session;
      try {
        session = await deps.sessions.read(incidentId);
      } catch (err) {
        return failed(`could not read session: ${(err as Error).message}`);
      }
      if (!session) return failed(`no session stored for ${incidentId}`);

      const lines = session.content.split("\n");
      const wanted = tailLines ?? DEFAULT_SESSION_TAIL_LINES;
      return text({
        incidentId,
        key: session.key,
        updatedAt: session.updatedAt,
        sizeBytes: session.sizeBytes,
        totalLines: lines.length,
        tail: lines.slice(-wanted).join("\n"),
      });
    },
  );

  server.registerTool(
    "report_signal",
    {
      title: "Report a bug",
      description:
        "File a bug report as a signal. Triage may attach it to an incident " +
        "already in flight rather than opening a new one, which is the point: " +
        "you get the thread and the work in progress instead of a parallel " +
        "investigation. Human reports are never suppressed.",
      inputSchema: z.object({
        title: z.string().min(1).describe("One line. What is broken."),
        body: z
          .string()
          .min(1)
          .describe(
            "What you saw, where, and when. Your description is the evidence.",
          ),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ title, body }) => {
      try {
        // The adapter takes the title from the first line, so the two arrive
        // as one block of text. `reportedBy` is documented as a Slack user id;
        // over MCP the only verified identity we hold is the Google one, so
        // the email goes there and whoever maps it to a Slack id has enough.
        const result = await deps.reportSignal({
          text: `${title}\n\n${body}`,
          reportedBy: identity.email,
          via: "mcp",
        });
        return text({
          ...result,
          reportedBy: identity.email,
          message: result.incidentId
            ? `Filed as ${result.signalId}, attached to incident ${result.incidentId}.`
            : `Filed as ${result.signalId}. Triage has not placed it yet.`,
        });
      } catch (err) {
        return failed(`could not file the report: ${(err as Error).message}`);
      }
    },
  );

  return server;
};
