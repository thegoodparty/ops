import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAnthropicJudgeModel,
  VERDICT_TOOL,
} from "../../../bugboss-evals/core/judge";
import type { JudgeModel } from "../../../bugboss-evals/core/judge";
import type { Bundle, ReviewOutput, ReviewRecord } from "../schema";
import type { Result } from "./replay";

export { createAnthropicJudgeModel };
export type { JudgeModel };

export const DEFAULT_JUDGE_MODEL = "claude-sonnet-4-6";

export interface PassResult {
  order: "a=1,b=2" | "a=2,b=1";
  winner: "a" | "b" | "tie";
  margin: string;
  deciding_criterion: string;
  rationale: string;
}

export interface PairVerdict {
  caseId: string;
  repo: string;
  prNumber: number;
  winner: "a" | "b" | "tie" | "unstable";
  passes: PassResult[];
}

const renderOutput = (result: Result): string => {
  if (result.error) return `FAILED: ${result.error}`;
  const output = result.output;
  if (!output) return "FAILED: no output";
  if (output.status === "failed") return `FAILED: ${output.reason}`;

  const verdict = output.findings.length === 0 ? "approve" : "comment";
  const lines: string[] = [`Verdict: ${verdict}`, `Summary: ${output.summary}`, ""];

  if (output.findings.length > 0) {
    lines.push("Findings:");
    for (const f of output.findings) {
      const carried = f.priorFindingId ? ` (carries prior ${f.priorFindingId})` : "";
      lines.push(
        `- ${f.path}:${f.line} [${f.category}/${f.confidence}]${carried} ${f.body}`,
      );
      if (f.suggestion) lines.push(`  Suggestion: ${f.suggestion}`);
    }
  }

  return lines.join("\n");
};

const fenced = (text: string, lang = ""): string => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
};

const buildJudgePrompt = (
  bundle: Bundle,
  first: string,
  second: string,
): string =>
  [
    "Two PR reviews of the same pull request are shown below. Compare them using the rubric and record your verdict.",
    "",
    "## PR context",
    `Repo: ${bundle.repo}  PR #${bundle.prNumber}`,
    `Title: ${bundle.title}`,
    `Body: ${bundle.body}`,
    "",
    "## Changed files",
    bundle.changedFiles.join("\n"),
    "",
    "## Diff",
    fenced(bundle.diff, "diff"),
    "",
    ...(bundle.priorFindings.length > 0
      ? [
          "## Prior findings (from the bot's previous run on this PR)",
          "A review that carries one of these forward claims the issue is still present; one that omits it claims it is fixed.",
          ...bundle.priorFindings.map((f) => `- ${f.id} ${f.path}:${f.line} [${f.category}] ${f.body}`),
          "",
        ]
      : []),
    "You may rely only on the diff and changed files above when evaluating findings. Do not use outside knowledge of the codebase.",
    "",
    "## Output 1",
    first,
    "",
    "## Output 2",
    second,
    "",
    "Call record_verdict exactly once.",
  ].join("\n");

let rubricCache: string | undefined;
const getRubric = (): string => {
  rubricCache ??= readFileSync(join(__dirname, "rubric.md"), "utf-8");
  return rubricCache;
};

const mapWinner = (
  judgeWinner: string,
  aIsFirst: boolean,
): "a" | "b" | "tie" => {
  if (judgeWinner === "tie") return "tie";
  if (judgeWinner === "output_1") return aIsFirst ? "a" : "b";
  return aIsFirst ? "b" : "a";
};

const deriveOverallWinner = (
  passes: PassResult[],
): "a" | "b" | "tie" | "unstable" => {
  const aWins = passes.filter((p) => p.winner === "a").length;
  const bWins = passes.filter((p) => p.winner === "b").length;
  const tieCount = passes.filter((p) => p.winner === "tie").length;
  if (aWins > bWins && aWins > tieCount) return "a";
  if (bWins > aWins && bWins > tieCount) return "b";
  if (tieCount > aWins && tieCount > bWins) return "tie";
  return "unstable";
};

export const judgePair = async (args: {
  record: ReviewRecord;
  a: Result;
  b: Result;
  model: JudgeModel;
  passes?: number;
}): Promise<PairVerdict> => {
  const { record, a, b, model, passes: passCount = 4 } = args;
  const rubric = getRubric();
  const bundle = record.bundle;
  const renderedA = renderOutput(a);
  const renderedB = renderOutput(b);

  const passResults: PassResult[] = [];

  for (let i = 0; i < passCount; i++) {
    const aIsFirst = i % 2 === 0;
    const first = aIsFirst ? renderedA : renderedB;
    const second = aIsFirst ? renderedB : renderedA;
    const order = aIsFirst ? ("a=1,b=2" as const) : ("a=2,b=1" as const);

    const response = await model({
      system: rubric,
      prompt: buildJudgePrompt(bundle, first, second),
    });

    if (!response.toolInput) {
      passResults.push({
        order,
        winner: "tie",
        margin: "tie",
        deciding_criterion: "judge returned no verdict",
        rationale: `judge returned no tool call (stop: ${response.stopReason})`,
      });
      continue;
    }

    const data = response.toolInput as {
      winner?: string;
      margin?: string;
      deciding_criterion?: string;
      rationale?: string;
    };

    const rawWinner = data.winner ?? "tie";
    const winner = mapWinner(rawWinner, aIsFirst);
    const margin = winner === "tie" ? "tie" : (data.margin ?? "tie");

    passResults.push({
      order,
      winner,
      margin,
      deciding_criterion: String(data.deciding_criterion ?? ""),
      rationale: String(data.rationale ?? ""),
    });
  }

  return {
    caseId: record.runId,
    repo: record.repo,
    prNumber: record.prNumber,
    winner: deriveOverallWinner(passResults),
    passes: passResults,
  };
};

export const judgeAll = async (
  records: ReviewRecord[],
  resultsA: Result[],
  resultsB: Result[],
  model: JudgeModel,
  passes = 4,
): Promise<PairVerdict[]> => {
  const aById = new Map(resultsA.map((r) => [r.caseId, r]));
  const bById = new Map(resultsB.map((r) => [r.caseId, r]));

  const verdicts: PairVerdict[] = [];
  for (const record of records) {
    const a = aById.get(record.runId);
    const b = bById.get(record.runId);
    if (!a || !b) {
      console.warn(
        `judgeAll: skipping ${record.runId} (missing on ${!a ? "a" : "b"} side)`,
      );
      continue;
    }
    verdicts.push(await judgePair({ record, a, b, model, passes }));
  }
  return verdicts;
};

export { VERDICT_TOOL };
