// The closing report: everything the system learned about one incident, in a
// single PDF, attached to the notice that says the incident closed. One
// message, not a notice and a report beside it.
//
// It fires at CLOSED and not at RESOLVED, because the post-mortem does not
// exist before then -- `report_analysis` is what writes it, and the schema
// carries a CHECK saying a CLOSED row has one. Resolution keeps the short
// post it already had.
//
// Publishing is part of the close, called by the transition itself, but it
// is never able to undo it: the close has committed before anything here
// runs, so every failure below is recorded, alarmed and retried by the sweep
// rather than propagated.

import type Database from "better-sqlite3";

import type { Db } from "../db";
import { sumSessionUsage } from "../agent/session";
import { catalogRatesFor, priceTokens, type TokenCounts } from "../bedrock/model";
import { makeAlarm, makeLog } from "../logging";
import { mrkdwn } from "../slack/format";
import { agentClosedDetail, bossClosedDetail, closedNotice } from "../toolapi/announce";
import { rowToIncident, type IncidentRow, type SignalRow } from "../toolapi/assign";
import type { RecurrenceAnalysis, TimelineEvent } from "../types";
import { renderReportPdf } from "./pdf";
import {
  renderReportDocument,
  type ReportAction,
  type ReportData,
  type ReportPr,
  type ReportSignal,
} from "./render";

export * from "./render";
export * from "./pdf";

const log = makeLog("report");

const alarm = makeAlarm("report");

/**
 * The claim on publishing this incident's report, written as an
 * `incident_action` row rather than a new column: the DDL runs as CREATE
 * TABLE IF NOT EXISTS over a restored snapshot with no migration runner, so a
 * column added to a live table would never exist in production. This table
 * already is the ledger of what happened to an incident.
 *
 * Standing, it means the report went out, or an attempt is in flight, or one
 * ended in a way nobody can tell apart from success. All three keep every
 * publisher away.
 */
export const REPORT_PUBLISHED_ACTION = "report_published";

/** One attempt that failed and put nothing in the thread. Counted. */
export const REPORT_UPLOAD_FAILED_ACTION = "report_upload_failed";

/**
 * The close notice went out on its own, after a failed attempt. Without this
 * row the next attempt carries the notice as the file's comment, so a notice
 * Slack refused is re-sent rather than lost.
 */
export const REPORT_NOTICE_POSTED_ACTION = "report_notice_posted";

/**
 * Attempts before the report is given up on, the one at close included. With
 * the retry spacing below that is about twenty minutes of Slack being unable
 * to take the file, which is weather that has lasted long enough for a
 * person to look.
 */
export const REPORT_UPLOAD_ATTEMPTS = 4;

/** How long after a failed attempt the sweep tries again. */
export const REPORT_UPLOAD_RETRY_MS = 5 * 60 * 1000;

/**
 * How long after closing the sweep will pick an incident up. The close
 * publishes within a second or two of the transition, so anything still
 * unclaimed after this lost its container in between.
 */
export const REPORT_SWEEP_GRACE_MS = 5 * 60 * 1000;

/** Per pass, so a backlog after a long outage drains over ticks. */
const REPORT_SWEEP_LIMIT = 10;

/**
 * An upload whose last step failed without an answer. Slack may already have
 * put the file in the thread, so this attempt keeps its claim: retrying it is
 * how one report is attached twice.
 */
export class UploadOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadOutcomeUnknownError";
  }
}

// ---------------------------------------------------------------------------
// Collaborators
// ---------------------------------------------------------------------------

export interface ReportUpload {
  channel: string;
  threadTs: string | null;
  filename: string;
  title: string;
  /** The PDF. */
  content: Buffer;
  /**
   * The file's message, in mrkdwn: the close notice, so notice and report
   * arrive as one message. Null on a retry, whose notice already went out.
   */
  comment: string | null;
}

/**
 * Slack's external upload flow, which is three calls and no SDK sugar worth
 * depending on. Injected so the whole of this module is testable without a
 * workspace.
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
  uploader: FileUploader;
  prStates?: PrStateReader;
  /** Defaults to the real PDF. Tests read the Markdown instead. */
  renderPdf?: (markdown: string) => Promise<Buffer>;
  /**
   * Writes the run's tokens onto the row from its session file, before the
   * report reads them. Every publisher needs it, the sweep included: a
   * container that died mid-close may never have rolled up at all, and zero
   * tokens reads as a free run. Never throws.
   */
  rollUpUsage?: (incidentId: string) => Promise<void>;
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

  const merged = deps.db.query<TokenCounts & { id: string; modelId: string | null }>(
    `SELECT id, modelId, tokensIn, tokensOut, cacheRead, cacheWrite, cacheWrite1h
       FROM incident WHERE mergedInto = ? ORDER BY id`,
    [incidentId],
  );
  const mergedIn = merged.map((m) => m.id);

  const actions: ReportAction[] = deps.db.query<ActionRow>(
    `SELECT actorKind, actorId, action, reason, at FROM incident_action
       WHERE incidentId = ? AND action NOT IN (?, ?, ?)
       ORDER BY at, id`,
    [
      incidentId,
      REPORT_PUBLISHED_ACTION,
      REPORT_UPLOAD_FAILED_ACTION,
      REPORT_NOTICE_POSTED_ACTION,
    ],
  );

  const timeline = deps.db.query<TimelineEvent>(
    `SELECT id, kind, occurredAt, recordedAt, summary, evidenceUrl
       FROM incident_timeline_event WHERE incidentId = ?
       ORDER BY occurredAt, id`,
    [incidentId],
  );

  // Tokens and modelId come off the row, which rollUpUsage keeps current;
  // the price is derived from them below. Turns are read back out of the
  // session file, so they are simply missing once it ages out -- the honest
  // shape, rather than a zero that reads as a run with no turns.
  let turns: number | null = null;
  if (incident.sessionRef) {
    try {
      const contents = await deps.sessions.get(incident.sessionRef);
      if (contents) turns = sumSessionUsage(contents).turns;
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
  // dangerous version: a `why` that turned out to be missing would throw in
  // rendering on every attempt, and the report would be abandoned rather
  // than published with the section saying so. A row that is not an answer
  // is treated exactly like one that will not parse.
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

  // Dollars are derived here, on read, from the tokens and the catalog's
  // rates, and never stored: the tokens are the record. Null rather than
  // zero when the model has no rates or pricing refuses, so a missing price
  // never reads as a free run.
  const estimate = async (
    modelId: string | null,
    tokens: TokenCounts,
  ): Promise<number | null> => {
    if (!modelId) return null;
    const rates = await catalogRatesFor(modelId);
    if (!rates) return null;
    try {
      return priceTokens(rates, tokens);
    } catch (err) {
      alarm("usage_unpriced", { incidentId, modelId, error: String(err) });
      return null;
    }
  };
  const ownCost = await estimate(incident.modelId, incident);
  let mergedInCostUsd = 0;
  const mergedInPriced: string[] = [];
  const mergedInUnpriced: string[] = [];
  for (const m of merged) {
    const cost = await estimate(m.modelId, m);
    if (cost === null) mergedInUnpriced.push(m.id);
    else if (cost > 0) {
      mergedInPriced.push(m.id);
      mergedInCostUsd += cost;
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
    timeline,
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
      estimatedCostUsd: ownCost !== null && ownCost > 0 ? ownCost : null,
      mergedInCostUsd,
      mergedInPriced,
      mergedInUnpriced,
    },
  };
};

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export type PublishOutcome = "published" | "retrying" | "abandoned" | "skipped";

/**
 * The close notice, derived from the row rather than handed in, so the sweep
 * that publishes for a container that died mid-close says exactly what the
 * close itself would have.
 */
export const closeNoticeFor = (data: ReportData): string => {
  const bossClose = data.actions.find(
    (action) => action.actorKind === "boss" && action.action === "close",
  );
  return closedNotice(
    data.incident.id,
    bossClose
      ? bossClosedDetail(bossClose.reason ?? "")
      : agentClosedDetail(data.incident.usersImpacted),
  );
};

/**
 * Claim the right to publish, as one statement, and learn in the same
 * transaction whether the close notice has already gone out on its own.
 *
 * Guarded in the INSERT rather than by a read before it, like every other
 * transition here: two publishers can race -- the close and the sweep -- and
 * the write queue is the only thing that orders them. The claim is durable
 * *before* the upload starts, so a container that dies mid-upload stays quiet
 * rather than attaching the file twice.
 */
const claim = (
  db: Db,
  incidentId: string,
  at: number,
): Promise<{ claimed: boolean; failures: number; noticePosted: boolean }> =>
  db.withWrite((w: Database.Database) => {
    const res = w
      .prepare(
        `INSERT INTO incident_action (incidentId, actorKind, actorId, action, reason, at)
         SELECT ?, 'boss', NULL, ?, 'closing report attached to the incident thread', ?
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
    const count = (action: string): number =>
      (
        w
          .prepare(
            "SELECT COUNT(*) AS n FROM incident_action WHERE incidentId = ? AND action = ?",
          )
          .get(incidentId, action) as { n: number }
      ).n;
    return {
      claimed: res.changes > 0,
      failures: count(REPORT_UPLOAD_FAILED_ACTION),
      noticePosted: count(REPORT_NOTICE_POSTED_ACTION) > 0,
    };
  });

/**
 * Written after the post rather than before it. A crash in between repeats
 * the notice on the next attempt, and a repeated line is the lesser failure
 * next to a close nobody was told about.
 */
const recordNotice = (db: Db, incidentId: string, at: number): Promise<void> =>
  db
    .withWrite((w: Database.Database) => {
      w.prepare(
        `INSERT INTO incident_action (incidentId, actorKind, actorId, action, reason, at)
         VALUES (?, 'boss', NULL, ?, 'close notice posted without the report', ?)`,
      ).run(incidentId, REPORT_NOTICE_POSTED_ACTION, at);
    })
    .then(() => undefined);

/**
 * Record a failed attempt and, unless that was the last one, hand the claim
 * back so the sweep comes round again. One transaction, so a crash leaves
 * either the claim or the failure, never a released claim with no count.
 */
const recordFailure = (
  db: Db,
  incidentId: string,
  error: string,
  at: number,
): Promise<number> =>
  db.withWrite((w: Database.Database) => {
    w.prepare(
      `INSERT INTO incident_action (incidentId, actorKind, actorId, action, reason, at)
       VALUES (?, 'boss', NULL, ?, ?, ?)`,
    ).run(incidentId, REPORT_UPLOAD_FAILED_ACTION, error, at);
    const failed = w
      .prepare(
        "SELECT COUNT(*) AS n FROM incident_action WHERE incidentId = ? AND action = ?",
      )
      .get(incidentId, REPORT_UPLOAD_FAILED_ACTION) as { n: number };
    if (failed.n < REPORT_UPLOAD_ATTEMPTS) {
      w.prepare(
        "DELETE FROM incident_action WHERE incidentId = ? AND action = ?",
      ).run(incidentId, REPORT_PUBLISHED_ACTION);
    }
    return failed.n;
  });

/**
 * Attach the report to the incident thread, once.
 *
 * Until the close notice has reached the thread, every attempt carries it as
 * the file's message, so a close is one message. If an attempt fails, the
 * notice goes out alone with a line saying the report follows, and a later
 * attempt attaches the file on its own. Returns what happened rather than throwing: the callers are the close
 * and a timer, and neither has anything to do with a failure except log it,
 * which this module has already done.
 */
export const publishIncidentReport = async (
  deps: ReportDeps,
  incidentId: string,
): Promise<PublishOutcome> => {
  const now = deps.now ?? Date.now;

  const { claimed, failures, noticePosted } = await claim(deps.db, incidentId, now());
  if (!claimed) {
    log("publish_skipped", { incidentId, reason: "not closed, or already claimed" });
    return "skipped";
  }
  const noticeDue = !noticePosted;
  log("publish_claimed", { incidentId, attempt: failures + 1 });

  let data: ReportData | null = null;
  try {
    await deps.rollUpUsage?.(incidentId);
    data = await readReportData(deps, incidentId);
    if (!data) throw new Error("no such incident");
    const pdf = await (deps.renderPdf ?? renderReportPdf)(renderReportDocument(data));
    await deps.uploader.upload({
      channel: deps.channel,
      threadTs: data.incident.slackThreadTs,
      filename: `incident-${data.incident.id}.pdf`,
      title: `Incident ${data.incident.id} — closing report`,
      content: pdf,
      comment: noticeDue ? closeNoticeFor(data) : null,
    });
    log("published", {
      incidentId,
      bytes: pdf.byteLength,
      attempt: failures + 1,
      signals: data.signals.length,
      prs: data.prs.length,
    });
    return "published";
  } catch (err) {
    if (err instanceof UploadOutcomeUnknownError) {
      // The file may be in the thread. A second copy is the one outcome this
      // cannot take back, so the claim stands and a person gets told.
      alarm("upload_outcome_unknown", { incidentId, error: String(err) });
      return "skipped";
    }

    // Reading and rendering fail here too, and are retried with the upload:
    // an unreadable row can be repaired, and the attempt limit bounds the
    // one that cannot.
    const attempts = await recordFailure(deps.db, incidentId, String(err), now());
    // The likeliest persistent cause is `files:write` missing because the
    // app was never reinstalled after the scope was added, and a swallowed
    // missing_scope looks exactly like a BugBoss that is working.
    alarm("upload_failed", {
      incidentId,
      error: String(err),
      attempt: attempts,
      of: REPORT_UPLOAD_ATTEMPTS,
    });
    const threadTs = data?.incident.slackThreadTs ?? readThreadTs(deps.db, incidentId);
    const say = async (text: string): Promise<boolean> => {
      try {
        await deps.post(threadTs, text);
        return true;
      } catch (postErr) {
        alarm("notice_failed", { incidentId, error: String(postErr) });
        return false;
      }
    };
    // The notice rides with the last word on the report, whichever that is,
    // so a close is never announced in two posts when one would do.
    const withNotice = async (line: string): Promise<void> => {
      if (!noticeDue) {
        await say(line);
        return;
      }
      const text = data ? `${closeNoticeFor(data)}\n${line}` : closedNotice(incidentId, line);
      if (await say(text)) await recordNotice(deps.db, incidentId, now());
    };

    if (attempts < REPORT_UPLOAD_ATTEMPTS) {
      if (noticeDue) await withNotice("_The closing report is attaching shortly._");
      return "retrying";
    }

    alarm("upload_abandoned", { incidentId, attempts, error: String(err) });
    await withNotice(
      mrkdwn`_The closing report for Incident ${incidentId} could not be attached after ${attempts} attempts. It is saved with the incident._`,
    );
    return "abandoned";
  }
};

const readThreadTs = (db: Db, incidentId: string): string | null =>
  db.get<{ slackThreadTs: string | null }>(
    "SELECT slackThreadTs FROM incident WHERE id = ?",
    [incidentId],
  )?.slackThreadTs ?? null;

/**
 * Publish anything that closed and has no report in its thread yet.
 *
 * Two kinds of incident land here. One whose container was replaced between
 * the close and its publish: nothing relaunches an agent on a CLOSED
 * incident, so without this the close would never be announced at all. And
 * one whose upload failed, which waits out the retry spacing so a Slack that
 * will not take the file is not asked again on every tick.
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
        AND NOT EXISTS (
          SELECT 1 FROM incident_action f
           WHERE f.incidentId = incident.id AND f.action = ? AND f.at > ?
        )
      ORDER BY closedAt
      LIMIT ?`,
    [
      now() - REPORT_SWEEP_GRACE_MS,
      REPORT_PUBLISHED_ACTION,
      REPORT_UPLOAD_FAILED_ACTION,
      now() - REPORT_UPLOAD_RETRY_MS,
      REPORT_SWEEP_LIMIT,
    ],
  );

  let settled = 0;
  for (const row of due) {
    const outcome = await publishIncidentReport(deps, row.id);
    if (outcome === "published" || outcome === "abandoned") settled++;
  }
  if (settled > 0) log("sweep_published", { incidents: settled });
  return settled;
};
