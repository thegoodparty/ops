import {
  median as medianOf,
  MIN_POWERED_CASES,
  pct,
  type Comparison,
  type DeltaSummary,
  type Section,
} from "./aggregate";
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

// ---------------------------------------------------------------------------
// A/B comparison, for both tiers
// ---------------------------------------------------------------------------

const money = (v: number | undefined) =>
  v === undefined ? "-" : `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
const signedMoney = (v: number | undefined) =>
  v === undefined ? "-" : `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
const secs = (v: number | undefined) => {
  if (v === undefined) return "-";
  const abs = Math.abs(v);
  const text = abs >= 3600 ? `${(abs / 3600).toFixed(1)}h` : abs >= 60 ? `${Math.round(abs / 60)}m` : `${Math.round(abs)}s`;
  return v < 0 ? `-${text}` : text;
};
const signedSecs = (v: number | undefined) =>
  v === undefined ? "-" : `${v >= 0 ? "+" : ""}${secs(v)}`;
const pValue = (p: number | undefined) => (p === undefined ? "-" : p.toFixed(3));

/**
 * A table cell cannot hold a raw pipe or newline. Whitespace is collapsed and
 * pipes escaped; nothing is cut, so a long rationale makes a wide cell.
 */
const tableCell = (text: string) =>
  text.split(/\s+/).filter(Boolean).join(" ").replace(/\|/g, "\\|");

const deltaRow = (label: string, d: DeltaSummary, fmt: (v: number | undefined) => string, signedFmt: (v: number | undefined) => string) =>
  `| ${label} | ${fmt(d.medianBaseline)} | ${fmt(d.medianCandidate)} | ${signedFmt(d.medianDelta)} | ${d.lower} lower / ${d.equal} equal / ${d.higher} higher | ${pValue(d.signTestP)} | ${d.verdict} |`;

const sectionLines = (s: Section): string[] => [
  `Quality: **${s.quality.verdict}**. ${s.quality.explanation}`,
  "",
  "| Measure | Baseline median | Candidate median | Median delta | Pairs | Sign test p | Verdict |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  deltaRow("Cost", s.cost, money, signedMoney),
  deltaRow("Wall clock", s.wallClock, secs, signedSecs),
  "",
  `Run endings, baseline: ${Object.entries(s.statuses.baseline).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}. Candidate: ${Object.entries(s.statuses.candidate).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}.`,
];

export const renderComparison = (args: {
  comparison: Comparison;
  tier: "Tier 1" | "Tier 2";
  baselineRef: string;
  candidateRef: string;
  judgeModel?: string;
}): string => {
  const { comparison: c } = args;
  const lines: string[] = [
    `# BugBoss eval, ${args.tier}: ${c.aa ? "A/A calibration" : "A/B comparison"}`,
    "",
  ];
  if (c.aa) {
    const cost = c.overall.cost.deltas.map(Math.abs);
    const wall = c.overall.wallClock.deltas.map(Math.abs);
    lines.push(
      "Both sides ran the same ref, so every difference below is run-to-run noise. Treat a later A/B difference smaller than this spread as noise.",
      "",
      `- Cost: median absolute pair difference ${money(medianOf(cost))}, largest ${money(cost.length ? Math.max(...cost) : undefined)}.`,
      `- Wall clock: median absolute pair difference ${secs(medianOf(wall))}, largest ${secs(wall.length ? Math.max(...wall) : undefined)}.`,
      `- Judge flip rate: ${pct(c.overall.quality.flipRate)}.`,
      "",
    );
  } else {
    lines.push(
      c.ship.passes
        ? "**Ship rule: passes.** No gate regressed and quality is not significantly worse. The cost and wall-clock deltas below are for the owner to weigh."
        : `**Ship rule: fails.** ${c.ship.reasons.join("; ")}.`,
      "",
    );
  }
  lines.push(
    `## Overall (${c.pairs.length} pairs)`,
    "",
    ...sectionLines(c.overall),
    "",
    "## Gate regressions",
    "",
    ...(c.regressions.length === 0
      ? ["None. No gate that passed in every baseline rep of a scenario failed in a candidate rep."]
      : [
          "A gate that passed in every baseline rep of a scenario and failed in any candidate rep. Each one blocks.",
          "",
          "| Scenario | Gate | Baseline reps (all passed) | Candidate reps that failed |",
          "| --- | --- | --- | --- |",
          ...c.regressions.map((r) => `| ${r.scenarioId} | ${r.gate} | ${r.baselineReps} | ${r.failedReps.join(", ")} |`),
        ]),
    "",
    "## By scenario",
    "",
    "Read these as well as the total: a change that helps two scenarios and breaks one can hide in a tally.",
    "",
  );
  for (const [id, s] of Object.entries(c.byScenario)) {
    lines.push(`### ${id}`, "", ...sectionLines(s), "");
  }
  lines.push(
    "## Per pair",
    "",
    "| Pair | Scenario | Rep | Baseline | Candidate | Cost delta | Wall-clock delta | Verdict | Why |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...c.pairs.map((p) => {
      const v = p.verdict;
      const verdict = !v ? "not judged" : v.excluded ? "excluded" : v.flipped ? "unstable" : v.winner === "tie" ? "tie" : `${v.winner} ${v.margin}`;
      const why = !v ? "" : v.excluded ?? v.rationale;
      const d = (field: "costUsd" | "wallClockSeconds") =>
        typeof p.baseline[field] === "number" && typeof p.candidate[field] === "number"
          ? (p.candidate[field] as number) - (p.baseline[field] as number)
          : undefined;
      return `| ${p.pairId} | ${p.scenarioId} | ${p.rep} | ${p.baseline.status} | ${p.candidate.status} | ${signedMoney(d("costUsd"))} | ${signedSecs(d("wallClockSeconds"))} | ${verdict} | ${tableCell(why)} |`;
    }),
    "",
    "## How this was run",
    "",
    `- Baseline: \`${args.baselineRef}\`. Candidate: \`${args.candidateRef}\`.`,
    ...(args.judgeModel ? [`- Judge model: \`${args.judgeModel}\`. Judge spend: ${money(c.overall.quality.judgeCostUsd)}.`] : []),
    "- Every pair is judged twice with the outputs swapped. A pair whose verdict reverses is unstable and excluded from scoring; above 20% unstable the quality result is inconclusive.",
    "- Before judging, identifiers, timestamps and every line stating a run's cost, tokens, turns or duration are removed from both sides. Nothing is cut for length; a pair too large for the judge is excluded and listed above.",
    `- No quality, cost or wall-clock direction is claimed below ${MIN_POWERED_CASES} decided pairs. Wall-clock differences under about 20% are noise until an A/A run shows the real spread.`,
    "- Cost is the model proxy's count for the agent under test. Persona, judge and Boss triage spend are not in it.",
    "",
  );
  return lines.join("\n");
};
