// Job 4: serve the agent tool API. Design spec: bugboss/docs/architecture.md.
//
// The agent's only path to state. Six methods, three of which are state
// transitions, and every response carries the directives the agent has not
// picked up yet. That array is the whole coordination mechanism: there is no
// push channel and an agent never has to be addressable, so it learns that a
// human took over or that its incident was merged away as a side effect of a
// call it was already making.
//
// This is the single writer for incident state, so the two invariants are
// enforced here rather than anywhere they could be bypassed:
//
//   1. Every attached signal must be explained. Checked on entering FIXING
//      and again on leaving it, because a merge or a late attach can add a
//      signal the root cause never saw; anything unaccounted for is split
//      back out.
//   2. An incident cannot close over a firing signal. Deterministic, no model
//      involved, and it splits rather than refusing.

import type Database from "better-sqlite3";

import type { Db } from "../db";
import { indexIncident, searchIncidents, UnsearchableQuery } from "../db/search";
import { pickSections, postmortemProblem } from "../report/postmortem";
import { renderPostmortem } from "../report/render";
import type {
  Directive,
  Evidence,
  Incident,
  IncidentStatus,
  IncidentMatch,
  IncidentView,
  MergeOutcomeView,
  PriorIncident,
  RecurrenceAnalysis,
  Signal,
  SignalView,
  TimelineEvent,
  ToolApi,
  ToolResponse,
} from "../types";
import { GOAL_VERDICT_KIND, TIMELINE_EVENT_KINDS } from "../types";
import {
  assign,
  getIncidentRow,
  getSignalsFor,
  logAssign,
  pushDirective,
  rowToIncident,
  rowToSignal,
  type AssignResult,
  type IncidentRow,
  type SignalRow,
} from "./assign";
import {
  agentClosedDetail,
  bossClosedDetail,
  closedNotice,
  createAnnouncer,
  type AnnouncePoster,
} from "./announce";
import { verifyAgentToken } from "./token";
import {
  bullets,
  escape,
  link,
  mrkdwn,
  overSummaryBudget,
  overThreadBudget,
  raw,
  splitForSlack,
  toMrkdwn,
} from "../slack/format";
import { makeAlarm, makeLog } from "../logging";

export * from "./announce";
export * from "./assign";
export * from "./token";

const log = makeLog("toolapi");

/**
 * For a failure nobody asked for, as opposed to a transition this module
 * refused on purpose. A rejected call is the system working; a thrown one
 * means a write was lost, and the dispatcher's answer to a lost write is to
 * relaunch an agent that will lose it again.
 */
const alarm = makeAlarm("toolapi");

// ---------------------------------------------------------------------------
// Collaborators
// ---------------------------------------------------------------------------

/** One incident absorbed into another. The Boss decides; this module applies. */
export interface CorrelationMerge {
  absorb: string;
  into: string;
  reason: string;
}

/**
 * Job 2b. Incident agents do not know about each other, so only the Boss can
 * notice that two incidents share a cause. The comparison itself lives in the
 * triage chunk; the tool API just triggers it and applies the result.
 */
export interface Correlator {
  correlate(args: {
    incidentId: string;
    rootCause: string;
  }): Promise<CorrelationMerge[]>;
  /**
   * The same judgement, asked by an agent instead of triggered by a root
   * cause. Scoped to the one incident it named.
   */
  judgeMerge(args: {
    incidentId: string;
    withIncidentId: string;
    reason: string;
  }): Promise<MergeVerdict>;
}

/**
 * `compared: false` is not a quiet no. Nothing weighed the two, which is a
 * different thing to tell the agent than "these are not the same problem" --
 * one means stop asking and the other means ask a person.
 */
export interface MergeVerdict {
  merge: CorrelationMerge | null;
  compared: boolean;
}

/** Job 5. Status transitions, posted by code whoever caused them. */
export interface ThreadPoster {
  post(threadTs: string | null, text: string): Promise<{ ts: string }>;
  /**
   * A link to one message, which is the only way a thread can point at
   * another one. Slack builds it from the workspace domain, so it is an API
   * call and not string concatenation.
   */
  permalink(messageTs: string): Promise<string>;
  /**
   * Open a Slack thread for every open incident that has none yet.
   *
   * A split creates incidents inside the same transaction as the transition,
   * and their threads are opened afterwards by the relay. Without this the
   * message telling the new incident where it came from would have nowhere
   * to go and the one telling the old incident where its signals went would
   * have nothing to link to.
   */
  openThreads(): Promise<unknown>;
}

/** Pre-fetched evidence, which lives in S3 rather than on the incident row. */
export interface EvidenceStore {
  load(incidentId: string): Promise<Evidence[]>;
}

export interface ToolApiDeps {
  db: Db;
  /** The scoped token the dispatcher minted for this run. */
  token: string;
  tokenSecret: string;
  correlator: Correlator;
  slack: ThreadPoster;
  evidence: EvidenceStore;
  /**
   * The close's one message: the notice with the closing report attached.
   * Never throws; a report that will not go out is retried by the report
   * sweep. Absent, the notice is posted alone as text.
   */
  announceClose?: (incidentId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------

type Body<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Resolution closes the incident's open signals. It does not split them.
 *
 * Splitting here asked the wrong question. "Has a resolve notification
 * arrived yet" is not "is this still broken": the agent watches the alert
 * go quiet and reports, and Grafana's resolved delivery lands after that,
 * so on the ordinary path every single resolution split its own signal
 * into a fresh incident and the dispatcher launched an agent on it. A
 * source that cannot report resolution at all never closed.
 *
 * The evidence that a resolution was wrong is a signal arriving after it,
 * which triage already judges: it may not attach to a RESOLVED incident
 * and can point `recurrenceOf` at the one that claimed the ground. That is
 * positive evidence rather than absence of contrary evidence, and it is
 * the mechanism the spec describes. This is the only one now.
 */
const closeOpenSignals = (
  w: Database.Database,
  incidentId: string,
  at: number,
): void => {
  w.prepare(
    "UPDATE signal SET closedAt = ? WHERE incidentId = ? AND closedAt IS NULL",
  ).run(at, incidentId);
};

const placeholders = (n: number) => new Array(n).fill("?").join(",");

/**
 * Oldest first by when it happened, which is the order a timeline is read
 * in. The id breaks ties, so two events in the same millisecond keep the
 * order they were recorded in.
 */
export const readTimelineEvents = (
  db: Pick<Db, "query">,
  incidentId: string,
): TimelineEvent[] =>
  db.query<TimelineEvent>(
    `SELECT id, kind, occurredAt, recordedAt, summary, evidenceUrl
       FROM incident_timeline_event WHERE incidentId = ?
       ORDER BY occurredAt, id`,
    [incidentId],
  );

export const createToolApi = (deps: ToolApiDeps): ToolApi => {
  const { db, correlator, slack, evidence } = deps;

  const readIncident = (id: string): Incident | undefined => {
    const row = db.get<IncidentRow>("SELECT * FROM incident WHERE id = ?", [id]);
    return row ? rowToIncident(row) : undefined;
  };

  /**
   * The post-mortem goes whole, which is the whole point of carrying it.
   *
   * It used to be cut at 6,000 characters, and the reason given was that the
   * agent's own tool-output truncation kept a head and a tail, so an
   * unbounded post-mortem would eat the middle of the incident rather than
   * itself. That truncation is gone: Pi compacts just in time, so a tool
   * result lands whole and what gives way is summarised history. The cap
   * outlived the thing it was protecting against.
   */
  const toPriorIncident = (prior: Incident): PriorIncident => ({
    id: prior.id,
    status: prior.status,
    summary: prior.summary,
    rootCause: prior.rootCause,
    prUrls: prior.prUrls,
    resolvedEvidence: prior.resolvedEvidence,
    postmortem: prior.postmortem,
    resolvedAt: prior.resolvedAt,
    closedAt: prior.closedAt,
  });

  const readPriorIncident = (id: string | null): PriorIncident | null => {
    if (!id) return null;
    const prior = readIncident(id);
    // A dangling pointer is a real fault: recurrenceOf is a foreign key, so
    // the row cannot simply be missing. Never a silent null.
    if (!prior) {
      alarm("prior_incident_missing", {
        recurrenceOf: id,
        note: "the incident this one recurs from cannot be read, so the agent starts without the post-mortem that explains it",
      });
      return null;
    }
    return toPriorIncident(prior);
  };

  /**
   * The incidents merged into this one, newest first.
   *
   * Read off `mergedInto` rather than remembered from the merge, so it is
   * the same answer after a restart and after a merge this process never
   * saw. No alarm on an empty result: almost every incident has absorbed
   * nothing, which is not a fault.
   */
  const readAbsorbed = (incidentId: string): PriorIncident[] =>
    db
      .query<IncidentRow>(
        "SELECT * FROM incident WHERE mergedInto = ? ORDER BY CAST(id AS INTEGER) DESC",
        [incidentId],
      )
      .map((row) => toPriorIncident(rowToIncident(row)));

  /** Strips triage's spend, which the agent has no use for. See SignalView. */
  const toSignalView = ({
    tokensIn: _tokensIn,
    tokensOut: _tokensOut,
    cacheRead: _cacheRead,
    cacheWrite: _cacheWrite,
    modelCalls: _modelCalls,
    modelId: _modelId,
    ...rest
  }: Signal): SignalView => rest;

  const readSignals = (id: string): Signal[] =>
    db
      .query<SignalRow>(
        "SELECT * FROM signal WHERE incidentId = ? ORDER BY openedAt, id",
        [id],
      )
      .map(rowToSignal);

  /**
   * Read and delete together. The read-only probe first keeps the common case
   * off the write path, since every write costs a full snapshot PUT to S3.
   */
  const drain = async (incidentId: string): Promise<Directive[]> => {
    const pending = db.query(
      "SELECT id FROM pending_directive WHERE incidentId = ? LIMIT 1",
      [incidentId],
    );
    if (pending.length === 0) return [];
    return db.withWrite((w) => {
      const rows = w
        .prepare(
          "SELECT id, payload FROM pending_directive WHERE incidentId = ? ORDER BY id",
        )
        .all(incidentId) as { id: number; payload: string }[];
      if (rows.length === 0) return [];
      w.prepare(
        `DELETE FROM pending_directive WHERE id IN (${placeholders(rows.length)})`,
      ).run(...rows.map((r) => r.id));
      return rows.map((r) => JSON.parse(r.payload) as Directive);
    });
  };

  /**
   * Directive delivery is best effort. The transaction that deletes them is
   * the only thing that can fail here, and it rolls back, so a failure means
   * the same directives arrive on the next call rather than being lost --
   * which is a far better outcome than telling an agent its committed
   * transition failed.
   */
  const drainSafely = async (
    incidentId: string,
    tool: string,
  ): Promise<Directive[]> => {
    try {
      return await drain(incidentId);
    } catch (err) {
      alarm("drain_failed", { tool, incidentId, error: String(err) });
      return [];
    }
  };

  /**
   * Every method goes through here, which is what makes three properties
   * unskippable: the incident comes from the token and never from an
   * argument, directives drain on the failure path as well as the success
   * path, and a rejected write reaches the model as an error it can read
   * rather than as a crashed harness.
   */
  const call = async <T>(
    tool: string,
    fn: (incidentId: string) => Promise<Body<T>>,
  ): Promise<ToolResponse<T>> => {
    let incidentId: string;
    try {
      incidentId = verifyAgentToken(deps.tokenSecret, deps.token).incidentId;
    } catch (err) {
      log("token_rejected", { tool, error: String(err) });
      return { ok: false, error: (err as Error).message, directives: [] };
    }

    try {
      const body = await fn(incidentId);
      if (!body.ok) log("rejected", { tool, incidentId, error: body.error });
      return { ...body, directives: await drainSafely(incidentId, tool) };
    } catch (err) {
      alarm("failed", { tool, incidentId, error: String(err) });
      return {
        ok: false,
        error: (err as Error).message,
        directives: await drainSafely(incidentId, tool),
      };
    }
  };

  const { notify, threadRef, announceMerge } = createAnnouncer({ db, slack });

  /**
   * Both sides of a split, which asks the same two questions a merge does
   * from the other end: where did these signals go, and where did this
   * incident come from. A thread that opens with no answer to the second
   * reads as an incident that appeared out of nowhere.
   */
  const announceSplit = async (
    source: Incident,
    splits: AssignResult[],
  ): Promise<void> => {
    // The incidents this call just created have no thread yet, and a thread
    // that does not exist can be neither linked nor posted into.
    try {
      await slack.openThreads();
    } catch (err) {
      alarm("split_threads_unopened", {
        incidentId: source.id,
        error: String(err),
      });
    }

    // Re-read after opening threads. The row this was called with was read
    // before the transition, and the incident being split can be the one
    // openThreads just gave a thread to -- in which case the stale copy sends
    // its own announcement to the top level and leaves the back-link blank.
    const from = readIncident(source.id) ?? source;

    const one = splits.length === 1;
    const refs = await Promise.all(
      splits.map((split) =>
        threadRef(readIncident(split.target), `incident ${split.target}`),
      ),
    );

    await notify(
      from,
      [
        mrkdwn`*${splits.length} signal${one ? "" : "s"} left this incident, because its root cause does not explain ${one ? "it" : "them"}*`,
        mrkdwn`_Now worked separately as ${raw(refs.join(", "))}, with a new agent on ${one ? "it" : "each"} · this incident keeps the signals its root cause does explain._`,
      ].join("\n"),
    );

    for (const split of splits) {
      const born = readIncident(split.target);
      if (!born?.slackThreadTs) {
        alarm("split_thread_missing", {
          incidentId: split.target,
          from: from.id,
        });
        continue;
      }
      await notify(
        born,
        [
          mrkdwn`*This incident was split out of incident ${from.id}*`,
          mrkdwn`Incident ${from.id} found a root cause that does not account for what is here, so this is worked on its own from now on.`,
          mrkdwn`_A separate agent is on this one · incident ${from.id} carries on in ${raw(await threadRef(from, "its own thread"))}._`,
        ].join("\n"),
      );
    }
  };

  const reject = (error: string): Body<never> => ({ ok: false, error });

  /**
   * The cheap probe, on the read-only connection. It runs before the call
   * reaches the write queue, so it can reject early but cannot hold a
   * transition: every write below repeats it as a predicate on its own
   * UPDATE, which is what actually decides.
   */
  const blocked = (
    incident: Incident,
    allowed: IncidentStatus[],
    tool: string,
  ): string | null => {
    if (!allowed.includes(incident.status)) {
      return `${tool} requires ${allowed.join(" or ")}; incident ${incident.id} is ${incident.status}`;
    }
    return null;
  };

  /** The guarded UPDATE matched nothing, so someone else moved the record. */
  const raced = (incidentId: string, tool: string): Body<never> => {
    const now = readIncident(incidentId);
    return reject(
      now
        ? `${tool} lost a race on incident ${incidentId}: it is ${now.status}, and the transition did not apply`
        : `${tool} lost a race on incident ${incidentId}, which is gone`,
    );
  };

  /**
   * Invariant 2. A signal with no closedAt is still firing, which is a
   * deterministic fact about ingest rather than a judgement, so no model is
   * involved. Each one leaves for an incident of its own carrying
   * recurrenceOf, which is exactly what that field is for: this reopens
   * ground a resolution claimed.
   */
  /** Correlation moves records nobody else has claimed, in either direction. */
  const mergeable = (row: Incident | undefined): row is Incident =>
    !!row && (row.status === "INVESTIGATING" || row.status === "FIXING");

  const where = (row: Incident | undefined) =>
    row ? { status: row.status } : { status: "gone" };

  /**
   * Declining is a decision, not a non-event: the Boss believed two
   * incidents share a cause and we are leaving them apart, so two agents may
   * keep working the same bug. Reported after the transaction, like
   * logAssign, so a rolled-back attempt leaves no record of being considered.
   */
  type MergeOutcome =
    | { kind: "applied"; result: AssignResult }
    | { kind: "declined"; merge: CorrelationMerge; why: Record<string, unknown> };

  const applyMerge = (
    w: Database.Database,
    merge: CorrelationMerge,
  ): MergeOutcome => {
    const declined = (why: Record<string, unknown>): MergeOutcome => ({
      kind: "declined",
      merge,
      why,
    });

    if (merge.absorb === merge.into) {
      return declined({ reason: "an incident cannot absorb itself" });
    }

    const absorb = getIncidentRow(w, merge.absorb);
    if (!mergeable(absorb)) {
      const at = where(absorb);
      return declined({
        reason: "the incident to absorb is no longer an agent's open work",
        absorbStatus: at.status,
      });
    }

    // Skipped rather than thrown: assign refuses a target it may not take,
    // and a stale merge proposal must not fail the root cause that ran it.
    const into = getIncidentRow(w, merge.into);
    if (!mergeable(into)) {
      const at = where(into);
      return declined({
        reason: "the target is no longer an agent's open work",
        intoStatus: at.status,
      });
    }

    const signals = getSignalsFor(w, merge.absorb);
    if (signals.length === 0) {
      return declined({ reason: "the incident to absorb has no signals left" });
    }

    // The cause has to travel with the signals, and it cannot travel as a
    // column. Correlation now absorbs the reporting incident whenever an
    // older record turns out to be the same bug, so the incident carrying
    // the root cause is routinely the one that closes -- and writing that
    // cause onto the survivor would forge a transition no agent made, past
    // the gate that makes every attached signal explained. So it travels as
    // the merge's reason, which is what the surviving agent reads in its
    // `new_signals` directive and what both threads are told. It arrives as
    // a claim to check, which is the only form an unverified cause can
    // honestly take: the survivor's own agent is the thing that can run it
    // against the signals and call reportRootCause.
    const cause =
      absorb.rootCause && !into.rootCause
        ? `\n\nIncident ${merge.absorb} reported this root cause before it was absorbed, and nothing has checked it against the signals that just arrived: ${absorb.rootCause}`
        : "";

    return {
      kind: "applied",
      result: assign(
        w,
        {
          signalIds: signals.map((s) => s.id),
          target: merge.into,
          reason: `${merge.reason}${cause}`,
        },
        { kind: "boss" },
      ),
    };
  };

  const reportRootCause: ToolApi["reportRootCause"] = (args) =>
    call("reportRootCause", async (incidentId) => {
      const incident = readIncident(incidentId);
      if (!incident) return reject(`unknown incident: ${incidentId}`);

      const stop = blocked(incident, ["INVESTIGATING"], "reportRootCause");
      if (stop) return reject(stop);

      const signals = readSignals(incidentId);
      const attached = new Set(signals.map((s) => s.id));
      const foreign = args.explainedSignalIds.filter((id) => !attached.has(id));
      if (foreign.length > 0) {
        return reject(
          `not attached to incident ${incidentId}: ${foreign.join(", ")}`,
        );
      }

      const explained = [...new Set(args.explainedSignalIds)];
      if (explained.length === 0) {
        return reject(
          "a root cause must explain at least one attached signal; an incident it explains nothing about has no reason to exist",
        );
      }

      const splits = await db.withWrite((w) => {
        // Guarded on status as well as id. Correlation can merge this
        // incident away while the call waits its turn in the write queue,
        // and a FIXING record with no signals is eligible forever.
        const taken = w
          .prepare(
            `UPDATE incident SET status = 'FIXING', rootCause = ?, fixingAt = ?,
               usersImpacted = COALESCE(?, usersImpacted),
               impactQuery = COALESCE(?, impactQuery),
               impactStartedAt = COALESCE(?, impactStartedAt)
             WHERE id = ? AND status = 'INVESTIGATING'`,
          )
          .run(
            args.cause,
            Date.now(),
            args.usersImpacted ?? null,
            args.impactQuery ?? null,
            args.impactStartedAt ?? null,
            incidentId,
          ).changes;
        if (taken === 0) return null;

        // Scoped by incidentId as well as by id, so this statement cannot
        // reach another incident's signals even if the check above regresses.
        w.prepare(
          `UPDATE signal SET explained = 1
           WHERE incidentId = ? AND id IN (${placeholders(explained.length)})`,
        ).run(incidentId, ...explained);

        // Re-read inside the transaction rather than trusting the check
        // above. Triage attaches across FIXING, so a signal can land between
        // the two, and this is the single writer.
        return getSignalsFor(w, incidentId)
          .filter((s) => !explained.includes(s.id))
          .map((s) =>
            assign(
              w,
              {
                signalIds: [s.id],
                target: "NEW",
                reason: `not explained by incident ${incidentId}: ${args.cause}`,
              },
              { kind: "agent", incidentId },
            ),
          );
      });
      if (splits === null) return raced(incidentId, "reportRootCause");
      splits.forEach(logAssign);

      if (splits.length > 0) await announceSplit(incident, splits);

      // Correlation runs after the transition is durable. It is the Boss's
      // job and a failure in it must not cost the agent its root cause.
      let merges: CorrelationMerge[] = [];
      try {
        merges = await correlator.correlate({
          incidentId,
          rootCause: args.cause,
        });
      } catch (err) {
        alarm("correlation_failed", { incidentId, error: String(err) });
      }

      const outcomes = merges.length
        ? await db.withWrite((w) => merges.map((m) => applyMerge(w, m)))
        : [];
      for (const outcome of outcomes) {
        if (outcome.kind === "declined") {
          log("merge_declined", {
            incidentId,
            absorb: outcome.merge.absorb,
            into: outcome.merge.into,
            proposedBecause: outcome.merge.reason,
            ...outcome.why,
          });
        }
      }

      const applied = outcomes
        .filter((o) => o.kind === "applied")
        .map((o) => o.result);
      applied.forEach(logAssign);

      for (const merge of applied) await announceMerge(merge);

      // Read back rather than asserted. Correlation can now absorb the
      // reporting incident itself -- when an older incident turns out to be
      // the same bug, the cause travels to it and this record is the one
      // that closes -- so the FIXING this call just wrote is no longer
      // something it can claim afterwards. The `merged` directive riding
      // out with this response is what stands the agent down; a status
      // saying FIXING underneath it would contradict it.
      return {
        ok: true,
        data: {
          incidentId,
          status: readIncident(incidentId)?.status ?? ("FIXING" as IncidentStatus),
          splitInto: splits.map((s) => s.target),
          merged: applied.flatMap((m) => m.merged),
        },
      };
    });

  /**
   * The few-word title, rewritten.
   *
   * Callable at any status an agent is still on, including INVESTIGATING
   * before there is any conclusion at all -- an incident with no title is
   * the state this exists to remove, so the first call must not have to wait
   * for a root cause.
   *
   * Nothing is announced. A title changing is not news: the thread's header
   * picks it up on the next sweep, which is where somebody reads it, and a
   * message every time an agent sharpens four words would be the noise that
   * gets the channel muted. The transitions that *are* news already post.
   */
  const setSummary: ToolApi["setSummary"] = (args) =>
    call("setSummary", async (incidentId) => {
      const incident = readIncident(incidentId);
      if (!incident) return reject(`unknown incident: ${incidentId}`);

      const stop = blocked(
        incident,
        ["INVESTIGATING", "FIXING", "RESOLVED"],
        "setSummary",
      );
      if (stop) return reject(stop);

      // Collapsed before it is measured, because a title is one line by
      // definition and a newline inside one breaks every row of the board
      // it is about to appear in.
      const summary = args.summary.replace(/\s+/g, " ").trim();
      if (!summary) {
        return reject(
          "The summary is empty. Say what is broken and who it is broken for, in a few words.",
        );
      }
      const tooLong = overSummaryBudget(summary);
      if (tooLong) return reject(tooLong);

      const applied = await db.withWrite(
        (w) =>
          w
            .prepare(
              `UPDATE incident SET summary = ?
               WHERE id = ? AND status IN ('INVESTIGATING','FIXING','RESOLVED')`,
            )
            .run(summary, incidentId).changes,
      );
      if (applied === 0) return raced(incidentId, "setSummary");

      return { ok: true, data: { incidentId, summary } };
    });

  const reportImpact: ToolApi["reportImpact"] = (args) =>
    call("reportImpact", async (incidentId) => {
      const incident = readIncident(incidentId);
      if (!incident) return reject(`unknown incident: ${incidentId}`);

      const stop = blocked(
        incident,
        ["INVESTIGATING", "FIXING", "RESOLVED"],
        "reportImpact",
      );
      if (stop) return reject(stop);

      const applied = await db.withWrite(
        (w) =>
          w
            .prepare(
              `UPDATE incident SET usersImpacted = ?, impactQuery = ?
               WHERE id = ? AND status IN ('INVESTIGATING','FIXING','RESOLVED')`,
            )
            .run(args.usersImpacted, args.query, incidentId).changes,
      );
      if (applied === 0) return raced(incidentId, "reportImpact");

      // A human deciding whether to step in needs the current number, so a
      // change goes to the thread. An unchanged number is not news.
      if (incident.usersImpacted !== args.usersImpacted) {
        await notify(
          incident,
          mrkdwn`*Impact on ${incidentId}: ${args.usersImpacted} users*\n_Previously ${incident.usersImpacted ?? "unknown"}._`,
        );
      }

      return { ok: true, data: { incidentId, usersImpacted: args.usersImpacted } };
    });

  const reportResolved: ToolApi["reportResolved"] = (args) =>
    call("reportResolved", async (incidentId) => {
      const incident = readIncident(incidentId);
      if (!incident) return reject(`unknown incident: ${incidentId}`);

      const stop = blocked(incident, ["FIXING"], "reportResolved");
      if (stop) return reject(stop);

      // Ahead of the write, not after it: the evidence goes to the thread and
      // this is the model's own prose, so it is the model that has to shorten
      // it, and it cannot be asked to once the incident has already moved to
      // RESOLVED.
      const longEvidence = overThreadBudget("evidence", args.evidence);
      if (longEvidence) return reject(longEvidence);

      const repeated = repeatedEvidence(incident, args.evidence);
      if (repeated) return reject(repeated);

      const splits = await db.withWrite((w) => {
        const at = Date.now();
        const taken = w
          .prepare(
            `UPDATE incident SET status = 'RESOLVED', resolvedAt = ?, prUrls = ?,
               resolvedEvidence = ?
             WHERE id = ? AND status = 'FIXING'`,
          )
          .run(at, JSON.stringify(args.prUrls), args.evidence, incidentId).changes;
        if (taken === 0) return null;

        // Invariant 1, a second time. Entering FIXING is not the last moment
        // a signal can arrive: correlation merges move signals in and reset
        // explained on them, and triage attaches across FIXING. Whatever
        // this root cause never accounted for leaves before the incident
        // claims the problem is over, and it leaves still firing, so the
        // split happens ahead of closing what remains.
        const unexplained = getSignalsFor(w, incidentId)
          .filter((s) => !s.explained)
          .map((s) =>
            assign(
              w,
              {
                signalIds: [s.id],
                target: "NEW",
                reason: `not explained by incident ${incidentId}: ${incident.rootCause ?? "no root cause recorded"}`,
              },
              { kind: "agent", incidentId },
            ),
          );

        closeOpenSignals(w, incidentId, at);
        // RESOLVED is already searchable ground: it claims no further alerts
        // should occur, which is the claim a later signal contradicts.
        indexIncident(w, incidentId);
        return unexplained;
      });
      if (splits === null) return raced(incidentId, "reportResolved");
      splits.forEach(logAssign);

      if (splits.length > 0) await announceSplit(incident, splits);

      await notify(
        incident,
        [
          mrkdwn`*Incident ${incidentId} resolved*`,
          toMrkdwn(args.evidence),
          ...(args.prUrls.length
            ? [bullets(args.prUrls.map((url) => `Shipped: ${link(url)}`))]
            : []),
        ].join("\n"),
      );
      return {
        ok: true,
        data: {
          incidentId,
          status: "RESOLVED" as IncidentStatus,
          splitInto: splits.map((s) => s.target),
        },
      };
    });

  /** Long enough to be an answer rather than an acknowledgement. */
  const MIN_RECURRENCE_ANSWER_CHARS = 40;

  /**
   * The one invariant a `CHECK` constraint would have carried if the schema
   * could still take one. Refused at the tool: an agent that cannot say why
   * the last resolution failed has not finished, and leaving the incident
   * open and escalated is the correct place for a recurrence nobody can
   * explain.
   */
  const recurrenceGap = (
    incident: Incident,
    analysis: RecurrenceAnalysis | undefined,
  ): string | null => {
    if (!incident.recurrenceOf) return null;
    if (!analysis) {
      return `incident ${incident.id} is a recurrence of ${incident.recurrenceOf}, so reportAnalysis needs a recurrence argument: why that resolution did not hold, which kind of failure it was, and what you did about that rather than about the symptom. If you cannot answer it, escalate and leave this open instead of closing it.`;
    }
    if (analysis.why.trim().length < MIN_RECURRENCE_ANSWER_CHARS) {
      return `recurrence.why is too short to be an answer; say specifically why the resolution of ${incident.recurrenceOf} did not hold`;
    }
    if (analysis.remedy.trim().length < MIN_RECURRENCE_ANSWER_CHARS) {
      return `recurrence.remedy is too short; name what you changed so this does not recur again, or state plainly that you changed nothing and why`;
    }
    return null;
  };

  /**
   * Byte-identical resolution evidence on a recurrence is the failure the
   * previous incident already made: watching the same window for the same
   * interval and reporting the same quiet is how a premature close happens
   * twice. Narrow on purpose -- it catches the literal repeat, not a
   * paraphrase, and the prompt carries the rest.
   */
  const repeatedEvidence = (incident: Incident, evidence: string): string | null => {
    if (!incident.recurrenceOf) return null;
    const prior = readIncident(incident.recurrenceOf);
    const same =
      prior?.resolvedEvidence &&
      prior.resolvedEvidence.trim().replace(/\s+/g, " ") ===
        evidence.trim().replace(/\s+/g, " ");
    return same
      ? `this is the resolution evidence incident ${incident.recurrenceOf} was closed on, and it did not hold. Watch something the last check would have missed, or for longer, before claiming this one is resolved.`
      : null;
  };

  // No character budget on the post-mortem, deliberately, and this is the one
  // transition where that is true. It is not posted as thread text -- it
  // becomes the closing report, a PDF attached to the close notice -- so the
  // thread stays short by the document being somewhere else rather than by
  // the write-up being shorter. The one length rule is practiceChanges' word
  // range, and it refuses rather than cuts.
  const reportAnalysis: ToolApi["reportAnalysis"] = (args) =>
    call("reportAnalysis", async (incidentId) => {
      const incident = readIncident(incidentId);
      if (!incident) return reject(`unknown incident: ${incidentId}`);

      const stop = blocked(incident, ["RESOLVED"], "reportAnalysis");
      if (stop) return reject(stop);

      const gap = recurrenceGap(incident, args.recurrence);
      if (gap) return reject(gap);

      const recorded = readTimelineEvents(db, incidentId).filter((event) => event.kind !== GOAL_VERDICT_KIND);
      const problem = postmortemProblem(args, recorded);
      if (problem) return reject(problem);
      const sections = pickSections(args);

      const applied = await db.withWrite((w) => {
        const at = Date.now();
        const taken = w
          .prepare(
            // The status guard is what holds this transition, so a MERGED
            // row cannot be resurrected through here.
            `UPDATE incident SET status = 'CLOSED', closedAt = ?, postmortem = ?,
               postmortemSections = ?, usersImpacted = ?, impactQuery = ?,
               recurrenceAnalysis = ?
             WHERE id = ? AND status = 'RESOLVED'`,
          )
          .run(
            at,
            renderPostmortem(sections, recorded),
            JSON.stringify(sections),
            args.usersImpacted,
            args.impactQuery,
            args.recurrence ? JSON.stringify(args.recurrence) : null,
            incidentId,
          ).changes;
        if (taken === 0) return false;
        closeOpenSignals(w, incidentId, at);
        // Same transaction as the close, so an incident that is searchable
        // and one that is closed are never two different facts.
        indexIncident(w, incidentId);
        return true;
      });
      if (!applied) return raced(incidentId, "reportAnalysis");

      if (deps.announceClose) {
        await deps.announceClose(incidentId);
      } else {
        await notify(incident, closedNotice(incidentId, agentClosedDetail(args.usersImpacted)));
      }

      // A recurrence closes on a second answer the first incident never had
      // to give, and that answer is the only thing here that can change the
      // system rather than the product. Posted rather than left in a column:
      // "BugBoss let a premature close happen" reaching nobody is the same
      // failure one level up.
      if (args.recurrence) {
        const defect = args.recurrence.category === "bugboss_defect";
        await notify(
          incident,
          mrkdwn`*${defect ? "BugBoss let this recur" : "Why it recurred"}* · ${incidentId} was a recurrence of ${incident.recurrenceOf ?? "an earlier incident"}\n_${args.recurrence.category}_\n\n${raw(toMrkdwn(args.recurrence.why))}\n\n*What changed*\n${raw(toMrkdwn(args.recurrence.remedy))}${
            defect
              ? "\n\n_The fix is in ops, which agents do not open pull requests against. This needs a person._"
              : ""
          }`,
        );
      }

      return {
        ok: true,
        data: { incidentId, status: "CLOSED" as IncidentStatus },
      };
    });

  /**
   * Any status, including CLOSED: a closer that remembers a moment while
   * writing the post-mortem still has somewhere to put it.
   *
   * Idempotent on the whole event. On a restart the session holds a tool
   * call with no result and the tool runs again, and a replay must not put
   * the same moment in the timeline twice.
   */
  const trackTimelineEvent: ToolApi["trackTimelineEvent"] = (args) =>
    call<TimelineEvent>("trackTimelineEvent", async (incidentId) => {
      if (!([...TIMELINE_EVENT_KINDS, GOAL_VERDICT_KIND] as readonly string[]).includes(args.kind)) {
        return reject(
          `unknown timeline event kind ${args.kind}; use one of ${TIMELINE_EVENT_KINDS.join(", ")}`,
        );
      }
      if (!Number.isFinite(args.occurredAt) || args.occurredAt <= 0) {
        return reject(
          "occurredAt must be epoch millis of when it happened; if you cannot point at a time, use the time of the evidence you have",
        );
      }
      // The report prints recorded times over the post-mortem's, so a time
      // ahead of now is a wrong time printed as fact. Incident 98 recorded
      // its merge a day after it was recorded.
      if (args.occurredAt > Date.now() + 60_000) {
        return reject(
          `occurredAt ${new Date(args.occurredAt).toISOString()} is in the future; take the time from the evidence (the merge commit, the log line, the release run), in epoch millis`,
        );
      }
      if (!readIncident(incidentId)) return reject(`unknown incident: ${incidentId}`);

      const kind = args.kind;
      const evidenceUrl = args.evidenceUrl ?? null;
      const event = await db.withWrite((w): TimelineEvent => {
        const existing = w
          .prepare(
            `SELECT id, kind, occurredAt, recordedAt, summary, evidenceUrl
               FROM incident_timeline_event
              WHERE incidentId = ? AND kind = ? AND occurredAt = ? AND summary = ?
                AND evidenceUrl IS ?`,
          )
          .get(incidentId, kind, args.occurredAt, args.summary, evidenceUrl) as
          | TimelineEvent
          | undefined;
        if (existing) return existing;
        const recordedAt = Date.now();
        const id = Number(
          w
            .prepare(
              `INSERT INTO incident_timeline_event
                 (incidentId, kind, occurredAt, recordedAt, summary, evidenceUrl)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(incidentId, kind, args.occurredAt, recordedAt, args.summary, evidenceUrl)
            .lastInsertRowid,
        );
        return { id, kind, occurredAt: args.occurredAt, recordedAt, summary: args.summary, evidenceUrl };
      });
      return { ok: true, data: event };
    });

  /**
   * The dispatcher's escalation, for a crash loop, a stall or a deadline the
   * agent did not answer. It says in the thread that this incident needs a
   * person and then changes nothing: an agent is still driving, so there is
   * no transition to lose a race on and nothing to retract when the post
   * fails. An agent's own escalation goes to the Boss's inbox instead.
   *
   * Rejected on a failed post, unlike every notification elsewhere in this
   * module. Everywhere else the state is already committed and the message is
   * commentary; here the message is the entire effect, so an escalation
   * nobody was told about has not happened and the caller has to know that.
   */
  const escalate: ToolApi["escalate"] = (args) =>
    call("escalate", async (incidentId) => {
      const incident = readIncident(incidentId);
      if (!incident) return reject(`unknown incident: ${incidentId}`);

      if (incident.status === "CLOSED" || incident.status === "MERGED") {
        return reject(
          `incident ${incidentId} is ${incident.status}; there is nothing left for a person to pick up`,
        );
      }

      // The brief is the first thing the person reading this sees, on a
      // phone, so it answers to the thread budget like every other post.
      const longBrief = overThreadBudget("brief", args.brief);
      if (longBrief) return reject(longBrief);

      const posted = await notify(
        incident,
        mrkdwn`*Incident ${incidentId} needs a person to look* · ${args.reason}\n\n${raw(toMrkdwn(args.brief))}\n\n_An agent is still working this incident._`,
      );
      if (!posted) {
        return reject(
          `could not post the escalation for incident ${incidentId}, so nobody has been told; it is worth calling again`,
        );
      }

      return { ok: true, data: { incidentId } };
    });

  const park: ToolApi["park"] = (args) =>
    call("park", async (incidentId) => {
      const incident = readIncident(incidentId);
      if (!incident) return reject(`unknown incident: ${incidentId}`);
      if (incident.status === "CLOSED" || incident.status === "MERGED") {
        return reject(
          `incident ${incidentId} is ${incident.status}; nothing is waiting on anything`,
        );
      }

      const at = Date.now();
      const wakeAt =
        args.wakeAfterSeconds === undefined
          ? null
          : at + Math.max(0, args.wakeAfterSeconds) * 1000;

      const liftsOnReply = args.liftsOnReply ?? true;

      await db.withWrite((w) =>
        w
          .prepare(
            `INSERT INTO incident_wait
               (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(incidentId) DO UPDATE SET
               waitingFor = excluded.waitingFor,
               wakeAt = excluded.wakeAt,
               liftsOnReply = excluded.liftsOnReply,
               startedAt = excluded.startedAt`,
          )
          .run(incidentId, args.waitingFor, wakeAt, liftsOnReply ? 1 : 0, at),
      );

      return { ok: true, data: { incidentId, wakeAt, liftsOnReply } };
    });

  /**
   * Any incident, not only the caller's. Containment is a rule about writes:
   * "a compromised agent re-partitions its own incident and nothing else" is
   * an argument about what it can move, and it says nothing about what it
   * can look at. Withholding the read bought nothing and cost coherence --
   * `searchIncidents` already returns other incidents' root causes and
   * post-mortems in full, and the Boss has served any incident
   * to anyone in the channel since it was written.
   *
   * It is also what makes `proposeMerge` worth having. An agent asking for
   * two incidents to be combined should have read the other one first.
   */
  const getIncident: ToolApi["getIncident"] = (args) =>
    call<IncidentView>("getIncident", async (own) => {
      const incidentId = args?.incidentId ?? own;
      const incident = readIncident(incidentId);
      if (!incident) return reject(`unknown incident: ${incidentId}`);

      let loaded: Evidence[] = [];
      try {
        loaded = await evidence.load(incidentId);
      } catch (err) {
        alarm("evidence_load_failed", { incidentId, error: String(err) });
      }

      return {
        ok: true,
        data: {
          incident,
          signals: readSignals(incidentId).map(toSignalView),
          evidence: loaded,
          priorIncident: readPriorIncident(incident.recurrenceOf),
          absorbed: readAbsorbed(incidentId),
          // Verdicts are the harness's, and not events the post-mortem matches.
          timeline: readTimelineEvents(db, incidentId).filter((event) => event.kind !== GOAL_VERDICT_KIND),
        },
      };
    });

  /**
   * Read-only and outside the transition set, so it drains no directives and
   * changes nothing. The agent gets the same reach triage has: an exact
   * signal key finds the same alert returning, and only the post-mortems
   * find the same cause returning through a different one.
   */
  const searchIncidentsTool: ToolApi["searchIncidents"] = (args) =>
    call<IncidentMatch[]>("searchIncidents", async (incidentId) => {
      try {
        return { ok: true, data: searchIncidents(db, args.text) };
      } catch (err) {
        // Rejected rather than answered with an empty array. "The search is
        // broken" and "nothing matches" are the two results that must never
        // be the same value, and this one is about to be read by an agent
        // deciding whether a problem is new.
        if (err instanceof UnsearchableQuery) {
          // Logged, not alarmed: nothing is broken, the words were the
          // problem, and an alarm that fires on ordinary input teaches
          // people to ignore alarms.
          log("search_unsearchable", { incidentId, text: args.text });
          return reject(
            `${(err as Error).message} Nothing was compared against the corpus, so this is not the same as finding nothing -- search again with the failing operation, the component or the error text.`,
          );
        }
        alarm("search_failed", { incidentId, error: String(err) });
        return reject(
          `the incident search failed (${String(err)}); this is not the same as finding nothing`,
        );
      }
    });

  /**
   * The agent's half of a cross-incident merge: it asks, and that is all it
   * does. Nothing here writes to another incident on the agent's word.
   *
   * Every sentence this returns is about incidents and signals. None of it
   * mentions which part of the system answered, because the agent repeats
   * these to people in a Slack thread and "an agent may not do that" is a
   * boundary they cannot see and did not ask about. Either it happened, or
   * they are told what is true about the work.
   */
  const proposeMerge: ToolApi["proposeMerge"] = (args) =>
    call<MergeOutcomeView>("proposeMerge", async (incidentId) => {
      const stay = (detail: string): Body<MergeOutcomeView> => ({
        ok: true,
        data: { combined: false, incidentOfRecord: incidentId, detail },
      });

      if (args.incidentId === incidentId) {
        return reject(`incident ${incidentId} is this incident`);
      }
      const mine = readIncident(incidentId);
      if (!mine) return reject(`unknown incident: ${incidentId}`);
      const other = readIncident(args.incidentId);
      if (!other) return reject(`unknown incident: ${args.incidentId}`);
      // Read off before the narrowing: `mergeable` is a type predicate, so
      // the branch where it is false has no row left to ask.
      const otherStatus = other.status;
      const myStatus = mine.status;
      if (!mergeable(other)) {
        return stay(
          `Incident ${args.incidentId} is ${otherStatus} and is not taking signals, so the two cannot be combined. A signal arriving after a resolution is a recurrence rather than the same incident.`,
        );
      }
      if (!mergeable(mine)) {
        return stay(
          `Incident ${incidentId} is ${myStatus} and is not taking signals, so the two cannot be combined.`,
        );
      }

      let verdict;
      try {
        verdict = await correlator.judgeMerge({
          incidentId,
          withIncidentId: args.incidentId,
          reason: args.reason,
        });
      } catch (err) {
        alarm("merge_request_failed", {
          incidentId,
          withIncidentId: args.incidentId,
          error: String(err),
        });
        verdict = { merge: null, compared: false };
      }

      if (!verdict.merge) {
        return stay(
          verdict.compared
            ? `Incident ${args.incidentId} was compared against this one and they are not the same problem, so both stay open. If you are sure, say why in the thread: a person there can combine them.`
            : `Incident ${args.incidentId} could not be compared against this one just now. Say in the thread what the two have in common, and a person there can combine them.`,
        );
      }

      const merge = verdict.merge;
      const outcome = await db.withWrite((w) => applyMerge(w, merge));
      if (outcome.kind === "declined") {
        log("merge_declined", {
          incidentId,
          absorb: outcome.merge.absorb,
          into: outcome.merge.into,
          proposedBecause: outcome.merge.reason,
          ...outcome.why,
        });
        return stay(
          `Incident ${args.incidentId} moved on while this was being weighed, so nothing was combined. Read it again before asking a second time.`,
        );
      }

      logAssign(outcome.result);
      await announceMerge(outcome.result);

      const record = outcome.result.target;
      return {
        ok: true,
        data: {
          combined: true,
          incidentOfRecord: record,
          detail:
            record === incidentId
              ? `Incident ${args.incidentId} is now part of this one, and its signals are here. Incident ${incidentId} is the older record, so it keeps the thread everything is posted to.`
              : `This incident is now part of incident ${record}, which is the older record and keeps the thread everything is posted to. Its agent has the signals and the reason given here.`,
        },
      };
    });

  return {
    reportRootCause,
    setSummary,
    reportImpact,
    reportResolved,
    reportAnalysis,
    escalate,
    park,
    getIncident,
    proposeMerge,
    searchIncidents: searchIncidentsTool,
    trackTimelineEvent,
  };
};

/** The statuses the Boss may close from: every one an incident is still open in. */
const BOSS_CLOSABLE: readonly IncidentStatus[] = [
  "INVESTIGATING",
  "FIXING",
  "RESOLVED",
];

/**
 * The Boss ending an incident, from any open status. `reason` is the evidence
 * it can cite, and the closing report says the Boss closed it rather than
 * dressing the reason up as an agent's analysis.
 *
 * A CLOSED row must carry `resolvedAt` and `postmortem` (`db/schema.sql`), and
 * that CHECK cannot change on a live table. An incident closed from FIXING has
 * neither, so both are filled here only where they are missing: a RESOLVED
 * incident keeps the resolution time and evidence its agent recorded.
 */
export const closeIncidentByBoss = async (
  deps: {
    db: Db;
    slack: AnnouncePoster;
    announceClose?: (incidentId: string) => Promise<void>;
  },
  args: { incidentId: string; reason: string },
): Promise<{ ok: true; from: IncidentStatus } | { ok: false; error: string }> => {
  const { db, slack } = deps;
  const { incidentId, reason } = args;

  if (!reason.trim()) {
    return { ok: false, error: "a close needs the evidence it rests on as its reason" };
  }
  const long = overThreadBudget("reason", reason);
  if (long) return { ok: false, error: long };

  const note = `Closed by BugBoss, not by the incident's agent, so there is no post-mortem analysis. The evidence it closed on: ${reason}`;

  const outcome = await db.withWrite(
    (w): { ok: true; from: IncidentStatus } | { ok: false; error: string } => {
      const row = getIncidentRow(w, incidentId);
      if (!row) return { ok: false, error: `unknown incident: ${incidentId}` };
      if (!BOSS_CLOSABLE.includes(row.status)) {
        return {
          ok: false,
          error: `incident ${incidentId} is ${row.status}, so there is nothing left to close`,
        };
      }
      const at = Date.now();
      const taken = w
        .prepare(
          `UPDATE incident SET status = 'CLOSED', closedAt = ?,
             resolvedAt = COALESCE(resolvedAt, ?),
             postmortem = COALESCE(postmortem, ?)
           WHERE id = ? AND status IN (${placeholders(BOSS_CLOSABLE.length)})`,
        )
        .run(at, at, note, incidentId, ...BOSS_CLOSABLE).changes;
      if (taken === 0) {
        return { ok: false, error: `incident ${incidentId} changed before it could be closed` };
      }
      w.prepare(
        `INSERT INTO incident_action (incidentId, actorKind, actorId, action, reason, at)
         VALUES (?, 'boss', NULL, 'close', ?, ?)`,
      ).run(incidentId, reason, at);
      closeOpenSignals(w, incidentId, at);
      indexIncident(w, incidentId);
      pushDirective(w, incidentId, {
        type: "stop",
        reason: `BugBoss closed this incident: ${reason}`,
      });
      return { ok: true, from: row.status };
    },
  );
  if (!outcome.ok) {
    log("boss_close_refused", { incidentId, error: outcome.error });
    return outcome;
  }

  log("boss_closed", { incidentId, from: outcome.from });
  if (deps.announceClose) {
    await deps.announceClose(incidentId);
    return outcome;
  }
  const row = db.get<IncidentRow>("SELECT * FROM incident WHERE id = ?", [incidentId]);
  if (row) {
    await createAnnouncer({ db, slack }).notify(
      rowToIncident(row),
      closedNotice(incidentId, bossClosedDetail(reason)),
    );
  }
  return outcome;
};
