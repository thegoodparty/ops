import { measure, PHASES, type ColdCause, type Scorecard } from "./metrics";
import {
  calibrate,
  embeddedDocs,
  grafanaToolUse,
  median,
  type Calibration,
  type ToolUse,
} from "./prefix";
import { deriveRates, ratesFor, type RateDerivation, type Rates } from "./price";
import type { Trace } from "./trace";
import {
  frozenUsd,
  keepAlive,
  phaseReset,
  prefixTrim,
  priceWorld,
  todayWorld,
  type KeepAlive,
  type PhaseReset,
} from "./whatif";

export interface PrefixScenario {
  charsPerToken: number;
  /** Share of the dropped docs the agent reads back, charged from turn one. */
  readBackShare: number;
}

export interface Scenarios<T> {
  low: T;
  central: T;
  high: T;
}

export interface ReportOptions {
  keepAlive: Scenarios<KeepAlive>;
  prefix: Scenarios<PrefixScenario>;
  phaseReset: Scenarios<PhaseReset>;
  /** A gated reset: only where context at the milestone is at least this. */
  gatedResetMinContext: number;
  /** Ids to subtotal separately, for comparison with an earlier estimate. */
  focus: string[];
}

export const defaultOptions = (calibration: Calibration): ReportOptions => {
  const measured = median(calibration.charsPerToken);
  const central = Number.isFinite(measured) ? measured : 2.75;
  const reset: PhaseReset = {
    handoffTokens: 10_000,
    handoffOutputTokens: 2_000,
    reorientTurns: 3,
    reorientOutputTokens: 500,
    reorientWriteTokens: 3_000,
    prefixCached: false,
    minContextTokens: 0,
  };
  return {
    keepAlive: {
      low: { everyMinutes: 30, ttlMinutes: 60 },
      central: { everyMinutes: 55, ttlMinutes: 60 },
      high: { everyMinutes: 58, ttlMinutes: 60 },
    },
    prefix: {
      low: { charsPerToken: 3.3, readBackShare: 0.5 },
      central: { charsPerToken: central, readBackShare: 0.25 },
      high: { charsPerToken: 2.4, readBackShare: 0 },
    },
    phaseReset: {
      low: { ...reset, handoffTokens: 40_000, reorientTurns: 10 },
      central: reset,
      high: { ...reset, handoffTokens: 5_000, reorientTurns: 0, prefixCached: true },
    },
    gatedResetMinContext: 150_000,
    focus: [],
  };
};

export interface LeverRun {
  id: string;
  todayUsd: number;
  low: number;
  central: number;
  high: number;
}

export interface Lever {
  name: string;
  runs: LeverRun[];
  outcomeCanChange: boolean;
}

const usd = (value: number) =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
const k = (tokens: number | null) =>
  tokens === null ? "-" : `${Math.round(tokens / 1000)}k`;
const perM = (rate: number) => `$${(rate * 1e6).toFixed(3)}/M`;
const minutes = (ms: number) =>
  ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${Math.round(ms / 60_000)}m`;

export const prefixTokensFor = (
  transcript: Trace,
  tools: ToolUse,
  scenario: PrefixScenario,
): { docs: number; tools: number; total: number } => {
  const docsChars = embeddedDocs(transcript.systemPrompt).reduce(
    (sum, doc) => sum + doc.chars,
    0,
  );
  const docs = (docsChars / scenario.charsPerToken) * (1 - scenario.readBackShare);
  const toolTokens = tools.unusedChars / scenario.charsPerToken;
  return { docs, tools: toolTokens, total: Math.round(docs + toolTokens) };
};

export const levers = (
  transcripts: Trace[],
  rates: Rates,
  options: ReportOptions,
): Lever[] => {
  const tools = grafanaToolUse(transcripts);
  const run = (
    name: string,
    outcomeCanChange: boolean,
    variant: (
      transcript: Trace,
      scenario: "low" | "central" | "high",
    ) => ReturnType<typeof todayWorld>,
  ): Lever => ({
    name,
    outcomeCanChange,
    runs: transcripts.map((transcript) => {
      const today = priceWorld(todayWorld(transcript), rates).total;
      const saving = (scenario: "low" | "central" | "high") =>
        today - priceWorld(variant(transcript, scenario), rates).total;
      return {
        id: transcript.id,
        todayUsd: today,
        low: saving("low"),
        central: saving("central"),
        high: saving("high"),
      };
    }),
  });
  return [
    run("Cache keep-alive during long waits", false, (t, s) =>
      keepAlive(t, todayWorld(t), options.keepAlive[s]),
    ),
    run("Trim the fixed prefix (embedded docs + unused Grafana tools)", true, (t, s) =>
      prefixTrim(todayWorld(t), prefixTokensFor(t, tools, options.prefix[s]).total),
    ),
    run("Phase-reset sessions at root cause and PR open", true, (t, s) =>
      phaseReset(t, todayWorld(t), options.phaseReset[s]),
    ),
    run(
      `Phase reset, only where context is at least ${Math.round(options.gatedResetMinContext / 1000)}k`,
      true,
      (t, s) =>
        phaseReset(t, todayWorld(t), {
          ...options.phaseReset[s],
          minContextTokens: options.gatedResetMinContext,
        }),
    ),
  ];
};

const total = (runs: LeverRun[], key: "todayUsd" | "low" | "central" | "high") =>
  runs.reduce((sum, run) => sum + run[key], 0);

const CAUSES: ColdCause[] = [
  "session_start",
  "relaunch",
  "relaunch_after_crash_loop",
  "wait_over_ttl",
  "slow_tool_over_ttl",
  "unexplained",
];

const rangeOf = (runs: LeverRun[]) => {
  const values = [total(runs, "low"), total(runs, "central"), total(runs, "high")];
  return [Math.min(...values), Math.max(...values)];
};

export const renderReport = (
  transcripts: Trace[],
  options?: Partial<ReportOptions>,
): string => {
  if (transcripts.length === 0) {
    throw new Error("renderReport needs at least one transcript");
  }
  const derivation: RateDerivation = deriveRates(transcripts);
  const models = [...new Set(transcripts.map((t) => t.model))];
  if (models.length !== 1) {
    throw new Error(`one model per report, got ${models.join(", ")}`);
  }
  const rates = ratesFor(models[0]);
  const calibration = calibrate(transcripts);
  const opts = { ...defaultOptions(calibration), ...options };
  const cards: Scorecard[] = transcripts.map((t) => measure(t, rates));
  const tools = grafanaToolUse(transcripts);
  const results = levers(transcripts, rates, opts);
  const recorded = cards.reduce((sum, card) => sum + card.recordedUsd, 0);
  const repriced = cards.reduce((sum, card) => sum + card.repricedUsd, 0);
  const today = total(results[0].runs, "todayUsd");
  const frozen = transcripts.reduce(
    (sum, t) => sum + frozenUsd(todayWorld(t), rates),
    0,
  );
  const focus = new Set(opts.focus);
  const lines: string[] = [];
  const push = (...more: string[]) => lines.push(...more);

  push(
    "# BugBoss cost levers, measured",
    "",
    `Corpus: ${transcripts.length} incident transcripts (${transcripts.map((t) => t.id).join(", ")}). Recorded spend ${usd(recorded)}; the same turns re-priced under today's 1h cache come to ${usd(today)}. No model calls were made.`,
    "",
    "## Ranked levers",
    "",
    "Savings are against the recorded runs re-priced under today's cache (every write at the 1h rate, and 5m-TTL misses that 1h would have covered turned warm). Range is the low and high assumption sets below.",
    "",
    `| Rank | Lever | Saving, all ${transcripts.length} runs | Range | Share of today's cost |${focus.size ? ` Saving on ${[...focus].join(", ")} |` : ""} Outcome can change? |`,
    `| --- | --- | --- | --- | --- |${focus.size ? " --- |" : ""} --- |`,
  );
  const ranked = [...results].sort(
    (a, b) => total(b.runs, "central") - total(a.runs, "central"),
  );
  ranked.forEach((lever, i) => {
    const [lo, hi] = rangeOf(lever.runs);
    const focused = lever.runs.filter((r) => focus.has(r.id));
    const [flo, fhi] = rangeOf(focused);
    push(
      `| ${i + 1} | ${lever.name} | ${usd(total(lever.runs, "central"))} | ${usd(lo)} to ${usd(hi)} | ${((total(lever.runs, "central") / today) * 100).toFixed(1)}% |${focus.size ? ` ${usd(total(focused, "central"))} (${usd(flo)} to ${usd(fhi)}) |` : ""} ${lever.outcomeCanChange ? "Yes, needs Phase 2/3" : "No"} |`,
    );
  });
  push(
    "",
    `Harness crash loop, reported apart from every lever: ${cards.reduce((s, c) => s + c.harness.blockBindingTurns, 0)} block_binding error turns (billed $0), and ${usd(frozen)} of cold writes on the relaunches that followed them. Those turns are priced identically in every world.`,
    "",
    "## Assumptions",
    "",
    `### Rates for ${models[0]}`,
    "",
    "From the eval's own price table (\`price.ts\`), checked against rates re-derived from this corpus's per-turn cost fields.",
    "",
    "| Category | Table rate | Derived from corpus | Tokens behind it |",
    "| --- | --- | --- | --- |",
    ...(
      [
        ["Input", "input"],
        ["Output", "output"],
        ["Cache read", "cacheRead"],
        ["Cache write, 5m", "cacheWrite5m"],
        ["Cache write, 1h", "cacheWrite1h"],
      ] as const
    ).map(
      ([label, key]) =>
        `| ${label} | ${perM(rates[key])} | ${derivation.tokens[key] ? perM(derivation.rates[key]) : "-"} | ${derivation.tokens[key].toLocaleString("en-US")} |`,
    ),
    "",
    `Largest single-turn deviation from the derived rates: ${(derivation.maxDeviation * 100).toFixed(2)}%. Re-pricing every recorded turn with the table gives ${usd(repriced)} against ${usd(recorded)} recorded.`,
    "",
    "### Keep-alive",
    "",
    `A one-output-token request every N minutes during any in-process gap, reading the cached context. Relaunch gaps get none. Central: every ${opts.keepAlive.central.everyMinutes} min (high: ${opts.keepAlive.high.everyMinutes}) against a ${opts.keepAlive.central.ttlMinutes} min TTL. Low: every ${opts.keepAlive.low.everyMinutes} min, for a TTL that proves shorter than advertised. Pi's own warmer cannot do this job even once enabled: it stops 60 minutes after the request that started it.`,
    "",
    "### Prefix trim",
    "",
    `Drops every embedded \`<document>\` block from the system prompt, and the Grafana tools no transcript ever called. Offered today: ${tools.offered.length}; ever called: ${tools.used.length} (${tools.used.join(", ")}). Unused tool definitions: ${tools.unusedChars.toLocaleString("en-US")} characters${tools.unmeasured.length ? `; no size for ${tools.unmeasured.join(", ")}` : ""}.`,
    "",
    `Characters per token, measured on our system prompt from first turns whose tool block came from a sibling incident's cache: ${calibration.charsPerToken.map((v) => v.toFixed(2)).join(", ") || "none"} (tool block ${calibration.toolBlockTokens.map((v) => v.toLocaleString("en-US")).join(", ") || "n/a"} tokens). Central uses the median, ${opts.prefix.central.charsPerToken.toFixed(2)}. Low: ${opts.prefix.low.charsPerToken} chars/token and half the dropped docs read back. High: ${opts.prefix.high.charsPerToken} and none read back. Central assumes a quarter read back. Read-back is charged from turn one, which overstates it.`,
    "",
    "| Run | Docs in prompt | Docs tokens (central) | Tokens trimmed, low / central / high |",
    "| --- | --- | --- | --- |",
    ...transcripts.map((t) => {
      const chars = embeddedDocs(t.systemPrompt).reduce((s, d) => s + d.chars, 0);
      const c = prefixTokensFor(t, tools, opts.prefix.central);
      return `| ${t.id} | ${chars.toLocaleString("en-US")} chars | ${k(c.docs / (1 - opts.prefix.central.readBackShare))} | ${k(prefixTokensFor(t, tools, opts.prefix.low).total)} / ${k(c.total)} / ${k(prefixTokensFor(t, tools, opts.prefix.high).total)} |`;
    }),
    "",
    "### Phase reset",
    "",
    `At \`report_root_cause\` and at the first \`gh pr create\`, a fresh session starts from the run's own first-turn prefix plus a handoff. Central: ${k(opts.phaseReset.central.handoffTokens)} handoff, ${k(opts.phaseReset.central.handoffOutputTokens)} output to write it, ${opts.phaseReset.central.reorientTurns} re-orientation turns, and the new session's first request written cold in full. Low: ${k(opts.phaseReset.low.handoffTokens)} handoff and ${opts.phaseReset.low.reorientTurns} re-orientation turns. High: ${k(opts.phaseReset.high.handoffTokens)} handoff, none, and the prefix read from cache. The gated variant skips a milestone whose context is under ${k(opts.gatedResetMinContext)}, where the reset's own cost exceeds what it saves. The levers overlap, so their savings do not add.`,
    "",
    "## Per-run savings (central)",
    "",
    `| Run | Recorded | Today | ${results.map((l) => l.name.split(" (")[0]).join(" | ")} |`,
    `| --- | --- | --- | ${results.map(() => "---").join(" | ")} |`,
    ...transcripts.map((t, i) => {
      const card = cards[i];
      return `| ${t.id} | ${usd(card.recordedUsd)} | ${usd(results[0].runs[i].todayUsd)} | ${results.map((l) => usd(l.runs[i].central)).join(" | ")} |`;
    }),
    "",
    "## Scorecard",
    "",
    "Phase boundaries: the first accepted `report_root_cause`, and the first accepted bash call running `gh pr create`.",
    "",
    "| Run | Turns | Recorded | Investigate | Fix | Post-PR | RC turn | PR turn | Cold starts | Refused calls (loops) | Duplicate calls | Peak ctx | Ctx at PR | Last ctx | Exits |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...cards.map(
      (c) =>
        `| ${c.id} | ${c.turns} | ${usd(c.recordedUsd)} | ${PHASES.map((p) => usd(c.byPhase[p].usd)).join(" | ")} | ${c.marks.rootCauseTurn ?? "-"} | ${c.marks.prOpenTurn ?? "-"} | ${c.cold.length} (${usd(c.cold.reduce((s, x) => s + x.writeUsd, 0))}) | ${c.refusals.total} (${c.refusals.loops.length}) | ${c.duplicates.reduce((s, d) => s + d.turns.length - 1, 0)} | ${k(c.context.peak)} | ${k(c.context.atPrOpen)} | ${k(c.context.last)} | ${Object.entries(c.exits).map(([r, n]) => `${n} x ${r}`).join(", ") || "none"} |`,
    ),
    "",
    "### Cold starts by cause",
    "",
    `| Run | ${CAUSES.join(" | ")} |`,
    `| --- | ${CAUSES.map(() => "---").join(" | ")} |`,
    ...cards.map(
      (c) =>
        `| ${c.id} | ${CAUSES.map((cause) => {
          const hits = c.cold.filter((x) => x.cause === cause);
          return hits.length ? `${hits.length} (${usd(hits.reduce((s, x) => s + x.writeUsd, 0))})` : "-";
        }).join(" | ")} |`,
    ),
    "",
    "A cold start is a turn that wrote more than half its context. `wait_over_ttl` follows a `monitor` or `contact_human`; `unexplained` means the prefix changed and is a bug signal.",
    "",
  );

  for (const c of cards) {
    push(`### Run ${c.id}`, "");
    push(
      `- Cost by category: input ${usd(c.cost.input)}, output ${usd(c.cost.output)}, cache read ${usd(c.cost.cacheRead)}, cache write ${usd(c.cost.cacheWrite)}. Billed turns on the 5m path: ${c.ttls["5m"]}, on the 1h path: ${c.ttls["1h"]}.`,
      `- Context by decile of billed turns: ${c.context.deciles.map(k).join(", ")}. At root cause ${k(c.context.atRootCause)}.`,
    );
    if (c.cold.length) {
      push(
        `- Cold turns: ${c.cold.map((x) => `${x.turn} (${x.cause}, gap ${minutes(x.gapMs)}, ${x.ttl}, ${k(x.writeTokens)}, ${usd(x.writeUsd)})`).join("; ")}.`,
      );
    }
    if (c.refusals.total) {
      push(
        `- Refused calls by tool: ${Object.entries(c.refusals.byTool).map(([tool, n]) => `${tool} ${n}`).join(", ")}; the turns that issued them cost ${usd(c.refusals.usd)}.`,
      );
      for (const loop of c.refusals.loops) {
        push(`  - Loop: ${loop.tool} refused ${loop.turns.length} times in a row (turns ${[...new Set(loop.turns)].join(", ")}), ${usd(loop.usd)}.`);
      }
    }
    if (c.duplicates.length) {
      const byTool = new Map<string, number>();
      for (const d of c.duplicates) {
        byTool.set(d.tool, (byTool.get(d.tool) ?? 0) + d.turns.length - 1);
      }
      push(
        `- Duplicate calls (same tool, same arguments; polling tools excluded): ${[...byTool].map(([tool, n]) => `${tool} ${n}`).join(", ")}.`,
      );
    }
    if (c.harness.errorTurns) {
      push(
        `- Harness: ${c.harness.errorTurns} error turns, ${c.harness.blockBindingTurns} of them block_binding; relaunch cold writes after the loop: ${c.harness.crashLoopRelaunchTurns.join(", ") || "none"} (${usd(c.harness.crashLoopRelaunchUsd)}).`,
      );
    }
    push("");
  }
  return lines.join("\n");
};
