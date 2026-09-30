// The closing report: everything the system learned about one incident, in a
// single document, posted into its thread when the incident closes.
//
// It fires at CLOSED and not at RESOLVED, because the post-mortem does not
// exist before then -- `report_analysis` is what writes it, and the schema
// carries a CHECK saying a CLOSED row has one. Resolution keeps the short
// post it already had.
//
// Publishing is a notification, never part of the transition. `reportAnalysis`
// has already committed and the agent has already exited by the time anything
// here runs, so every failure below degrades and alarms rather than
// propagating: there is no state left to roll back and nothing useful to
// retry into.
//
// Ordering is why this is not called from the tool API. The run's tokens
// reach the incident row from `rollUpUsage`, which reads the session file
// *after* the child exits -- so at the moment `report_analysis` returns, the
// row still holds the previous launch's numbers, or zero. The composition
// root calls this once roll-up has finished, and a sweep catches the
// incidents whose container died in between.

import type Database from "better-sqlite3";

import type { Db } from "../db";
import { sumSessionUsage } from "../agent/session";
import { makeAlarm, makeLog } from "../logging";
import { mrkdwn, postDocument, splitForSlack } from "../slack/format";
import { rowToIncident, type IncidentRow, type SignalRow } from "../toolapi/assign";
import type { RecurrenceAnalysis } from "../types";
import {
  renderReportDocument,
  renderThreadSummary,
  type ReportAction,
  type ReportData,
  type ReportPr,
  type ReportSignal,
} from "./render";

export * from "./render";

const log = makeLog("report");

const alarm = makeAlarm("report");

/**
 * The durable marker that this incident's report has gone out, written as an
 * `incident_action` row rather than a new column: the DDL runs as CREATE
 * TABLE IF NOT EXISTS over a restored snapshot with no migration runner, so a
 * column added to a live table would never exist in production. This table
 * already is the ledger of what happened to an incident, and the Boss
 * publishing the report is one of those things.
 */
export const REPORT_PUBLISHED_ACTION = "report_published";

/**
 * How long after closing the sweep will pick an incident up. The fast path
 * claims within a second or two of the agent exiting, so anything still
 * unclaimed after this lost its container between the transition and the
 * publish.
 */
export const REPORT_SWEEP_GRACE_MS = 5 * 60 * 1000;

/** Per pass, so a backlog after a long outage drains over ticks. */
const REPORT_SWEEP_LIMIT = 10;

/**
 * How long a report that cannot be built keeps being retried before the
 * thread gets a line instead.
 *
 * Retrying is right for weather and wrong for a row this code cannot read.
 * The sweep takes the ten oldest unpublished closes, so an incident that
 * fails deterministically holds a slot in that queue on every tick forever --
 * ten of them and no report publishes again, with two alarms repeating every
 * thirty seconds as the only sign. An hour is long enough for a transient
 * cause to clear or for somebody to repair the row, and short enough that
 * giving up is still same-day.
 */
export const REPORT_GIVE_UP_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Collaborators
// ---------------------------------------------------------------------------

export interface ReportUpload {
  channel: string;
  threadTs: string | null;
  filename: string;
  title: string;
  /** The Markdown document. Bytes, not mrkdwn. */
  content: string;
  /** Posted as the file's message, in mrkdwn. */
  comment: string;
}

/**
 * Slack's external upload flow, which is three calls and no SDK sugar worth
 * depending on. Injected so the whole of this module is testable without a
 * workspace, and optional at the composition root so a deployment without the
 * scope degrades to text rather than losing the report.
 */
export interface FileUploader {
  upload(file: ReportUpload): Promise<void>;
}

/**
 * What became of each PR. Returns a state per url; a url it could not answer
 * for is simply absent, which renders as "state not known".
 */
export interface PrStateReader {
  states(urls: readonly string[]): Promise<Record<string, ReportPr["state"]>>;
}

export interface ReportDeps {
  db: Db;
  /** Whole-object S3. The session file is where turns and cost come from. */
  sessions: { get(key: string): Promise<string | null> };
  post(threadTs: string | null, text: string): Promise<{ ts: string }>;
  /** The channel incident threads live in, which the upload has to name. */
  channel: string;
  uploader?: FileUploader;
  prStates?: PrStateReader;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface ActionRow {
  actorKind: string;
  actorId: string | null;
  action: string;
  reason: string | null;
  at: number;
}

export const readReportData = async (
  deps: ReportDeps,
  incidentId: string,
): Promise<ReportData | null> => {
  const row = deps.db.get<IncidentRow>("SELECT * FROM incident WHERE id = ?", [
    incidentId,
  ]);
  if (!row) return null;
  const incident = rowToIncident(row);

  const signals: ReportSignal[] = deps.db
    .query<SignalRow>(
      "SELECT * FROM signal WHERE incidentId = ? ORDER BY openedAt, id",
      [incidentId],
    )
    .map((signal) => ({
      source: signal.source,
      kind: signal.kind,
      title: signal.title,
      reportedBy: signal.reportedBy,
      openedAt: signal.openedAt,
      closedAt: signal.closedAt,
      explained: signal.explained === 1,
    }));

  const mergedIn = deps.db
    .query<{ id: string }>("SELECT id FROM incident WHERE mergedInto = ? ORDER BY id", [
      incidentId,
    ])
    .map((merged) => merged.id);

  const actions: ReportAction[] = deps.db.query<ActionRow>(
    `SELECT actorKind, actorId, action, reason, at FROM incident_action
       WHERE incidentId = ? AND action <> ?
       ORDER BY at, id`,
    [incidentId, REPORT_PUBLISHED_ACTION],
  );

  // Tokens and modelId are the record and come off the row. Turns and the
  // estimated price are read back out of the same session file rollUpUsage
  // summed, so they are simply missing once it ages out -- which is the
  // honest shape, rather than a zero that reads as a free run.
  let turns: number | null = null;
  let estimatedCostUsd: number | null = null;
  if (incident.sessionRef) {
    try {
      const contents = await deps.sessions.get(incident.sessionRef);
      if (contents) {
        const usage = sumSessionUsage(contents);
        turns = usage.turns;
        estimatedCostUsd = usage.costUsd > 0 ? usage.costUsd : null;
      }
    } catch (err) {
      // A missing turn count is a worse report, not a worse incident.
      alarm("session_read_failed", { incidentId, error: String(err) });
    }
  }

  // A recurrence closes on an answer the first incident never had, and this
  // is the only place it is ever read back. Parsed defensively: a row whose
  // JSON will not load is a worse report, not a reason to withhold one.
  //
  // Every field is checked rather than cast, because the cast is the
  // dangerous version: rendering runs *after* the publish is claimed, so a
  // `why` that turned out to be missing would throw with the marker already
  // durable -- the one shape of failure that loses a report for good. A row
  // that is not an answer is treated exactly like one that will not parse.
  let recurrence: RecurrenceAnalysis | null = null;
  if (incident.recurrenceAnalysis) {
    try {
      const parsed = JSON.parse(
        incident.recurrenceAnalysis,
      ) as Partial<RecurrenceAnalysis> | null;
      if (
        parsed &&
        typeof parsed.category === "string" &&
        typeof parsed.why === "string" &&
        typeof parsed.remedy === "string"
      ) {
        recurrence = { category: parsed.category, why: parsed.why, remedy: parsed.remedy };
      } else {
        alarm("recurrence_unreadable", {
          incidentId,
          error: "parsed, but not a recurrence answer",
        });
      }
    } catch (err) {
      alarm("recurrence_unreadable", { incidentId, error: String(err) });
    }
  }

  let states: Record<string, ReportPr["state"]> = {};
  if (deps.prStates && incident.prUrls.length > 0) {
    try {
      states = await deps.prStates.states(incident.prUrls);
    } catch (err) {
      alarm("pr_states_failed", { incidentId, error: String(err) });
    }
  }

  return {
    incident,
    signals,
    mergedIn,
    actions,
    prs: incident.prUrls.map((url) => ({ url, state: states[url] ?? null })),
    recurrence,
    run: {
      modelId: incident.modelId,
      tokensIn: incident.tokensIn,
      tokensOut: incident.tokensOut,
      cacheRead: incident.cacheRead,
      cacheWrite: incident.cacheWrite,
      cacheWrite1h: incident.cacheWrite1h,
      attempts: incident.attempts,
      turns,
      estimatedCostUsd,
    },
  };
};

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export type PublishOutcome = "published" | "degraded" | "skipped";

/**
 * Claim the right to publish, as one statement.
 *
 * Guarded in the INSERT rather than by a read before it, like every other
 * transition here: two publishers can race -- the fast path after an agent
 * exits and the sweep -- and the write queue is the only thing that orders
 * them. The marker is durable *before* the message exists, so a container
 * that dies mid-post stays quiet rather than saying it twice. A resumed agent cannot re-enter
 * this at all, since `reportAnalysis` will not run twice against a CLOSED
 * row, but the container restarts on every merge to ops main and the sweep
 * runs on every tick.
 */
const claim = (db: Db, incidentId: string, at: number): Promise<boolean> =>
  db.withWrite((w: Database.Database) => {
    const res = w
      .prepare(
        `INSERT INTO incident_action (incidentId, actorKind, actorId, action, reason, at)
         SELECT ?, 'boss', NULL, ?, 'closing report posted to the incident thread', ?
          WHERE EXISTS (SELECT 1 FROM incident WHERE id = ? AND status = 'CLOSED')
            AND NOT EXISTS (
              SELECT 1 FROM incident_action WHERE incidentId = ? AND action = ?
            )`,
      )
      .run(
        incidentId,
        REPORT_PUBLISHED_ACTION,
        at,
        incidentId,
        incidentId,
        REPORT_PUBLISHED_ACTION,
      );
    return res.changes > 0;
  });

/**
 * Hand the claim back, for the one case that earns it: nothing reached the
 * thread, so the marker says a report was posted that was not, and the sweep
 * should come round again.
 *
 * Deliberately not done after a partial post. A report has no way to tell
 * which of its parts landed, so the choice here is between half a report
 * somebody can see and a duplicate they have to reconcile. Half wins.
 */
const release = (db: Db, incidentId: string): Promise<void> =>
  db
    .withWrite((w: Database.Database) => {
      w.prepare(
        "DELETE FROM incident_action WHERE incidentId = ? AND action = ?",
      ).run(incidentId, REPORT_PUBLISHED_ACTION);
    })
    .then(() => undefined);

/**
 * Post the report into the incident thread, once.
 *
 * Returns what happened rather than throwing. The caller is a `finally`
 * handler and a timer; neither has anything to do with a failure except log
 * it, and this module has already done that.
 */
export const publishIncidentReport = async (
  deps: ReportDeps,
  incidentId: string,
): Promise<PublishOutcome> => {
  const now = deps.now ?? Date.now;

  // Read before claiming, so the only work left inside the claim is posting.
  // Two publishers racing both read; one of them then loses the INSERT and
  // stops, which costs a wasted S3 get rather than a lost report.
  let data: ReportData | null;
  try {
    data = await readReportData(deps, incidentId);
  } catch (err) {
    alarm("assemble_failed", { incidentId, error: String(err) });
    return "skipped";
  }
  if (!data) {
    alarm("assemble_failed", { incidentId, error: "no such incident" });
    return "skipped";
  }
  if (data.incident.status !== "CLOSED") {
    log("publish_skipped", { incidentId, reason: "not closed", status: data.incident.status });
    return "skipped";
  }

  // Rendered before the claim, for the same reason the read is. The claim is
  // durable and the sweep will not revisit an incident that carries it, so
  // anything able to throw has to throw while the report can still be
  // published later. Rendering is where hostile row data lands -- an
  // on-call list that is not a list, a metric that is not a number -- and
  // the cost of doing it early is a wasted render when two publishers race,
  // against a report lost for good.
  let document: string;
  let summary: string;
  try {
    document = renderReportDocument(data);
    summary = renderThreadSummary(data);
  } catch (err) {
    // Rendering is a pure function of the row, so this fails again on every
    // tick for as long as the row is what it is. Retried for an hour in case
    // something repairs it, and after that answered rather than repeated: the
    // thread is told the report is missing, which is the one thing a
    // repeating alarm never does.
    const stuck = data.incident.closedAt !== null &&
      now() - data.incident.closedAt > REPORT_GIVE_UP_MS;
    alarm("render_failed", { incidentId, error: String(err), givingUp: stuck });
    if (!stuck) return "skipped";
    if (!(await claim(deps.db, incidentId, now()))) return "skipped";
    try {
      await deps.post(
        data.incident.slackThreadTs,
        mrkdwn`*Incident ${incidentId} is closed, but its closing report could not be written.*\n_Everything the incident recorded is intact; it is the report that failed._`,
      );
      return "degraded";
    } catch (postErr) {
      await release(deps.db, incidentId);
      alarm("publish_failed", { incidentId, error: String(postErr) });
      return "skipped";
    }
  }

  if (!(await claim(deps.db, incidentId, now()))) {
    log("publish_skipped", { incidentId, reason: "already published" });
    return "skipped";
  }
  log("publish_claimed", { incidentId });

  const threadTs = data.incident.slackThreadTs;

  const degrade = async (note: string): Promise<PublishOutcome> => {
    // Counted because it decides whether the claim was earned. A thread that
    // took nothing at all leaves a marker asserting a report exists when none
    // does, and that marker is what stops the sweep ever trying again.
    let landed = 0;
    try {
      // The summary is already mrkdwn, built by the `mrkdwn` tag; the
      // document is raw Markdown and needs converting. Two texts, two paths,
      // which is the split slack/format.ts draws.
      for (const part of splitForSlack(renderThreadSummary(data, note))) {
        await deps.post(threadTs, part);
        landed++;
      }
      // postDocument, not postProse: this is the one text exempt from the
      // thread's length budget, and the exemption is supposed to be a name
      // somebody can grep for.
      await postDocument((text) => deps.post(threadTs, text), document, { incidentId });
      return "degraded";
    } catch (err) {
      if (landed === 0) await release(deps.db, incidentId);
      alarm("publish_failed", {
        incidentId,
        error: String(err),
        landed,
        retryable: landed === 0,
      });
      return "skipped";
    }
  };

  if (!deps.uploader) {
    // Config, not a failure: a deployment with no file uploader wired still
    // gets the whole report, in the thread.
    log("publish_without_upload", { incidentId });
    return degrade("Posted inline: BugBoss has no file upload configured.");
  }

  try {
    await deps.uploader.upload({
      channel: deps.channel,
      threadTs,
      filename: `incident-${data.incident.id}.md`,
      title: `Incident ${data.incident.id} — closing report`,
      content: document,
      comment: summary,
    });
    log("published", {
      incidentId,
      chars: document.length,
      signals: data.signals.length,
      prs: data.prs.length,
    });
    return "published";
  } catch (err) {
    // Nobody asked for this failure and it is invisible otherwise: the
    // likeliest cause is `files:write` missing because the app was never
    // reinstalled after the scope was added, and a swallowed missing_scope
    // looks exactly like a BugBoss that is working.
    alarm("upload_failed", { incidentId, error: String(err) });
    return degrade("The report file could not be uploaded, so it is posted here instead.");
  }
};

/**
 * Publish anything that closed and never got a report.
 *
 * The fast path runs in the `finally` of an agent launch, which a container
 * replaced mid-close never reaches -- and nothing relaunches an agent on a
 * CLOSED incident, so without this the report would be lost for good. The
 * grace period keeps it off the fast path's heels: an incident that closed
 * seconds ago still has usage roll-up in flight, and a report published ahead
 * of that would quote zero tokens.
 */
export const publishPendingReports = async (
  deps: ReportDeps,
): Promise<number> => {
  const now = deps.now ?? Date.now;
  const due = deps.db.query<{ id: string }>(
    `SELECT id FROM incident
      WHERE status = 'CLOSED' AND closedAt IS NOT NULL AND closedAt < ?
        AND NOT EXISTS (
          SELECT 1 FROM incident_action a
           WHERE a.incidentId = incident.id AND a.action = ?
        )
      ORDER BY closedAt
      LIMIT ?`,
    [now() - REPORT_SWEEP_GRACE_MS, REPORT_PUBLISHED_ACTION, REPORT_SWEEP_LIMIT],
  );

  let published = 0;
  for (const row of due) {
    const outcome = await publishIncidentReport(deps, row.id);
    if (outcome !== "skipped") published++;
  }
  if (published > 0) log("sweep_published", { incidents: published });
  return published;
};
