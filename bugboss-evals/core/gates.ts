import type { ScenarioGate } from "./scenario";
import type { Trace } from "./trace";

/**
 * A scenario's own gates, over what one run left behind. Pure: the harness
 * collects the record, this only reads it.
 */

export interface SlackPost {
  /** Epoch ms. */
  at: number;
  ts: string;
  threadTs: string | null;
  text: string;
  bot: boolean;
  /** The post, then every chat.update of it, in order. */
  history: { at: number; text: string }[];
}

export interface RunRecord {
  /** The first merge of the run's pull request, epoch ms. */
  mergedAt: number | null;
  /** Every status the incident was seen in, in order, epoch ms. */
  statuses: { at: number; status: string }[];
  rootCause: string | null;
  firstPrFiles: string[] | null;
  slack: SlackPost[];
  traces: Trace[];
}

const EDIT_TOOLS = new Set(["edit", "write"]);
const BOSS_TOOLS = new Set(["message_boss", "escalate"]);

const re = (pattern: string) => new RegExp(pattern, "i");

const calls = (traces: Trace[]) =>
  traces
    .flatMap((t) => t.turns.flatMap((turn) => turn.toolCalls.map((call) => ({ at: turn.startedAt, name: call.name, text: JSON.stringify(call.args) }))))
    .sort((a, b) => a.at - b.at);

/** The incident thread's top message: the first top-level bot post. */
const header = (slack: SlackPost[]) => slack.find((m) => m.bot && m.threadTs === null) ?? null;

const within = (at: number, from: number | null, seconds: number) => from !== null && at >= from && at <= from + seconds * 1000;

export const firstSentence = (text: string): string => text.trim().split(/(?<=[.!?])\s+/)[0] ?? "";

const passes = (gate: ScenarioGate, record: RunRecord): boolean => {
  switch (gate.kind) {
    case "thread_after_merge": {
      const root = header(record.slack);
      return record.slack.some(
        (m) => m.bot && root !== null && m.threadTs === root.ts && within(m.at, record.mergedAt, gate.withinSeconds) && re(gate.pattern).test(m.text),
      );
    }
    case "header_clears_after_merge": {
      const root = header(record.slack);
      if (!root || record.mergedAt === null) return false;
      const deadline = record.mergedAt + gate.withinSeconds * 1000;
      const shown = [...root.history].reverse().find((v) => v.at <= deadline)?.text ?? root.text;
      return !re(gate.pattern).test(shown);
    }
    case "status_after_merge":
      return record.statuses.some((s) => gate.statuses.includes(s.status) && within(s.at, record.mergedAt, gate.withinSeconds));
    case "turn_after_merge":
      return record.traces.some((t) => t.turns.some((turn) => within(turn.startedAt, record.mergedAt, gate.withinSeconds)));
    case "before_first_edit": {
      const all = calls(record.traces);
      const firstEdit = all.find((c) => EDIT_TOOLS.has(c.name))?.at ?? Infinity;
      return all.some((c) => c.at < firstEdit && gate.tools.includes(c.name) && re(gate.pattern).test(c.text));
    }
    case "root_cause":
      return (
        record.rootCause !== null &&
        re(gate.pattern).test(firstSentence(record.rootCause)) &&
        !(gate.notPattern && re(gate.notPattern).test(firstSentence(record.rootCause)))
      );
    case "first_pr_touches":
      return (record.firstPrFiles ?? []).some((f) => re(gate.pattern).test(f));
    case "agent_says":
      return calls(record.traces).some((c) => gate.tools.includes(c.name) && re(gate.pattern).test(c.text));
    case "never_says":
      return (
        !record.slack.some((m) => m.bot && m.history.map((v) => v.text).some((t) => re(gate.pattern).test(t))) &&
        !calls(record.traces).some((c) => BOSS_TOOLS.has(c.name) && re(gate.pattern).test(c.text))
      );
  }
};

export const scenarioGates = (gates: ScenarioGate[], record: RunRecord): Record<string, boolean> =>
  Object.fromEntries(gates.map((gate) => [gate.id, passes(gate, record)]));
