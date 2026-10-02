// The Boss's write tools. Each one is a request from the model and a
// decision made here: the model names the incident and supplies the evidence,
// and the guards, the transition and the notification are this code's.

import type Database from "better-sqlite3";

import type { Db } from "../db";
import type { IncidentStatus } from "../types";
import type { SlackAgentTool } from "../slack/agent";
import { mentionPrefix } from "../slack/relay";
import { THREAD_PROSE_CHARS, mrkdwn, overThreadBudget, raw, toMrkdwn } from "../slack/format";
import {
  AssignError,
  assign,
  createAnnouncer,
  establishedOf,
  getIncidentRow,
  getSignalsFor,
  logAssign,
  notifyAgents,
  rowToIncident,
  type AgentNotifier,
  type AnnouncePoster,
  type AssignResult,
  type IncidentRow,
} from "../toolapi";
import { BOSS_SAYS } from "../agent/tools";
import { makeAlarm, makeLog } from "../logging";

const log = makeLog("boss");
const alarm = makeAlarm("boss");

/**
 * Closing lives in the tool API, beside the agent's own close, so the row and
 * the thread read the same whichever of the two closed it. This module only
 * asks for it.
 */
export type CloseIncident = (args: {
  incidentId: string;
  reason: string;
}) => Promise<{ ok: true; from: IncidentStatus } | { ok: false; error: string }>;

/**
 * How the Boss reaches an incident's agent: its conversation in the harness,
 * found through `incident.conversationId`. Behind an interface so the tools
 * here stay plain code over a seam a test can fake.
 */
export interface AgentLine {
  /**
   * Put `text` in front of the agent, as it is. A running agent reads it at
   * its next tool boundary, which also ends a wait it is blocked in; an idle
   * one finds it in its transcript when the dispatcher next launches it. False when the
   * incident has no conversation yet. `requestId` makes a retry deliver once.
   */
  tell(incidentId: string, text: string, requestId: string | undefined): Promise<boolean>;
  /**
   * Abort the run in flight and start the agent's next context from `reason`.
   * False when there is no conversation to stop.
   */
  stop(incidentId: string, reason: string): Promise<boolean>;
}

export interface BossCommandDeps {
  db: Db;
  agents: AgentLine;
  /** What a merge owes the agents it moved work between, delivered once it commits. */
  notifier: AgentNotifier;
  /** Posts and links in the incident channel, where every incident thread is. */
  threads: AnnouncePoster;
  closeIncident: CloseIncident;
  /** Rendered as <!subteam^ID> by `page_rotation`. Null falls back to <!here>. */
  rotationGroupId: string | null;
}

/** Where an agent is still working, so there is something to talk to or stop. */
const AGENT_STATUSES: readonly IncidentStatus[] = ["INVESTIGATING", "FIXING", "RESOLVED"];

/** The statuses an incident can still take signals in. Mirrors assign. */
const COMBINABLE: readonly IncidentStatus[] = ["INVESTIGATING", "FIXING"];

/**
 * A reason is what the thread and the record keep of why a person's system
 * changed state without a person doing it. One word is a verdict, not
 * evidence, and a verdict nobody can check is what the prompt forbids.
 */
const MIN_REASON_CHARS = 40;

const shortReason = (tool: string, reason: string): string | null =>
  reason.trim().length < MIN_REASON_CHARS
    ? `${tool} needs a reason that is evidence: what you observed and where you read it (a query result, the agent's session, a message in the thread), in at least ${MIN_REASON_CHARS} characters. Nothing was changed.`
    : null;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

export const buildCommandTools = (deps: BossCommandDeps): SlackAgentTool[] => {
  const { db, closeIncident } = deps;
  const announce = createAnnouncer({ db, slack: deps.threads });

  const readRow = (id: string): IncidentRow | undefined =>
    db.get<IncidentRow>("SELECT * FROM incident WHERE id = ?", [id]);

  return [
    {
      name: "message_agent",
      description:
        "Send a message to an incident's agent. This is the only way anything reaches an agent: when it is blocked on a question, your message is the answer and ends its wait, and when it is parked waiting on a person, your message is what wakes it. Write it the way you would brief an engineer who cannot see Slack: what a person said or what you found, and what to do with it.",
      inputSchema: {
        type: "object",
        properties: {
          incidentId: { type: "string", description: "The incident whose agent this is for." },
          text: { type: "string", description: "What the agent should read." },
        },
        required: ["incidentId", "text"],
        additionalProperties: false,
      },
      run: async (input, call) => {
        const incidentId = str(input.incidentId);
        const text = str(input.text).trim();
        if (!text) return "Rejected: the message is empty, so nothing was sent.";
        const row = readRow(incidentId);
        if (!row) return `Rejected: there is no incident ${incidentId}.`;
        if (!AGENT_STATUSES.includes(row.status)) {
          return `Rejected: incident ${incidentId} is ${row.status}, so no agent is working it to read this.`;
        }
        // Keyed by the tool call's own task, so a rerun after a restart finds
        // the message it already sent rather than sending it twice.
        let told: boolean;
        try {
          told = await deps.agents.tell(incidentId, `${BOSS_SAYS}${text}`, call ? `boss:${call.taskId}` : undefined);
        } catch (err) {
          alarm("agent_message_failed", { incidentId, error: String(err) });
          return "Failed: the message did not reach the agent. The error is in the BugBoss logs; it is worth calling again.";
        }
        if (!told) {
          return `Not sent: incident ${incidentId}'s agent has not started its first run, so there is nothing to deliver it to yet. Try again once it has.`;
        }
        // The Boss is the only thing a person's word reaches an agent through,
        // so its message is what wakes a parked incident. A spent turn budget
        // is the one wait it does not lift: that takes grant_turns.
        await db.withWrite((w: Database.Database) => {
          w.prepare("DELETE FROM incident_wait WHERE incidentId = ? AND liftsOnReply = 1").run(incidentId);
        });
        log("agent_messaged", { incidentId, chars: text.length });
        return `Sent to incident ${incidentId}'s agent. It reads it at its next tool call, which also ends a wait it is blocked in, and if it is parked waiting on a person this wakes it.`;
      },
    },
    {
      name: "close_incident",
      description:
        `Close an incident from any open status. Only on evidence you can cite: an incident nobody needs to work any more, confirmed by what you read, not by what somebody guessed. The reason is kept permanently as the closing record and posted in the thread, so write what was observed and where: at least ${MIN_REASON_CHARS} characters and at most ${THREAD_PROSE_CHARS}, about 200 words. Closing stops the agent. Merging is a different tool.`,
      inputSchema: {
        type: "object",
        properties: {
          incidentId: { type: "string", description: "The incident to close." },
          reason: {
            type: "string",
            description:
              "The evidence it can close on: what you observed, where you read it, and who asked if somebody did.",
          },
        },
        required: ["incidentId", "reason"],
        additionalProperties: false,
      },
      run: async (input) => {
        const incidentId = str(input.incidentId);
        const reason = str(input.reason).trim();
        const short = shortReason("close_incident", reason);
        if (short) return `Rejected: ${short}`;
        const long = overThreadBudget("reason", reason);
        if (long) return `Rejected: ${long} Nothing was changed.`;
        const result = await closeIncident({ incidentId, reason });
        if (!result.ok) return `Rejected: ${result.error}`;
        log("incident_closed", { incidentId, from: result.from });
        return `Incident ${incidentId} is closed (it was ${result.from}). The thread has been told; do not announce it again.`;
      },
    },
    {
      name: "merge_incidents",
      description:
        "Combine two incidents that are the same problem. The older incident always survives, whichever way round you name them, and both threads are told. Only on evidence you can cite that they share a cause; two alerts that fired together is not that. Both must still be INVESTIGATING or FIXING.",
      inputSchema: {
        type: "object",
        properties: {
          fromIncidentId: { type: "string", description: "One of the two incidents." },
          intoIncidentId: { type: "string", description: "The other one." },
          reason: {
            type: "string",
            description:
              "Why they are the same problem, from what you read. Both threads and the surviving agent read it.",
          },
        },
        required: ["fromIncidentId", "intoIncidentId", "reason"],
        additionalProperties: false,
      },
      run: async (input) => {
        const from = str(input.fromIncidentId);
        const to = str(input.intoIncidentId);
        const reason = str(input.reason).trim();
        const short = shortReason("merge_incidents", reason);
        if (short) return `Rejected: ${short}`;
        if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) {
          return `Rejected: incident ids are numbers, and "${from}" and "${to}" are not both one.`;
        }
        if (from === to) return "Rejected: that is one incident, not two.";

        const into = establishedOf(from, to);
        const absorb = into === from ? to : from;

        // Statuses and signals are read inside the write: a correlation
        // merge landing between a read and this assign would otherwise have
        // its signals dragged back out.
        let outcome:
          | { kind: "refused"; why: string }
          | { kind: "assigned"; result: AssignResult };
        try {
          outcome = await db.withWrite((w: Database.Database) => {
            for (const id of [into, absorb]) {
              const row = getIncidentRow(w, id);
              if (!row) return { kind: "refused" as const, why: `there is no incident ${id}` };
              if (!COMBINABLE.includes(row.status)) {
                return {
                  kind: "refused" as const,
                  why: `incident ${id} is ${row.status} and is not taking signals, so these cannot be combined`,
                };
              }
            }
            const signalIds = getSignalsFor(w, absorb).map((signal) => signal.id);
            if (signalIds.length === 0) {
              return {
                kind: "refused" as const,
                why: `incident ${absorb} has no signals left to move, so there is nothing to combine`,
              };
            }
            return {
              kind: "assigned" as const,
              result: assign(w, { signalIds, target: into, reason }, { kind: "boss" }),
            };
          });
        } catch (err) {
          if (err instanceof AssignError) return `Rejected: ${err.message}.`;
          alarm("merge_failed", { from, to, error: String(err) });
          return "The merge failed to write and nothing moved. The error is in the BugBoss logs.";
        }
        if (outcome.kind === "refused") return `Rejected: ${outcome.why}.`;
        logAssign(outcome.result);
        notifyAgents(deps.notifier, outcome.result.notices);
        await announce.announceMerge(outcome.result);
        return `Incident ${absorb} is now part of incident ${into}${into === to ? "" : ", which is the older record and so survives"}. Both threads have been told; do not announce it again.`;
      },
    },
    {
      name: "stop_agent",
      description:
        "Stop the run an incident's agent is in the middle of, at once. The incident stays open and the dispatcher starts a fresh run on its next tick, which re-reads everything, so this is for an agent heading somewhere wrong, not for ending an incident -- that is close_incident. Its next run starts from your reason, so say in it what to do differently.",
      inputSchema: {
        type: "object",
        properties: {
          incidentId: { type: "string", description: "The incident whose agent to stop." },
          reason: { type: "string", description: "Why, as evidence. The agent reads it." },
        },
        required: ["incidentId", "reason"],
        additionalProperties: false,
      },
      run: async (input) => {
        const incidentId = str(input.incidentId);
        const reason = str(input.reason).trim();
        const short = shortReason("stop_agent", reason);
        if (short) return `Rejected: ${short}`;
        const row = readRow(incidentId);
        if (!row) return `Rejected: there is no incident ${incidentId}.`;
        if (!AGENT_STATUSES.includes(row.status)) {
          return `Rejected: incident ${incidentId} is ${row.status}, so no agent is running on it.`;
        }
        let stopped: boolean;
        try {
          stopped = await deps.agents.stop(incidentId, reason);
        } catch (err) {
          alarm("agent_stop_failed", { incidentId, error: String(err) });
          return "Failed: the agent could not be stopped. The error is in the BugBoss logs.";
        }
        if (!stopped) return `Rejected: incident ${incidentId}'s agent has not started a run, so there is nothing to stop.`;
        log("agent_stopped", { incidentId });
        return `Incident ${incidentId}'s agent has stopped. Its next run starts on the dispatcher's next tick, from your reason.`;
      },
    },
    {
      name: "page_rotation",
      description:
        "Page the on-call rotation in an incident's thread. The only way to reach them: a mention you type yourself posts as literal text. For something a person has to act on now -- an agent escalated, or is blocked on a question you cannot answer from what you can read. Say what is needed from them and why it cannot wait.",
      inputSchema: {
        type: "object",
        properties: {
          incidentId: { type: "string", description: "The incident whose thread to page in." },
          reason: {
            type: "string",
            description: "What the rotation needs to do, in plain terms, about 200 words at most.",
          },
        },
        required: ["incidentId", "reason"],
        additionalProperties: false,
      },
      run: async (input) => {
        const incidentId = str(input.incidentId);
        const reason = str(input.reason).trim();
        if (!reason) return "Rejected: say what the rotation needs to do. Nobody was paged.";
        const long = overThreadBudget("reason", reason);
        if (long) return `Rejected: ${long} Nobody was paged.`;
        const row = readRow(incidentId);
        if (!row) return `Rejected: there is no incident ${incidentId}.`;
        const incident = rowToIncident(row);
        if (!incident.slackThreadTs) {
          alarm("page_without_thread", { incidentId });
          return `Rejected: incident ${incidentId} has no thread to page in. Nobody was paged.`;
        }
        const posted = await announce.notify(
          incident,
          mrkdwn`${raw(mentionPrefix(deps.rotationGroupId))}*Incident ${incidentId} needs a person*\n\n${raw(toMrkdwn(reason))}`,
        );
        if (!posted) {
          return "The page did not post, so nobody has been told. It is worth calling again.";
        }
        log("rotation_paged", { incidentId });
        return `The rotation has been paged in incident ${incidentId}'s thread. Do not repeat or summarise it: if the page is the whole answer, call stay_silent.`;
      },
    },
  ];
};

/** The most one grant_turns call can add. */
export const MAX_GRANT_TURNS = 200;

/** The `incident_action` a grant writes. */
export const TURNS_GRANTED_ACTION = "turns_granted";

/**
 * Its own export rather than one more entry in `buildCommandTools`, because
 * it is appended after `gh` in the Boss's tool list: the tools array is part
 * of the cached prefix, and an entry in the middle would move every one
 * after it.
 *
 * The grant only writes. The dispatcher reads it on its next tick, lifts a
 * spent-budget wait the new total covers, and posts the thread notice after
 * the lift commits, so a notice never claims a resume that did not happen.
 */
export const buildGrantTurnsTool = (db: Db): SlackAgentTool => ({
  name: "grant_turns",
  description:
    `Give an incident's agent more turns, on top of its configured budget, when a person asks or you can cite the evidence that the work is worth it. An agent parked because its turn budget is spent resumes on the dispatcher's next tick, and the thread is told; tell the agent what to do with message_agent as well. Between 1 and ${MAX_GRANT_TURNS} turns per call. A run already in progress keeps the budget it launched with; the grant counts from its next launch.`,
  inputSchema: {
    type: "object",
    properties: {
      incidentId: { type: "string", description: "The incident whose agent gets the turns." },
      turns: { type: "integer", description: `How many turns to add, 1 to ${MAX_GRANT_TURNS}.` },
      reason: {
        type: "string",
        description: "Who asked, or the evidence the work needs the turns. Kept as the record.",
      },
    },
    required: ["incidentId", "turns", "reason"],
    additionalProperties: false,
  },
  run: async (input) => {
    const incidentId = str(input.incidentId);
    const turns = input.turns;
    if (typeof turns !== "number" || !Number.isInteger(turns) || turns < 1 || turns > MAX_GRANT_TURNS) {
      return `Rejected: turns must be a whole number from 1 to ${MAX_GRANT_TURNS}. Nothing was granted.`;
    }
    const reason = str(input.reason).trim();
    const short = shortReason("grant_turns", reason);
    if (short) return `Rejected: ${short}`;
    const outcome = await db.withWrite((w: Database.Database) => {
      const row = getIncidentRow(w, incidentId);
      if (!row) return { granted: false as const, why: `there is no incident ${incidentId}` };
      if (!AGENT_STATUSES.includes(row.status)) {
        return {
          granted: false as const,
          why: `incident ${incidentId} is ${row.status}, so no agent is working it to use the turns`,
        };
      }
      w.prepare("UPDATE incident SET grantedTurns = grantedTurns + ? WHERE id = ?").run(turns, incidentId);
      w.prepare(
        `INSERT INTO incident_action (incidentId, actorKind, actorId, action, reason, at)
         VALUES (?, 'boss', NULL, ?, ?, ?)`,
      ).run(incidentId, TURNS_GRANTED_ACTION, `${turns} turns: ${reason}`, Date.now());
      const total = w
        .prepare("SELECT grantedTurns FROM incident WHERE id = ?")
        .get(incidentId) as { grantedTurns: number };
      return { granted: true as const, total: total.grantedTurns };
    });
    if (!outcome.granted) return `Rejected: ${outcome.why}.`;
    log("turns_granted", { incidentId, turns, total: outcome.total });
    return `Granted ${turns} turns to incident ${incidentId} (${outcome.total} granted in total, on top of the configured budget). If its agent is parked on a spent budget and the new total covers the turns it has used, it resumes on the next tick and the dispatcher tells the thread. If it has used more than the new total, it stays parked and nothing is posted, so a grant that does not resume it needs to be larger. If there is work for it, send it with message_agent.`;
  },
});
