// The on-call person. It watches the incident channel, and when BugBoss says
// something new it waits the scenario's reply delay, reads the channel the
// way a person catching up would, and decides what to do: answer, review,
// merge, or nothing. It talks to BugBoss only by writing in the thread, in
// its own words. There is no phrase it has to hit, because the Boss reads
// language, and a persona coached into keywords would test a parser BugBoss
// does not have.

import { ratesFor } from "../../core/price";
import type { SlackSnapshot, StoredMessage, StoredFile } from "../standins/slack/state";
import type { PersonaGitHub } from "./github";
import type { PersonaMessage, PersonaModel, Usage } from "./model";
import { PERSONA_TOOLS, runPersonaTool, type SlackControl } from "./tools";

export interface PersonaConfig {
  /** The scenario's persona.md: who this person is and how they behave. */
  brief: string;
  model: PersonaModel;
  slack: SlackControl;
  github: PersonaGitHub;
  channel: string;
  userId: string;
  botUserId: string;
  replyDelaySeconds: [number, number];
  mergeDelaySeconds: number;
  seed: number;
  /** Model calls one turn may make before it is ended. */
  maxRoundsPerTurn?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called after every turn with the running stats. */
  onStats?: (stats: PersonaStats) => void;
}

export interface PersonaStats {
  model: string;
  turns: number;
  calls: number;
  usage: Usage;
  /** Null when the price table has no row for this model. */
  costUsd: number | null;
  actions: { at: number; action: string }[];
  errors: { at: number; error: string }[];
}

// mulberry32: small, seeded, and the same on every machine, so two sides of a
// pair wait the same delays.
const seeded = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const allMessages = (snapshot: SlackSnapshot): StoredMessage[] =>
  snapshot.threads.flatMap((t) => t.messages);

export const systemPrompt = (config: PersonaConfig): string =>
  [
    "You are playing a person: the engineer on call at GoodParty.org while an incident is being worked. Stay in character the whole time.",
    "",
    "Who you are:",
    config.brief.trim(),
    "",
    "How your team works:",
    `- BugBoss (<@${config.botUserId}>) is the team's incident bot. Every incident gets a thread in the incident channel. BugBoss runs agents that investigate and fix the problem, and it is the only thing you talk to about an incident.`,
    "- You talk to BugBoss in the incident's thread, in plain English, the way you would write to a colleague. There are no commands and no keywords. It reads what you write and passes on to its agents whatever matters.",
    "- When you are asked for something, answer it. When you know something useful, say it. When you disagree, say so and why.",
    "- Pull requests are reviewed and merged by people, not by the bot. When a pull request is waiting on you, read it and its diff, review it as a careful engineer would, and approve it or ask for changes with a reason. You can only merge a pull request with green CI and your approval on its latest commit.",
    "- Never claim to have done something you did not do with a tool.",
    "- Keep Slack messages short, like real ones.",
    "- If nothing needs you right now, do nothing: end your turn without calling a tool.",
  ].join("\n");

export const renderChannel = (
  snapshot: SlackSnapshot,
  config: Pick<PersonaConfig, "channel" | "userId" | "botUserId">,
  fresh: Set<string>,
): string => {
  const who = (user: string) =>
    user === config.botUserId ? "BugBoss" : user === config.userId ? "you" : `<@${user}>`;
  const fileById = new Map<string, StoredFile>(snapshot.files.map((f) => [f.id, f]));
  const renderMessage = (m: StoredMessage) => {
    const lines = [`[${m.ts}]${fresh.has(m.ts) ? " (new)" : ""} ${who(m.user)}: ${m.text}`];
    for (const id of m.files) {
      const file = fileById.get(id);
      if (!file) continue;
      lines.push(`attached file ${file.filename} (${file.title ?? "untitled"}), in full:`);
      lines.push("<<<", file.content ?? "(empty)", ">>>");
    }
    return lines.join("\n");
  };
  const threads = snapshot.threads.filter((t) => t.channel === config.channel);
  if (!threads.length) return "The incident channel is empty.";
  return threads
    .map((t) => {
      const [parent, ...replies] = t.messages;
      return [
        `Thread ${t.ts}:`,
        renderMessage(parent),
        ...replies.map((r) => `reply ${renderMessage(r)}`),
      ].join("\n");
    })
    .join("\n\n");
};

export const createPersona = (config: PersonaConfig) => {
  const now = config.now ?? Date.now;
  const sleep = config.sleep ?? defaultSleep;
  const random = seeded(config.seed);
  const maxRounds = config.maxRoundsPerTurn ?? 12;
  const system = systemPrompt(config);
  const seen = new Set<string>();
  const pendingMerges: { number: number; dueAt: number }[] = [];
  const notes: string[] = [];
  const stats: PersonaStats = {
    model: config.model.id,
    turns: 0,
    calls: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: null,
    actions: [],
    errors: [],
  };

  const price = () => {
    try {
      const r = ratesFor(config.model.id);
      stats.costUsd =
        stats.usage.input * r.input +
        stats.usage.output * r.output +
        stats.usage.cacheRead * r.cacheRead +
        stats.usage.cacheWrite * r.cacheWrite5m;
    } catch {
      stats.costUsd = null;
    }
  };

  const log = (action: string) => stats.actions.push({ at: now(), action });

  const replyDelayMs = () => {
    const [lo, hi] = config.replyDelaySeconds;
    return Math.round((lo + random() * (hi - lo)) * 1000);
  };

  const runDueMerges = async () => {
    const due = pendingMerges.filter((m) => m.dueAt <= now());
    for (const merge of due) {
      pendingMerges.splice(pendingMerges.indexOf(merge), 1);
      const res = await config.github.merge(merge.number);
      if (res.ok) {
        const sha = (res.body as { sha?: string }).sha;
        log(`merged #${merge.number}${sha ? ` as ${sha}` : ""}`);
        notes.push(`Your merge of #${merge.number} went through${sha ? ` (${sha})` : ""}.`);
      } else {
        log(`merge of #${merge.number} refused: HTTP ${res.status}`);
        notes.push(
          `Your merge of #${merge.number} was refused by GitHub: HTTP ${res.status}\n${res.text}`,
        );
      }
    }
  };

  const turn = async (snapshot: SlackSnapshot, fresh: Set<string>) => {
    stats.turns++;
    const pending = notes.splice(0);
    const intro = [
      `It is ${new Date(now()).toISOString()}. You are looking at the incident channel. Messages marked (new) arrived since you last looked.`,
      "",
      renderChannel(snapshot, config, fresh),
    ];
    if (pending.length) intro.push("", "Since you last looked:", ...pending.map((p) => `- ${p}`));
    if (pendingMerges.length) {
      intro.push(
        "",
        `Merges you have started and not finished: ${pendingMerges.map((m) => `#${m.number}`).join(", ")}.`,
      );
    }
    if (stats.actions.length) {
      intro.push("", "What you have done so far:", ...stats.actions.map((a) => `- ${a.action}`));
    }
    const messages: PersonaMessage[] = [
      { role: "user", content: [{ type: "text", text: intro.join("\n") }] },
    ];
    for (let round = 0; round < maxRounds; round++) {
      const completion = await config.model.complete({ system, messages, tools: PERSONA_TOOLS });
      stats.calls++;
      stats.usage.input += completion.usage.input;
      stats.usage.output += completion.usage.output;
      stats.usage.cacheRead += completion.usage.cacheRead;
      stats.usage.cacheWrite += completion.usage.cacheWrite;
      price();
      messages.push({ role: "assistant", content: completion.content });
      const uses = completion.content.filter((b) => b.type === "tool_use");
      if (!uses.length) return;
      const results = [];
      for (const use of uses) {
        let outcome;
        try {
          outcome = await runPersonaTool(
            {
              slack: config.slack,
              github: config.github,
              channel: config.channel,
              userId: config.userId,
              log,
              scheduleMerge: (n) => {
                if (pendingMerges.some((m) => m.number === n)) {
                  return `You are already merging #${n}.`;
                }
                pendingMerges.push({ number: n, dueAt: now() + config.mergeDelaySeconds * 1000 });
                log(`started merging #${n}`);
                return `You will merge #${n} once you get to it, in about ${config.mergeDelaySeconds} seconds. You will hear whether it went through.`;
              },
            },
            use.name,
            use.input,
          );
        } catch (err) {
          outcome = { content: `the tool failed: ${String(err)}`, isError: true };
        }
        results.push({
          type: "tool_result" as const,
          toolUseId: use.id,
          content: outcome.content,
          isError: outcome.isError,
        });
      }
      messages.push({ role: "user", content: results });
    }
    stats.errors.push({ at: now(), error: `turn ended after ${maxRounds} model calls` });
  };

  const newBotMessages = (snapshot: SlackSnapshot) =>
    allMessages(snapshot).filter(
      (m) => m.channel === config.channel && m.user === config.botUserId && !seen.has(m.ts),
    );

  /**
   * One look at the world. Runs merges that are due, and if BugBoss said
   * something new or a merge finished, waits the reply delay and takes a
   * turn. Returns whether a turn ran.
   */
  const tick = async (): Promise<boolean> => {
    await runDueMerges();
    let snapshot = await config.slack.state();
    if (!newBotMessages(snapshot).length && !notes.length) return false;
    await sleep(replyDelayMs());
    // Catch up on whatever else arrived while this person was away.
    await runDueMerges();
    snapshot = await config.slack.state();
    const fresh = new Set(newBotMessages(snapshot).map((m) => m.ts));
    for (const ts of fresh) seen.add(ts);
    try {
      await turn(snapshot, fresh);
    } catch (err) {
      stats.errors.push({ at: now(), error: String(err) });
    }
    config.onStats?.(stats);
    return true;
  };

  return {
    stats: () => stats,
    tick,
    /** When the next queued merge is due, or null. */
    nextMergeAt: () =>
      pendingMerges.length ? Math.min(...pendingMerges.map((m) => m.dueAt)) : null,
    run: async (signal: AbortSignal) => {
      const pollMs = config.pollMs ?? 2_000;
      while (!signal.aborted) {
        try {
          await tick();
        } catch (err) {
          stats.errors.push({ at: now(), error: String(err) });
          config.onStats?.(stats);
        }
        await sleep(pollMs);
      }
    },
  };
};
