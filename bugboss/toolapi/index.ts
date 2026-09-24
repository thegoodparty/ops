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

  const notify = async (incident: Incident, text: string): Promise<void> => {
    try {
      await slack.post(incident.slackThreadTs, text);
    } catch (err) {
      log("thread_post_failed", { incidentId: incident.id, error: String(err) });
    }
  };

  const reject = (error: string): Body<never> => ({ ok: false, error });

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

  /**
   * Invariant 2. A signal with no closedAt is still firing, which is a
   * deterministic fact about ingest rather than a judgement, so no model is
   * involved. Each one leaves for an incident of its own carrying
   * recurrenceOf, which is exactly what that field is for: this reopens
   * ground a resolution claimed.
   */
  const splitFiringSignals = (
    w: Database.Database,
    incidentId: string,
  ): AssignResult[] =>
    getSignalsFor(w, incidentId)
      .filter((s) => s.closedAt === null)
      .map((s) =>
        assign(
          w,
          {
            signalIds: [s.id],
            target: "NEW",
            reason: `still firing when incident ${incidentId} claimed resolution: ${s.title}`,
          },
          { kind: "agent", incidentId },
          { recurrenceOf: incidentId },
        ),
      );

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
        w.prepare(
          `UPDATE incident SET status = 'FIXING', rootCause = ?, fixingAt = ?,
             usersImpacted = COALESCE(?, usersImpacted),
             impactQuery = COALESCE(?, impactQuery)
           WHERE id = ?`,
        ).run(
          args.cause,
          Date.now(),
          args.usersImpacted ?? null,
          args.impactQuery ?? null,
          incidentId,
        );

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

      await db.withWrite((w) => {
        w.prepare(
          "UPDATE incident SET usersImpacted = ?, impactQuery = ? WHERE id = ?",
        ).run(args.usersImpacted, args.query, incidentId);
      });

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

      const splits = await db.withWrite((w) => {
        const out = splitFiringSignals(w, incidentId);
        w.prepare(
          "UPDATE incident SET status = 'RESOLVED', resolvedAt = ?, prUrls = ? WHERE id = ?",
        ).run(Date.now(), JSON.stringify(args.prUrls), incidentId);
        return out;
      });
      splits.forEach(logAssign);

      await notify(
        incident,
        `Incident ${incidentId} resolved. ${args.evidence}${args.prUrls.length ? ` PRs: ${args.prUrls.join(", ")}` : ""}`,
      );
      if (splits.length > 0) {
        await notify(
          incident,
          `${splits.length} signal(s) were still firing and did not resolve with ${incidentId}. Now incident(s) ${splits.map((s) => s.target).join(", ")}, recorded as a recurrence.`,
        );
      }

      return {
        ok: true,
        data: {
          incidentId,
          status: "RESOLVED" as IncidentStatus,
          stillFiring: splits.map((s) => s.target),
        },
      };
    });

  const reportAnalysis: ToolApi["reportAnalysis"] = (args) =>
    call("reportAnalysis", async (incidentId) => {
      const incident = readIncident(incidentId);
      if (!incident) return reject(`unknown incident: ${incidentId}`);

      const stop = blocked(incident, ["RESOLVED"], "reportAnalysis");
      if (stop) return reject(stop);

      const splits = await db.withWrite((w) => {
        const out = splitFiringSignals(w, incidentId);
        w.prepare(
          `UPDATE incident SET status = 'CLOSED', closedAt = ?, postmortem = ?,
             usersImpacted = ?, impactQuery = ?
           WHERE id = ?`,
        ).run(
          Date.now(),
          args.postmortem,
          args.usersImpacted,
          args.impactQuery,
          incidentId,
        );
        return out;
      });
      splits.forEach(logAssign);

      await notify(
        incident,
        `Incident ${incidentId} closed. ${args.usersImpacted} users impacted. Post-mortem written.`,
      );

      return {
        ok: true,
        data: {
          incidentId,
          status: "CLOSED" as IncidentStatus,
          stillFiring: splits.map((s) => s.target),
        },
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

      // Not guarded on owner. A human claiming the incident in Slack flips
      // owner first, and the agent's last act is still to write the brief.
      await db.withWrite((w) => {
        w.prepare("UPDATE incident SET owner = 'human' WHERE id = ?").run(
          incidentId,
        );
      });

      await notify(
        incident,
        `Incident ${incidentId} handed to a human: ${args.reason}\n\n${args.brief}`,
      );

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
