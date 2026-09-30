/**
 * The Boss, as the resumed incident agent sees it, for a Tier 2 replay.
 *
 * After the Boss refactor the agent reaches people only through the Boss:
 * it sends inbox items up and receives `boss_message` directives back. So a
 * scripted on-call human is a list of steps this fake plays in answer to
 * what the agent sends. A step can also approve and merge the PR as a
 * person, through the GitHub stand-in, since merging is the human's job.
 *
 * Every transition the agent makes is recorded, because the gates and the
 * judge read them: the resolution evidence and when it came, and the
 * post-mortem.
 */

import type { BossClient } from "../../bugboss/agent/run";
import type { PendingDirective, PendingQuestion, PendingWait } from "../../bugboss/agent/tools";
import type { BossInboxKind, Directive, IncidentView, ToolResponse } from "../../bugboss/types";

export interface ScriptStep {
  /** Which inbox kind this step answers. "any" answers the next item of any kind. */
  on: BossInboxKind | "any";
  /** Approve the PR and merge it, as a person, before replying. */
  approveAndMerge?: boolean;
  /** What the Boss tells the agent. Omitted means the step replies nothing. */
  reply?: string;
}

export interface MergeOutcome {
  merged: boolean;
  sha: string | null;
  detail: string;
}

export interface InboxItem {
  kind: BossInboxKind;
  text: string;
  at: number;
}

export interface BossRecord {
  inbox: InboxItem[];
  replies: Array<{ text: string; at: number }>;
  merges: Array<MergeOutcome & { at: number }>;
  resolved: Array<{ prUrls: string[]; evidence: string; at: number }>;
  analysis: { postmortem: string; usersImpacted: number; impactQuery: string; at: number } | null;
  rootCauses: Array<{ cause: string; at: number }>;
  parks: Array<{ waitingFor: string; at: number }>;
  calls: Array<{ name: string; at: number }>;
}

export const createFakeBoss = (args: {
  view: IncidentView;
  script: ScriptStep[];
  /** Merges the PR as a person. Injected so tests never need a stand-in. */
  merge: () => Promise<MergeOutcome>;
  /** Seconds the agent was down, for the `resumed_after` it reads first. */
  resumedAfterSeconds?: number;
  now?: () => number;
}): { client: BossClient; record: () => BossRecord } => {
  const now = args.now ?? Date.now;
  const view: IncidentView = structuredClone(args.view);
  const steps = [...args.script];
  const record: BossRecord = {
    inbox: [],
    replies: [],
    merges: [],
    resolved: [],
    analysis: null,
    rootCauses: [],
    parks: [],
    calls: [],
  };
  let nextId = 1;
  const pending: PendingDirective[] = [];
  const enqueue = (directive: Directive) => pending.push({ id: nextId++, directive });
  enqueue({ type: "resumed_after", seconds: args.resumedAfterSeconds ?? 0 });

  let question: PendingQuestion | null = null;
  let wait: PendingWait | null = null;

  // Any ToolApi response carries and drains the pending directives, as the
  // real tool API does; only peekDirectives leaves them in place.
  const respond = <T>(name: string, data?: T, error?: string): Promise<ToolResponse<T>> => {
    record.calls.push({ name, at: now() });
    const directives = pending.splice(0).map((p) => p.directive);
    return Promise.resolve({ ok: !error, ...(data === undefined ? {} : { data }), ...(error ? { error } : {}), directives });
  };

  const answer = async (item: InboxItem) => {
    const index = steps.findIndex((step) => step.on === "any" || step.on === item.kind);
    if (index < 0) return;
    const [step] = steps.splice(index, 1);
    let reply = step.reply;
    // Once merged, a later merge step is only its reply: a person does not
    // merge the same PR twice.
    if (step.approveAndMerge && !record.merges.some((m) => m.merged)) {
      const outcome = await args.merge();
      record.merges.push({ ...outcome, at: now() });
      // A person whose merge was refused says so rather than pretending.
      if (!outcome.merged) reply = `I tried to merge it and GitHub refused: ${outcome.detail}`;
    }
    if (reply !== undefined) {
      record.replies.push({ text: reply, at: now() });
      enqueue({ type: "boss_message", text: reply, at: now() });
    }
  };

  const client: BossClient = {
    reportRootCause: (payload) => {
      record.rootCauses.push({ cause: payload.cause, at: now() });
      view.incident.rootCause = payload.cause;
      return respond("reportRootCause");
    },
    setSummary: (payload) => {
      view.incident.summary = payload.summary;
      return respond("setSummary");
    },
    reportImpact: (payload) => {
      view.incident.usersImpacted = payload.usersImpacted;
      view.incident.impactQuery = payload.query;
      return respond("reportImpact");
    },
    reportResolved: (payload) => {
      record.resolved.push({ prUrls: payload.prUrls, evidence: payload.evidence, at: now() });
      view.incident.status = "RESOLVED";
      view.incident.prUrls = payload.prUrls;
      return respond("reportResolved");
    },
    reportAnalysis: (payload) => {
      record.analysis = {
        postmortem: payload.postmortem,
        usersImpacted: payload.usersImpacted,
        impactQuery: payload.impactQuery,
        at: now(),
      };
      view.incident.status = "CLOSED";
      view.incident.postmortem = payload.postmortem;
      return respond("reportAnalysis");
    },
    park: (payload) => {
      record.parks.push({ waitingFor: payload.waitingFor, at: now() });
      return respond("park");
    },
    getIncident: (payload) =>
      payload?.incidentId && payload.incidentId !== view.incident.id
        ? respond<IncidentView>("getIncident", undefined, "other incidents are not part of this replay")
        : respond("getIncident", structuredClone(view)),
    proposeMerge: () =>
      respond("proposeMerge", {
        combined: false,
        incidentOfRecord: view.incident.id,
        detail: "No other incident exists in this replay.",
      }),
    searchIncidents: () => respond("searchIncidents", []),
    peekDirectives: async () => pending.map((p) => ({ ...p })),
    consumeDirective: async (id) => {
      const at = pending.findIndex((p) => p.id === id);
      if (at >= 0) pending.splice(at, 1);
    },
    getPending: async () => question,
    recordPending: async (message) => (question = { message, askedAt: now() }),
    clearPending: async () => {
      question = null;
    },
    recordWait: async (command) => {
      if (wait?.command !== command) wait = { command, startedAt: now(), pings: 0, lastPingAt: null };
      return wait;
    },
    recordPing: async () => {
      if (!wait) throw new Error("no pending wait to ping");
      wait = { ...wait, pings: wait.pings + 1, lastPingAt: now() };
      return wait;
    },
    clearWait: async () => {
      wait = null;
    },
    tellBoss: async (kind, text) => {
      const item = { kind, text, at: now() };
      record.inbox.push(item);
      await answer(item);
    },
    escalationsSince: async (since) => {
      const rows = record.inbox.filter((i) => i.kind === "escalation" && i.at >= since);
      return { count: rows.length, lastAt: rows.length ? rows[rows.length - 1].at : null };
    },
  };

  return { client, record: () => structuredClone(record) };
};
