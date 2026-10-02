/**
 * Blind graded-pairwise judging of two incident runs, ported from universal
 * judge (omni packages/universal-judge/src/pairwise.ts).
 *
 * Kept from it: the judge sees "Output 1" and "Output 2" in an order derived
 * from a hash of the pair id, every pair is judged twice with the order
 * swapped, a verdict that reverses under the swap is unstable and excluded,
 * and two passes that agree on direction keep the weaker margin.
 *
 * Changed from it: both sides are blinded first (`blind.ts`), and nothing is
 * truncated. Universal judge cut each side at 60,000 characters; here a pair
 * that does not fit the judge's context is refused and reported, because a
 * thread missing its second half is a different thread.
 *
 * What the judge sees of a side is its external activity: the rendered
 * timeline (`activity.ts`) of every Slack message, GitHub event, the deploy
 * check and the close, plus the fix diff. Never a transcript, a tool call or
 * an incident row, so two systems built nothing alike are compared on the
 * same terms.
 *
 * The model is reached through `JudgeModel`, not through the system under
 * test: the judge has to keep working when that system's own request path is
 * the thing a variant changed.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { blindSide, type BlindOptions, type SideOutput } from "./blind";
import { priceTokens, ratesFor } from "./price";

export const RUBRIC_DIR = join(__dirname, "rubrics");

export const DEFAULT_JUDGE_MODEL = "claude-opus-5-5";

export type VariantRole = "baseline" | "candidate";
export type Margin = "much_better" | "better" | "tie";

export const VERDICT_TOOL = {
  name: "record_verdict",
  description: "Record the comparison verdict. Call exactly once.",
  input_schema: {
    type: "object" as const,
    properties: {
      winner: {
        type: "string",
        enum: ["output_1", "output_2", "tie"],
        description: "Which output is better, or tie.",
      },
      margin: {
        type: "string",
        enum: ["much_better", "better", "tie"],
        description:
          'How much better. Must be "tie" when winner is "tie", and must not be "tie" otherwise.',
      },
      deciding_criterion: {
        type: "string",
        description:
          'The single rubric criterion that decided it, named as it appears in the rubric. Use "none" for a tie.',
      },
      rationale: {
        type: "string",
        description:
          "Two to four sentences citing the specific text that demonstrates the deciding criterion.",
      },
    },
    required: ["winner", "margin", "deciding_criterion", "rationale"],
    additionalProperties: false,
  },
};

export interface JudgeRequest {
  system: string;
  prompt: string;
}

export interface JudgeResponse {
  /** The `record_verdict` input, or null when the model called no tool. */
  toolInput: Record<string, unknown> | null;
  stopReason: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** One judging call. Tests pass a fake; `createAnthropicJudgeModel` is the real one. */
export type JudgeModel = (request: JudgeRequest) => Promise<JudgeResponse>;

/**
 * Thrown by a model when the prompt does not fit its context. The pair is
 * refused rather than shortened.
 */
export class PromptTooLongError extends Error {}

const TOO_LONG = /too long|too many tokens|context (window|length)|maximum.*tokens|input is too large/i;

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/**
 * The judge on the Anthropic API, with plain fetch. The eval has no AWS and
 * no new dependency. The verdict comes back as a tool call: the model cannot
 * be forced to make it (that is a 400 on this model), so the tool is strict
 * and the prompt asks for exactly one call; a reply with no call is a judge
 * failure the pair reports, not a verdict.
 */
export const createAnthropicJudgeModel = (
  args: {
    apiKey?: string;
    model?: string;
    /** Tests only. */
    fetch?: typeof fetch;
    url?: string;
  } = {},
): JudgeModel => {
  const model = args.model ?? DEFAULT_JUDGE_MODEL;
  const doFetch = args.fetch ?? fetch;
  return async (request) => {
    const apiKey = args.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("the judge needs an Anthropic API key: pass apiKey or set ANTHROPIC_API_KEY");
    const body = {
      model,
      max_tokens: 16000,
      system: request.system,
      tools: [{ ...VERDICT_TOOL, strict: true }],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: request.prompt }],
    };
    // A judging call is one short structured verdict. When it has not
    // answered in two minutes it is wedged, and one excluded pair is better
    // than a comparison that sits for the SDK's default.
    const response = await doFetch(args.url ?? ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        const json = JSON.parse(text) as { error?: { message?: string } };
        message = json.error?.message ?? text;
      } catch {}
      if (TOO_LONG.test(message)) throw new PromptTooLongError(message);
      throw new Error(`judge model call failed: HTTP ${response.status}: ${message}`);
    }
    const parsed = JSON.parse(text) as {
      content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
      stop_reason?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    const block = parsed.content?.find(
      (part) => part.type === "tool_use" && part.name === VERDICT_TOOL.name,
    );
    return {
      toolInput: block?.input ?? null,
      stopReason: parsed.stop_reason ?? "",
      usage: {
        input: parsed.usage?.input_tokens ?? 0,
        output: parsed.usage?.output_tokens ?? 0,
        cacheRead: parsed.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: parsed.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  };
};

export const loadRubric = (name = "incident", dir = RUBRIC_DIR): string =>
  readFileSync(join(dir, `${name}.md`), "utf8");

/** The context both sides worked from. Identical for both. */
export interface JudgeContext {
  /** The Grafana webhook body that opened the incident. */
  alert: unknown;
  /**
   * The vetted account of the incident, `reference.md`: the mechanism, what
   * the mitigation and the systemic fix should each have been, and which of
   * the human's lines were wrong. Never the real fix diff. Null when no
   * human-vetted reference exists; the judge is told so and the verdict
   * records it.
   */
  reference: string | null;
}

export const NO_REFERENCE =
  "No vetted reference exists for this incident. Compare the two sides against each other and against the evidence each one cites.";

/**
 * A fence longer than any backtick run in the text, so a diff or a message
 * that contains a fenced block cannot close ours early.
 */
const fenced = (text: string, lang = ""): string => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
};

const part = (title: string, value: string | null, lang = ""): string[] =>
  value === null || value.trim() === ""
    ? [`### ${title}`, "", "(none produced)", ""]
    : [`### ${title}`, "", fenced(value, lang), ""];

const renderSide = (label: string, side: SideOutput): string[] => [
  `## ${label}`,
  "",
  ...part("What happened, as the on-call human and GitHub saw it", side.timeline),
  ...part("Fix diff", side.diff, "diff"),
];

export const buildPrompt = (context: JudgeContext, first: SideOutput, second: SideOutput): string =>
  [
    "Two systems handled the same production incident. For each you see everything the on-call human and GitHub saw, in order, and the code change. Compare how each handled it using the rubric and record your verdict.",
    "",
    "## The alert that opened the incident",
    "",
    fenced(
      typeof context.alert === "string" ? context.alert : JSON.stringify(context.alert, null, 2),
      "json",
    ),
    "",
    ...(context.reference === null
      ? ["## Reference", "", NO_REFERENCE]
      : ["## Reference, vetted by a human", "", fenced(context.reference)]),
    "",
    ...renderSide("Output 1", first),
    ...renderSide("Output 2", second),
    "Call record_verdict exactly once.",
  ].join("\n");

export interface SingleJudgement {
  winner: VariantRole | "tie";
  margin: Margin;
  decidingCriterion: string;
  rationale: string;
  costUsd: number;
}

export interface CaseVerdict {
  pairId: string;
  winner: VariantRole | "tie";
  margin: Margin;
  decidingCriterion: string;
  rationale: string;
  /** True when the judge reversed itself once the two outputs were swapped. */
  flipped: boolean;
  /**
   * Set when the pair was not judged: too long for the judge's context, or a
   * judge call that failed. Excluded from scoring and listed in the report.
   */
  excluded: string | null;
  judgeCostUsd: number;
  /** Timeline lines blinding removed, both sides counted once. */
  blindedLines: number;
}

const MARGIN_RANK: Record<Margin, number> = { tie: 0, better: 1, much_better: 2 };

const judgeOnce = async (args: {
  model: JudgeModel;
  modelId: string;
  rubric: string;
  context: JudgeContext;
  first: SideOutput;
  second: SideOutput;
  firstRole: VariantRole;
  secondRole: VariantRole;
}): Promise<SingleJudgement> => {
  const response = await args.model({
    system: args.rubric,
    prompt: buildPrompt(args.context, args.first, args.second),
  });
  if (!response.toolInput) {
    throw new Error(`judge returned no tool call (stop: ${response.stopReason})`);
  }
  const data = response.toolInput as {
    winner?: string;
    margin?: string;
    deciding_criterion?: string;
    rationale?: string;
  };
  let winner: VariantRole | "tie" =
    data.winner === "output_1"
      ? args.firstRole
      : data.winner === "output_2"
        ? args.secondRole
        : "tie";
  const margin: Margin =
    winner === "tie" || !(data.margin && data.margin in MARGIN_RANK)
      ? "tie"
      : (data.margin as Margin);
  // A model that picks a side but grades the margin as a tie has not picked a side.
  if (margin === "tie") winner = "tie";
  return {
    winner,
    margin,
    decidingCriterion: String(data.deciding_criterion ?? ""),
    rationale: String(data.rationale ?? ""),
    costUsd: priceTokens({ ...response.usage, cacheWrite1h: 0 }, ratesFor(args.modelId)),
  };
};

/** Arbitrary but reproducible: the same pair always gets the same starting order. */
export const baselineFirst = (pairId: string): boolean =>
  createHash("sha256").update(pairId).digest()[0] % 2 === 0;

/**
 * Combine the two order-swapped judgements. Disagreement about direction means
 * the judge was reading position rather than content, so the pair is marked
 * unstable instead of being resolved by fiat. When both agree on direction but
 * not on strength, the weaker margin wins.
 */
export const reconcile = (
  pairId: string,
  first: SingleJudgement,
  second: SingleJudgement,
  blindedLines = 0,
): CaseVerdict => {
  const judgeCostUsd = first.costUsd + second.costUsd;
  if (first.winner !== second.winner) {
    return {
      pairId,
      winner: "tie",
      margin: "tie",
      decidingCriterion: "unstable",
      rationale:
        `Unstable under order swap. Shown one way the judge picked ${first.winner} ` +
        `(${first.margin}); shown the other way it picked ${second.winner} ` +
        `(${second.margin}). First rationale: ${first.rationale}`,
      flipped: true,
      excluded: null,
      judgeCostUsd,
      blindedLines,
    };
  }
  return {
    pairId,
    winner: first.winner,
    margin: MARGIN_RANK[first.margin] <= MARGIN_RANK[second.margin] ? first.margin : second.margin,
    decidingCriterion: first.decidingCriterion,
    rationale: first.rationale,
    flipped: false,
    excluded: null,
    judgeCostUsd,
    blindedLines,
  };
};

export const judgePair = async (args: {
  pairId: string;
  context: JudgeContext;
  baseline: SideOutput;
  candidate: SideOutput;
  model: JudgeModel;
  /** For pricing the judge's own calls through the eval's price table. */
  modelId?: string;
  rubric?: string;
  blinding?: BlindOptions;
}): Promise<CaseVerdict> => {
  const modelId = args.modelId ?? DEFAULT_JUDGE_MODEL;
  const rubric = args.rubric ?? loadRubric();
  const baseline = blindSide(args.baseline, args.blinding);
  const candidate = blindSide(args.candidate, args.blinding);
  const blindedLines = baseline.droppedLines + candidate.droppedLines;
  const orders = [baselineFirst(args.pairId), !baselineFirst(args.pairId)];

  const judgements: SingleJudgement[] = [];
  try {
    for (const baseIsFirst of orders) {
      judgements.push(
        await judgeOnce({
          model: args.model,
          modelId,
          rubric,
          context: args.context,
          first: baseIsFirst ? baseline.output : candidate.output,
          second: baseIsFirst ? candidate.output : baseline.output,
          firstRole: baseIsFirst ? "baseline" : "candidate",
          secondRole: baseIsFirst ? "candidate" : "baseline",
        }),
      );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      pairId: args.pairId,
      winner: "tie",
      margin: "tie",
      decidingCriterion: "excluded",
      rationale: "",
      flipped: false,
      excluded:
        error instanceof PromptTooLongError
          ? `refused: the pair does not fit the judge's context whole (${message})`
          : `judge failed: ${message}`,
      judgeCostUsd: judgements.reduce((sum, j) => sum + j.costUsd, 0),
      blindedLines,
    };
  }
  const [first, second] = judgements;
  return reconcile(args.pairId, first, second, blindedLines);
};
