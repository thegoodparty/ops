import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import {
  DEEP_REVIEWER_PROMPT,
  SCOUT_PROMPT,
} from "../agents/pr-reviewer-subagents";
import {
  callResponses,
  usageCostUsd,
  type ResponsesItem,
  type ResponsesTool,
} from "./bedrock-responses";
import type { SecondOpinionFinding, SecondOpinionResult } from "./types";

export type Lead = {
  area: string;
  category: string;
  paths: string[];
  lineRange: string | null;
  hypothesis: string;
};

const MAX_TURNS = 30;
const MAX_OUTPUT_TOKENS = 16000;
const BASH_TIMEOUT_MS = 60_000;
const BASH_OUTPUT_LIMIT = 100000;
const TRUNCATION_MARKER = "\n[truncated]";
const JSON_SCAN_LIMIT = 50;

const BASH_TOOL: ResponsesTool = {
  type: "function",
  name: "bash",
  description:
    "Run a shell command in the PR checkout. Returns combined stdout and stderr, truncated to 100000 characters.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

const execFileAsync = promisify(execFile);

const truncateOutput = (text: string): string =>
  text.length <= BASH_OUTPUT_LIMIT
    ? text
    : text.slice(0, BASH_OUTPUT_LIMIT - TRUNCATION_MARKER.length) +
      TRUNCATION_MARKER;

const runBash = async (command: string, cwd: string): Promise<string> => {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], {
      cwd,
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return truncateOutput(`${stdout}${stderr}`);
  } catch (err) {
    const failure = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      message?: string;
    };
    const combined = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    const note =
      failure.killed === true
        ? "[command timed out]"
        : `[command exited with code ${String(failure.code ?? "unknown")}]`;
    const detail = combined.trim() === "" ? failure.message ?? "" : combined;
    return truncateOutput(`${detail}\n${note}`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const tryParse = (candidate: string): unknown | undefined => {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
};

export const extractJson = (text: string): unknown | undefined => {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let i = fenced.length - 1; i >= 0; i--) {
    const parsed = tryParse(fenced[i][1]);
    if (parsed !== undefined) return parsed;
  }

  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = tryParse(lines[i]);
    if (parsed !== undefined) return parsed;
  }

  // Bounded on purpose: an unbounded scan would attempt one parse per `{` in
  // the text, each over a slice of it, which is quadratic on a long reply.
  const close = text.lastIndexOf("}");
  const opens: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") opens.push(i);
  }
  for (const open of opens.slice(-JSON_SCAN_LIMIT).reverse()) {
    const parsed = tryParse(text.slice(open, close + 1));
    if (parsed !== undefined) return parsed;
  }

  return undefined;
};

const arrayFrom = (raw: unknown, key: string): unknown[] => {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw[key])) return raw[key] as unknown[];
  return [];
};

export const normalizeFindings = (
  raw: unknown,
  leadArea: string,
  leadCategory: string
): SecondOpinionFinding[] => {
  const findings: SecondOpinionFinding[] = [];

  for (const entry of arrayFrom(raw, "findings")) {
    if (!isRecord(entry)) continue;

    const file = typeof entry.file === "string" ? entry.file.trim() : "";
    const body = typeof entry.body === "string" ? entry.body.trim() : "";
    if (file === "" || body === "") continue;

    const rawLine = entry.line;
    if (typeof rawLine !== "number" && typeof rawLine !== "string") continue;
    const line = Number(rawLine);
    if (!Number.isInteger(line) || line < 1) continue;

    const severity = entry.severity;
    if (severity !== "blocker" && severity !== "concern" && severity !== "nit")
      continue;

    const finding: SecondOpinionFinding = {
      file,
      line,
      severity,
      body,
      leadArea,
      leadCategory,
    };

    const rawStartLine = entry.startLine;
    if (typeof rawStartLine === "number" || typeof rawStartLine === "string") {
      const startLine = Number(rawStartLine);
      if (Number.isInteger(startLine) && startLine >= 1)
        finding.startLine = startLine;
    }

    findings.push(finding);
  }

  return findings;
};

export const normalizeLeads = (raw: unknown, maxLeads: number): Lead[] => {
  const leads: Lead[] = [];

  for (const entry of arrayFrom(raw, "leads")) {
    if (leads.length >= maxLeads) break;
    if (!isRecord(entry)) continue;

    const paths = (Array.isArray(entry.paths) ? entry.paths : []).filter(
      (path): path is string => typeof path === "string" && path.trim() !== ""
    );
    if (paths.length === 0) continue;

    leads.push({
      area:
        typeof entry.area === "string" && entry.area.trim() !== ""
          ? entry.area
          : "unnamed area",
      category:
        typeof entry.category === "string" && entry.category.trim() !== ""
          ? entry.category
          : "correctness",
      paths,
      lineRange:
        typeof entry.lineRange === "string" && entry.lineRange.trim() !== ""
          ? entry.lineRange
          : null,
      hypothesis:
        typeof entry.hypothesis === "string" ? entry.hypothesis : "",
    });
  }

  return leads;
};

const messageText = (items: ResponsesItem[]): string =>
  items
    .filter((item) => item.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter(
      (part): part is { type: string; text: string } =>
        isRecord(part) &&
        part.type === "output_text" &&
        typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("\n");

// Shared by every loop in the run, so it caps the pass rather than a single
// reviewer. Deliberately a soft ceiling: deep-reviewers run in parallel and all
// check it before their next request, so a run can overshoot by up to one turn
// each. Holding a hard cap would mean serializing them, which costs more wall
// time than the overshoot costs money.
type Budget = { spentUsd: number };

const runToolLoop = async (args: {
  region: string;
  model: string;
  maxUsd: number;
  cwd: string;
  instructions: string;
  userPrompt: string;
  budget: Budget;
}): Promise<string> => {
  const input: ResponsesItem[] = [
    { role: "user", content: [{ type: "input_text", text: args.userPrompt }] },
  ];
  let lastText = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (args.budget.spentUsd >= args.maxUsd) {
      throw new Error(
        `second-opinion budget of $${args.maxUsd} exhausted (spent $${args.budget.spentUsd.toFixed(2)})`
      );
    }

    const reply = await callResponses({
      region: args.region,
      model: args.model,
      instructions: args.instructions,
      input,
      tools: [BASH_TOOL],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    args.budget.spentUsd += usageCostUsd(reply.usage);

    input.push(...reply.output);

    const text = messageText(reply.output);
    if (text !== "") lastText = text;

    const calls = reply.output.filter((item) => item.type === "function_call");
    if (calls.length === 0) return text !== "" ? text : lastText;

    for (const call of calls) {
      const parsedArgs =
        typeof call.arguments === "string"
          ? (tryParse(call.arguments) as { command?: unknown } | undefined)
          : undefined;
      const command =
        parsedArgs && typeof parsedArgs.command === "string"
          ? parsedArgs.command
          : undefined;
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output:
          command === undefined
            ? "[no runnable command in the tool call arguments]"
            : await runBash(command, args.cwd),
      });
    }
  }

  return lastText;
};

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export const runSecondOpinion = async (): Promise<SecondOpinionResult> => {
  const startedAt = Date.now();
  const model = process.env.SECOND_OPINION_MODEL || "us.openai.gpt-5.6-sol";

  try {
    if (process.env.SECOND_OPINION_ENABLED === "false") {
      return {
        status: "disabled",
        model,
        leads: 0,
        findings: [],
        deepReviewersDispatched: 0,
        deepReviewerFailures: 0,
        scoutFailed: false,
        summary: "",
        costUsd: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    const region =
      process.env.SECOND_OPINION_REGION ||
      process.env.AWS_REGION ||
      "us-west-2";
    const maxUsd = Number(process.env.SECOND_OPINION_MAX_USD) || 6;
    const maxLeads = Number(process.env.SECOND_OPINION_MAX_LEADS) || 10;
    // The worker captures the diff for us because this process holds no
    // GitHub token. Without it there is no `gh` to fall back to, and a review
    // of the tree with no diff is worse than no second opinion at all — it
    // looks like a clean pass.
    const diffFile = process.env.PR_DIFF_FILE || "/app/pr-diff.patch";
    if (!existsSync(diffFile)) {
      throw new Error(
        `no PR diff at ${diffFile} — the worker's diff capture must have failed`
      );
    }
    const cwd = process.env.REVIEW_DIR || "/app/review";
    const repo = process.env.REVIEW_REPO || "";
    const prNumber = process.env.REVIEW_PR_NUMBER || "";
    const budget: Budget = { spentUsd: 0 };

    let scoutText = "";
    let scoutError: string | undefined;
    try {
      scoutText = await runToolLoop({
        region,
        model,
        maxUsd,
        cwd,
        instructions: SCOUT_PROMPT,
        userPrompt: `You are scouting PR ${prNumber} in repo ${repo}. The PR is already checked out in your current working directory, pinned to the reviewed head SHA. The full diff is at ${diffFile}. Read the root CLAUDE.md, read the diff, skim touched files in context, and emit 3–10 investigation leads per your output contract.`,
        budget,
      });
    } catch (err) {
      scoutError = errorMessage(err);
    }

    const scoutJson = scoutError === undefined ? extractJson(scoutText) : undefined;
    if (scoutJson === undefined) {
      return {
        status: "ok",
        model,
        leads: 0,
        findings: [],
        deepReviewersDispatched: 0,
        deepReviewerFailures: 0,
        scoutFailed: true,
        summary: "",
        costUsd: budget.spentUsd,
        durationMs: Date.now() - startedAt,
        ...(scoutError === undefined ? {} : { error: scoutError }),
      };
    }

    const summary =
      isRecord(scoutJson) && typeof scoutJson.summary === "string"
        ? scoutJson.summary
        : "";
    const leads = normalizeLeads(scoutJson, maxLeads);

    const settled = await Promise.allSettled(
      leads.map(async (lead) => {
        const text = await runToolLoop({
          region,
          model,
          maxUsd,
          cwd,
          instructions: DEEP_REVIEWER_PROMPT,
          userPrompt: `You are deep-reviewing one lead from the scout's pass on PR ${prNumber} in repo ${repo}. The PR is already checked out in your current working directory, pinned to the reviewed head SHA. The full diff is at ${diffFile}. Read the cited paths in full, apply your category lens, run the disprove-it pass, and return findings per your output contract.

<lead>
<area>${lead.area}</area>
<category>${lead.category}</category>
<paths>${lead.paths.join("\n")}</paths>
<lineRange>${lead.lineRange ?? "all"}</lineRange>
<hypothesis>${lead.hypothesis}</hypothesis>
</lead>`,
          budget,
        });
        const parsed = extractJson(text);
        if (parsed === undefined) {
          throw new Error(
            `deep-reviewer for lead "${lead.area}" returned no parseable JSON`
          );
        }
        return normalizeFindings(parsed, lead.area, lead.category);
      })
    );

    const findings: SecondOpinionFinding[] = [];
    let deepReviewerFailures = 0;
    for (const result of settled) {
      if (result.status === "fulfilled") findings.push(...result.value);
      else deepReviewerFailures++;
    }

    return {
      status: "ok",
      model,
      leads: leads.length,
      findings,
      deepReviewersDispatched: leads.length,
      deepReviewerFailures,
      scoutFailed: false,
      summary,
      costUsd: budget.spentUsd,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      status: "failed",
      model,
      leads: 0,
      findings: [],
      deepReviewersDispatched: 0,
      deepReviewerFailures: 0,
      scoutFailed: false,
      summary: "",
      costUsd: 0,
      durationMs: Date.now() - startedAt,
      error: errorMessage(err),
    };
  }
};
