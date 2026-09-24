// Job 4: serve the agent tool API. Design spec: docs/bugboss/design.md.
//
// The agent's only path to state. Six methods, four of which are state
// transitions, and every response carries the directives the agent has not
// picked up yet. That array is the whole coordination mechanism: there is no
// push channel and an agent never has to be addressable, so it learns that a
// human took over or that its incident was merged away as a side effect of a
// call it was already making.
//
// This is the single writer for incident state, so the two invariants are
// enforced here rather than anywhere they could be bypassed:
//
//   1. Every attached signal must be explained. On entering FIXING, anything
//      the root cause does not account for is split back out.
//   2. An incident cannot close over a firing signal. Deterministic, no model
//      involved, and it splits rather than refusing.

import type Database from "better-sqlite3";

import type { Db } from "../db";
import type {
  Directive,
  Evidence,
  Incident,
  IncidentStatus,
  IncidentView,
  Signal,
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

export * from "./assign";
export * from "./token";

const log = (event: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ component: "toolapi", event, ...data }));

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
      return { ...body, directives: await drain(incidentId) };
    } catch (err) {
      log("failed", { tool, incidentId, error: String(err) });
      return {
        ok: false,
        error: (err as Error).message,
        directives: await drain(incidentId),
      };
    }
  };

  const notify = async (incident: Incident, text: string): Promise<boolean> => {
    try {
      await slack.post(incident.slackThreadTs, text);
      return true;
    } catch (err) {
      log("thread_post_failed", { incidentId: incident.id, error: String(err) });
      return false;
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
    if (incident.owner === "human") {
      return `incident ${incident.id} is owned by a human; only handOff and getIncident remain`;
    }
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
        ? `${tool} lost a race on incident ${incidentId}: it is ${now.status}, owned by ${now.owner === "human" ? "a human" : "an agent"}, and the transition did not apply`
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

  const applyMerge = (
    w: Database.Database,
    merge: CorrelationMerge,
  ): AssignResult | null => {
    if (merge.absorb === merge.into) return null;
    const absorb = getIncidentRow(w, merge.absorb);
    if (!absorb) return null;
    if (absorb.status !== "INVESTIGATING" && absorb.status !== "FIXING") {
      return null;
    }
    // Skipped rather than thrown: assign refuses a target that is not open,
    // and a stale merge proposal must not fail the root cause that ran it.
    const into = getIncidentRow(w, merge.into);
    if (!into || (into.status !== "INVESTIGATING" && into.status !== "FIXING")) {
      return null;
    }
    const signals = getSignalsFor(w, merge.absorb);
    if (signals.length === 0) return null;
    return assign(
      w,
      {
        signalIds: signals.map((s) => s.id),
        target: merge.into,
        reason: merge.reason,
      },
      { kind: "boss" },
    );
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
               impactQuery = COALESCE(?, impactQuery)
             WHERE id = ? AND status = 'INVESTIGATING' AND owner = 'agent'`,
          )
          .run(
            args.cause,
            Date.now(),
            args.usersImpacted ?? null,
            args.impactQuery ?? null,
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

      if (splits.length > 0) {
        await notify(
          incident,
          `Root cause on ${incidentId} does not explain ${splits.length} attached signal(s). Split out as incident(s) ${splits.map((s) => s.target).join(", ")}.`,
        );
      }

      // Correlation runs after the transition is durable. It is the Boss's
      // job and a failure in it must not cost the agent its root cause.
      let merges: CorrelationMerge[] = [];
      try {
        merges = await correlator.correlate({
          incidentId,
          rootCause: args.cause,
        });
      } catch (err) {
        log("correlation_failed", { incidentId, error: String(err) });
      }

      const applied = merges.length
        ? await db.withWrite((w) =>
            merges
              .map((m) => applyMerge(w, m))
              .filter((r): r is AssignResult => r !== null),
          )
        : [];
      applied.forEach(logAssign);

      for (const merge of applied) {
        await notify(
          incident,
          `Merged incident(s) ${merge.merged.join(", ")} into ${merge.target}: ${merge.reason}`,
        );
      }

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
               WHERE id = ? AND status IN ('INVESTIGATING','FIXING','RESOLVED')
                 AND owner = 'agent'`,
            )
            .run(args.usersImpacted, args.query, incidentId).changes,
      );
      if (applied === 0) return raced(incidentId, "reportImpact");

      // A human deciding whether to step in needs the current number, so a
      // change goes to the thread. An unchanged number is not news.
      if (incident.usersImpacted !== args.usersImpacted) {
        await notify(
          incident,
          `Impact on ${incidentId}: ${args.usersImpacted} users (was ${incident.usersImpacted ?? "unknown"}).`,
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

      const applied = await db.withWrite((w) => {
        const at = Date.now();
        const taken = w
          .prepare(
            `UPDATE incident SET status = 'RESOLVED', resolvedAt = ?, prUrls = ?,
               resolvedEvidence = ?
             WHERE id = ? AND status = 'FIXING' AND owner = 'agent'`,
          )
          .run(at, JSON.stringify(args.prUrls), args.evidence, incidentId).changes;
        if (taken === 0) return false;
        closeOpenSignals(w, incidentId, at);
        return true;
      });
      if (!applied) return raced(incidentId, "reportResolved");

      await notify(
        incident,
        `Incident ${incidentId} resolved. ${args.evidence}${args.prUrls.length ? ` PRs: ${args.prUrls.join(", ")}` : ""}`,
      );
      return {
        ok: true,
        data: { incidentId, status: "RESOLVED" as IncidentStatus },
      };
    });

  const reportAnalysis: ToolApi["reportAnalysis"] = (args) =>
    call("reportAnalysis", async (incidentId) => {
      const incident = readIncident(incidentId);
      if (!incident) return reject(`unknown incident: ${incidentId}`);

      const stop = blocked(incident, ["RESOLVED"], "reportAnalysis");
      if (stop) return reject(stop);

      const applied = await db.withWrite((w) => {
        const at = Date.now();
        const taken = w
          .prepare(
            `UPDATE incident SET status = 'CLOSED', closedAt = ?, postmortem = ?,
               usersImpacted = ?, impactQuery = ?
             WHERE id = ? AND status = 'RESOLVED' AND owner = 'agent'`,
          )
          .run(
            at,
            args.postmortem,
            args.usersImpacted,
            args.impactQuery,
            incidentId,
          ).changes;
        if (taken === 0) return false;
        closeOpenSignals(w, incidentId, at);
        return true;
      });
      if (!applied) return raced(incidentId, "reportAnalysis");

      await notify(
        incident,
        `Incident ${incidentId} closed. ${args.usersImpacted} users impacted. Post-mortem written.`,
      );

      return {
        ok: true,
        data: { incidentId, status: "CLOSED" as IncidentStatus },
      };
    });

  const handOff: ToolApi["handOff"] = (args) =>
    call("handOff", async (incidentId) => {
      const incident = readIncident(incidentId);
      if (!incident) return reject(`unknown incident: ${incidentId}`);

      if (incident.status === "CLOSED" || incident.status === "MERGED") {
        return reject(
          `incident ${incidentId} is ${incident.status}; there is nothing to hand off`,
        );
      }

      // The post comes first because it is the part that cannot be retried
      // from anywhere else. Once owner is 'human' the dispatcher stops
      // relaunching, so committing without the brief leaves an escalation
      // nobody was told about and nothing to pick it back up.
      const posted = await notify(
        incident,
        `Incident ${incidentId} handed to a human: ${args.reason}\n\n${args.brief}`,
      );
      if (!posted) {
        return reject(
          `could not post the hand-off brief for incident ${incidentId}; it stays owned by the agent so the hand off can be retried`,
        );
      }

      // Not guarded on owner. A human claiming the incident in Slack flips
      // owner first, and the agent's last act is still to write the brief.
      await db.withWrite((w) => {
        w.prepare("UPDATE incident SET owner = 'human' WHERE id = ?").run(
          incidentId,
        );
      });

      return { ok: true, data: { incidentId, owner: "human" as const } };
    });

  const getIncident: ToolApi["getIncident"] = () =>
    call<IncidentView>("getIncident", async (incidentId) => {
      const incident = readIncident(incidentId);
      if (!incident) return reject(`unknown incident: ${incidentId}`);

      let loaded: Evidence[] = [];
      try {
        loaded = await evidence.load(incidentId);
      } catch (err) {
        log("evidence_load_failed", { incidentId, error: String(err) });
      }

      return {
        ok: true,
        data: {
          incident,
          signals: readSignals(incidentId),
          evidence: loaded,
        },
      };
    });

  return {
    reportRootCause,
    reportImpact,
    reportResolved,
    reportAnalysis,
    handOff,
    getIncident,
  };
};
