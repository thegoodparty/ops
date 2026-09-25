import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
const GREP_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 100000;
const TRUNCATION_MARKER = "\n[truncated]";
const JSON_SCAN_LIMIT = 50;
const LIST_ENTRY_LIMIT = 500;
const GREP_MAX_COUNT_PER_FILE = 20;
const GREP_MAX_LINES = 400;

// The Claude subagents that share these prompts run with Bash. This process
// does not: it drives a model over PR content nobody has vetted, in a child
// that shares the worker's UID, so an env allowlist alone would never have
// held. Withholding execution is what makes the confinement real.
const NO_SHELL_SUFFIX = `

## Your tools

This run has no shell. Your tools are \`read_file\`, \`list_files\`, \`grep\` and \`read_diff\` — all read-only, all confined to the PR checkout. Where the instructions above assume shell access, \`gh\`, or running a formatter or any other command, use these tools instead. Their absence is expected. It is not a failure, and it is not a reason to abort the review or to report that you could not do it.`;

const TOOLS: ResponsesTool[] = [
  {
    type: "function",
    name: "read_file",
    description:
      "Read a UTF-8 text file in the PR checkout. Returns the whole file unless offset/limit are given, truncated to 100000 characters.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to the PR checkout root.",
        },
        offset: {
          type: "integer",
          description: "1-indexed first line to return. Defaults to 1.",
        },
        limit: {
          type: "integer",
          description:
            "Maximum number of lines to return. Defaults to the rest of the file.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_files",
    description:
      "List the directory entries at a path in the PR checkout. Directories are suffixed with a slash.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory path relative to the PR checkout root. Defaults to the root.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "grep",
    description:
      "Regex search the PR checkout with ripgrep. Returns file:line:match rows.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regex to search for." },
        path: {
          type: "string",
          description:
            "File or directory to search, relative to the PR checkout root. Defaults to the root.",
        },
        glob: {
          type: "string",
          description: "Optional glob to restrict which files are searched.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_diff",
    description:
      "Read the unified diff of the PR under review, truncated to 100000 characters.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

const execFileAsync = promisify(execFile);

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const truncateOutput = (text: string): string =>
  text.length <= OUTPUT_LIMIT
    ? text
    : text.slice(0, OUTPUT_LIMIT - TRUNCATION_MARKER.length) +
      TRUNCATION_MARKER;

const isInside = (root: string, target: string): boolean =>
  target === root || target.startsWith(root + path.sep);

// realpathSync throws on a path that does not exist yet, which is a legitimate
// thing for the model to ask about, so resolve the deepest existing ancestor
// and re-attach the rest.
const realpathOfNearestExisting = (target: string): string => {
  const suffix: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
};

export type ConfinedPath = { path: string } | { error: string };

export const resolveInRoot = (
  root: string,
  candidate: string
): ConfinedPath => {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, candidate);
  const outside = `[error: ${candidate} resolves outside the PR checkout — every path must be inside it]`;

  // Rejected before anything else, because `path.resolve` collapses `..`
  // lexically while the kernel would walk it after each symlink. Those two
  // disagree on `link/../x`, and reasoning about which one wins is exactly the
  // kind of subtlety that rots into a traversal bug. Nothing here needs `..`:
  // every path is addressed from the checkout root.
  if (candidate.split(/[/\\]/).includes(".."))
    return {
      error: `[error: ${candidate} contains a '..' segment — address paths from the PR checkout root instead]`,
    };

  if (!isInside(rootResolved, resolved)) return { error: outside };
  if (
    !isInside(
      realpathOfNearestExisting(rootResolved),
      realpathOfNearestExisting(resolved)
    )
  )
    return { error: outside };
  return { path: resolved };
};

const positiveInt = (value: unknown): number | undefined => {
  const parsed =
    typeof value === "number" || typeof value === "string"
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
};

export const readFileTool = (
  root: string,
  args: Record<string, unknown>
): string => {
  const requested = typeof args.path === "string" ? args.path : "";
  if (requested.trim() === "") return "[error: read_file needs a path]";
  const resolved = resolveInRoot(root, requested);
  if ("error" in resolved) return resolved.error;

  try {
    const text = fs.readFileSync(resolved.path, "utf8");
    const offset = positiveInt(args.offset);
    const limit = positiveInt(args.limit);
    if (offset === undefined && limit === undefined) return truncateOutput(text);
    const lines = text.split("\n");
    const start = (offset ?? 1) - 1;
    const end = limit === undefined ? lines.length : start + limit;
    return truncateOutput(lines.slice(start, end).join("\n"));
  } catch (err) {
    return `[error: ${errorMessage(err)}]`;
  }
};

const listFilesTool = (root: string, args: Record<string, unknown>): string => {
  const requested =
    typeof args.path === "string" && args.path.trim() !== "" ? args.path : ".";
  const resolved = resolveInRoot(root, requested);
  if ("error" in resolved) return resolved.error;

  try {
    const names = fs
      .readdirSync(resolved.path, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
    const shown = names.slice(0, LIST_ENTRY_LIMIT).join("\n");
    return names.length > LIST_ENTRY_LIMIT
      ? `${shown}\n[truncated: ${names.length} entries, showing the first ${LIST_ENTRY_LIMIT}]`
      : shown;
  } catch (err) {
    return `[error: ${errorMessage(err)}]`;
  }
};

// execFile, never a shell: the pattern, path and glob are model-supplied and
// arrive as argv entries, so nothing in them can be read as shell syntax.
const grepTool = async (
  root: string,
  args: Record<string, unknown>
): Promise<string> => {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (pattern === "") return "[error: grep needs a pattern]";
  const requested =
    typeof args.path === "string" && args.path.trim() !== "" ? args.path : ".";
  const resolved = resolveInRoot(root, requested);
  if ("error" in resolved) return resolved.error;

  const rgArgs = [
    "--line-number",
    "--with-filename",
    "--max-count",
    String(GREP_MAX_COUNT_PER_FILE),
  ];
  if (typeof args.glob === "string" && args.glob.trim() !== "")
    rgArgs.push("--glob", args.glob);
  rgArgs.push("--", pattern, resolved.path);

  try {
    const { stdout } = await execFileAsync("rg", rgArgs, {
      cwd: root,
      timeout: GREP_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const lines = stdout.split("\n");
    return truncateOutput(
      lines.length <= GREP_MAX_LINES
        ? stdout
        : `${lines.slice(0, GREP_MAX_LINES).join("\n")}\n[truncated to the first ${GREP_MAX_LINES} matching lines]`
    );
  } catch (err) {
    const failure = err as {
      code?: number | string;
      killed?: boolean;
      stderr?: string;
      message?: string;
    };
    if (failure.code === 1) return "[no matches]";
    if (failure.killed === true) return "[error: grep timed out]";
    return `[error: grep failed: ${failure.stderr?.trim() || failure.message || "unknown"}]`;
  }
};

const readDiffTool = (): string => {
  try {
    return truncateOutput(
      fs.readFileSync(process.env.PR_DIFF_FILE || "/app/pr-diff.patch", "utf8")
    );
  } catch (err) {
    return `[error: ${errorMessage(err)}]`;
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

// Reports rawCount for the same reason normalizeLeads does: a deep-reviewer
// whose findings all fail normalization must not be recorded as a clean pass
// with nothing to say, because the orchestrator's approve gate reads a clean
// pass as coverage it actually got.
export const normalizeFindings = (
  raw: unknown,
  leadArea: string,
  leadCategory: string
): { findings: SecondOpinionFinding[]; rawCount: number } => {
  const findings: SecondOpinionFinding[] = [];
  const entries = arrayFrom(raw, "findings");

  for (const entry of entries) {
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

  return { findings, rawCount: entries.length };
};

export const normalizeLeads = (
  raw: unknown,
  maxLeads: number
): { leads: Lead[]; rawCount: number } => {
  const entries = arrayFrom(raw, "leads");
  const leads: Lead[] = [];

  for (const entry of entries) {
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

  return { leads, rawCount: entries.length };
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

const runTool = async (
  name: unknown,
  rawArgs: unknown,
  root: string
): Promise<string> => {
  const args = isRecord(rawArgs) ? rawArgs : {};
  switch (name) {
    case "read_file":
      return readFileTool(root, args);
    case "list_files":
      return listFilesTool(root, args);
    case "grep":
      return grepTool(root, args);
    case "read_diff":
      return readDiffTool();
    default:
      return `[error: no tool named ${JSON.stringify(name)} — use read_file, list_files, grep or read_diff]`;
  }
};

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
      tools: TOOLS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    args.budget.spentUsd += usageCostUsd(reply.usage);

    input.push(...reply.output);

    const text = messageText(reply.output);
    if (text !== "") lastText = text;

    const calls = reply.output.filter((item) => item.type === "function_call");
    if (calls.length === 0) return text !== "" ? text : lastText;

    for (const call of calls) {
      const callArgs =
        typeof call.arguments === "string"
          ? tryParse(call.arguments)
          : undefined;
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: await runTool(call.name, callArgs, args.cwd),
      });
    }
  }

  return lastText;
};

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
    if (!fs.existsSync(diffFile)) {
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
        instructions: SCOUT_PROMPT + NO_SHELL_SUFFIX,
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
    const { leads, rawCount } = normalizeLeads(scoutJson, maxLeads);
    // Dropping every lead is not the same outcome as the scout finding
    // nothing: one is a low-risk diff, the other is a pass that produced
    // nothing usable, and only the first may satisfy the approve gate.
    const leadsUnusable = rawCount > 0 && leads.length === 0;

    const settled = await Promise.allSettled(
      leads.map(async (lead) => {
        const text = await runToolLoop({
          region,
          model,
          maxUsd,
          cwd,
          instructions: DEEP_REVIEWER_PROMPT + NO_SHELL_SUFFIX,
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
        const { findings: leadFindings, rawCount: rawFindings } =
          normalizeFindings(parsed, lead.area, lead.category);
        if (rawFindings > 0 && leadFindings.length === 0) {
          throw new Error(
            `deep-reviewer for lead "${lead.area}" returned ${rawFindings} finding(s) but none were usable`
          );
        }
        return leadFindings;
      })
    );

    const findings: SecondOpinionFinding[] = [];
    let deepReviewerFailures = 0;
    // Carried into `error` below: the orchestrator gates on the count alone,
    // but without a reason a recurring failure can only be diagnosed by
    // reading the task logs.
    let firstFailure = "";
    for (const result of settled) {
      if (result.status === "fulfilled") findings.push(...result.value);
      else {
        deepReviewerFailures++;
        if (firstFailure === "") firstFailure = errorMessage(result.reason);
      }
    }

    return {
      status: "ok",
      model,
      leads: leads.length,
      findings,
      deepReviewersDispatched: leads.length,
      deepReviewerFailures,
      scoutFailed: leadsUnusable,
      summary,
      costUsd: budget.spentUsd,
      durationMs: Date.now() - startedAt,
      ...(leadsUnusable
        ? {
            error: `the scout returned ${rawCount} lead(s) but none were usable — every entry was missing the paths a deep-reviewer needs`,
          }
        : firstFailure !== ""
          ? { error: `first deep-reviewer failure: ${firstFailure}` }
          : {}),
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
