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
import type {
  Directive,
  Evidence,
  Incident,
  IncidentStatus,
  IncidentMatch,
  IncidentView,
  PriorIncident,
  RecurrenceAnalysis,
  Signal,
  SignalView,
  ToolApi,
  ToolResponse,
} from "../types";
import {
  assign,
  getIncidentRow,
  getSignalsFor,
  logAssign,
  rowToIncident,
  rowToSignal,
  type AssignResult,
  type IncidentRow,
  type SignalRow,
} from "./assign";
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
}

/** Job 5. The Boss posts status transitions; the agent posts its own work. */
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
}

// ---------------------------------------------------------------------------

type Body<T> = { ok: true; data: T } | { ok: false; error: string };

const placeholders = (n: number) => new Array(n).fill("?").join(",");

export const createToolApi = (deps: ToolApiDeps): ToolApi => {
  const { db, correlator, slack, evidence } = deps;

  const readIncident = (id: string): Incident | undefined => {
    const row = db.get<IncidentRow>("SELECT * FROM incident WHERE id = ?", [id]);
    return row ? rowToIncident(row) : undefined;
  };

  /**
   * The post-mortem is the whole point of carrying this, and it is the one
   * field with no bound on it. getIncident renders as JSON followed by the
   * pending directives, and the agent's truncation keeps a head and a tail --
   * so an unbounded post-mortem eats the middle of the incident rather than
   * itself. Clipped here, where the size is known, instead.
   */
  const MAX_PRIOR_POSTMORTEM_CHARS = 6000;

  const toPriorIncident = (prior: Incident): PriorIncident => ({
    id: prior.id,
    status: prior.status,
    summary: prior.summary,
    rootCause: prior.rootCause,
    prUrls: prior.prUrls,
    resolvedEvidence: prior.resolvedEvidence,
    postmortem:
      prior.postmortem && prior.postmortem.length > MAX_PRIOR_POSTMORTEM_CHARS
        ? `${prior.postmortem.slice(0, MAX_PRIOR_POSTMORTEM_CHARS)}...[truncated; the full text is in the incident database]`
        : prior.postmortem,
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

  /**
   * Everything the Boss says in an incident thread goes through here, so this
   * is where mrkdwn and the length ceiling are enforced. An escalation brief or a
   * root cause is model prose that can run past what one message holds, and
   * chat.postMessage truncates rather than refusing, so it is split into
   * consecutive messages instead of being cut mid sentence.
   */
  const notify = async (incident: Incident, text: string): Promise<boolean> => {
    // The thread is looked up here rather than taken from the row the caller
    // is holding. Every transition reads its incident before it writes, and a
    // thread can be opened in between -- openThreads does exactly that during
    // a split. A stale null posts at the top of the channel, where nothing
    // groups it with the incident and Slack still answers ok.
    const threadTs =
      db.get<{ slackThreadTs: string | null }>(
        "SELECT slackThreadTs FROM incident WHERE id = ?",
        [incident.id],
      )?.slackThreadTs ?? incident.slackThreadTs;
    try {
      for (const part of splitForSlack(text)) {
        await slack.post(threadTs, part);
      }
      return true;
    } catch (err) {
      alarm("thread_post_failed", {
        incidentId: incident.id,
        error: String(err),
      });
      return false;
    }
  };

  /**
   * A reference to another incident's thread, as mrkdwn. Both branches are
   * escaped already, so interpolate it with raw().
   *
   * Losing the link is not losing the message: a thread nobody can find is
   * what this is here to fix, so a permalink that fails says so and the
   * sentence still reads.
   */
  const threadRef = async (
    incident: Incident | undefined,
    label: string,
  ): Promise<string> => {
    if (!incident?.slackThreadTs) return escape(label);
    try {
      return link(await slack.permalink(incident.slackThreadTs), label);
    } catch (err) {
      alarm("permalink_failed", { incidentId: incident.id, error: String(err) });
      return escape(label);
    }
  };

  /**
   * Both sides of a merge, written for somebody who has never used this
   * system and is reading one of these threads at 2am.
   *
   * The absorbed incident's thread is the half that cannot be skipped. After
   * this it is never written to again, and a thread that simply goes quiet
   * forever is indistinguishable from the Boss having died -- which is what
   * the reader is left to guess when the only message goes to the other
   * thread.
   *
   * The merge is already committed and durable by the time this runs, so a
   * post that fails alarms inside notify and the rest still goes out. A
   * notification is not worth rolling a re-partition back for.
   */
  const announceMerge = async (result: AssignResult): Promise<void> => {
    const into = readIncident(result.target);
    if (!into) {
      alarm("merge_target_gone", {
        target: result.target,
        merged: result.merged,
      });
      return;
    }

    for (const absorbedId of result.merged) {
      const absorbed = readIncident(absorbedId);
      const why = toMrkdwn(result.reason);
      // Both links before either post. Each falls back on its own, and
      // resolving them up front is what lets the order below be the only
      // thing deciding which message survives a Slack failure.
      const absorbedRef = await threadRef(
        absorbed,
        `incident ${absorbedId}'s thread`,
      );
      const intoRef = await threadRef(
        into,
        `incident ${result.target}'s thread`,
      );

      // The absorbed thread goes first. It is the one that is never written
      // to again, so if only one of these two lands it has to be that one:
      // the alternative is a surviving thread announcing that a thread is
      // closing while that thread says nothing and simply stops.
      if (absorbed?.slackThreadTs) {
        await notify(
          absorbed,
          [
            mrkdwn`*This incident is the same problem as incident ${result.target}, so the two have been merged*`,
            why,
            mrkdwn`_This is the last message in this thread · everything from here, including the fix and the post-mortem, is in ${raw(intoRef)}._`,
          ].join("\n"),
        );
      } else {
        // Nobody is left reading a thread that was never opened, so this is
        // not a lost message so much as evidence of one that was: an
        // incident reached a merge without the thread every incident gets.
        alarm("absorbed_thread_missing", {
          incidentId: absorbedId,
          into: result.target,
        });
      }

      await notify(
        into,
        [
          mrkdwn`*Incident ${absorbedId} is the same problem as this one, so the two have been merged*`,
          why,
          mrkdwn`_Nothing further will be posted in ${raw(absorbedRef)} · updates for both incidents arrive here from now on._`,
        ].join("\n"),
      );
    }
  };

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

  /** Correlation moves records nobody else has claimed, in either direction. */
  const mergeable = (row: Incident | undefined): boolean =>
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

    return {
      kind: "applied",
      result: assign(
        w,
        {
          signalIds: signals.map((s) => s.id),
          target: merge.into,
          reason: merge.reason,
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

      return {
        ok: true,
        data: {
          incidentId,
          status: "FIXING" as IncidentStatus,
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
   * could still take one. Refused at the tool, like the over-long
   * `contact_human` message: an agent that cannot say why the last resolution
   * failed has not finished, and leaving the incident open and escalated is
   * the correct place for a recurrence nobody can explain.
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

  // No budget on `postmortem`, deliberately, and this is the one transition
  // where that is true. It is not posted as thread text -- it becomes the
  // closing report, a Markdown file in the thread -- so the thread stays
  // short by the document being somewhere else rather than by the write-up
  // being shorter. The thread post below is the Boss's own one-liner.
  const reportAnalysis: ToolApi["reportAnalysis"] = (args) =>
    call("reportAnalysis", async (incidentId) => {
      const incident = readIncident(incidentId);
      if (!incident) return reject(`unknown incident: ${incidentId}`);

      const stop = blocked(incident, ["RESOLVED"], "reportAnalysis");
      if (stop) return reject(stop);

      const gap = recurrenceGap(incident, args.recurrence);
      if (gap) return reject(gap);

      const applied = await db.withWrite((w) => {
        const at = Date.now();
        const taken = w
          .prepare(
            // The status guard is what holds this transition, so a MERGED
            // row cannot be resurrected through here.
            `UPDATE incident SET status = 'CLOSED', closedAt = ?, postmortem = ?,
               usersImpacted = ?, impactQuery = ?, recurrenceAnalysis = ?
             WHERE id = ? AND status = 'RESOLVED'`,
          )
          .run(
            at,
            args.postmortem,
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

      await notify(
        incident,
        mrkdwn`*Incident ${incidentId} closed*\n_${args.usersImpacted} users impacted · post-mortem written._`,
      );

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
   * The half of the old `handOff` that was always the point. It says in the
   * thread that this incident needs a person and then changes nothing: the
   * agent is still driving, so there is no transition to lose a race on and
   * nothing to retract when the post fails.
   *
   * Rejected on a failed post, unlike every notification elsewhere in this
   * module. Everywhere else the state is already committed and the message is
   * commentary; here the message is the entire effect, so an escalation
   * nobody was told about has not happened and the agent has to know that.
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
      // phone, so it answers to the thread budget like every other post. The
      // harness writes briefs too and cannot be asked to shorten one, which
      // is why `unansweredBrief` clamps the question it echoes rather than
      // relying on this staying generous.
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

  const getIncident: ToolApi["getIncident"] = () =>
    call<IncidentView>("getIncident", async (incidentId) => {
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

  return {
    reportRootCause,
    setSummary,
    reportImpact,
    reportResolved,
    reportAnalysis,
    escalate,
    park,
    getIncident,
    searchIncidents: searchIncidentsTool,
  };
};
