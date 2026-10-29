import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { ExpectedCase, Gate, GateCase } from "./expect";
import { RUN_ID_PATTERN } from "./ledger";

// delegate-eval-run.yml measures a candidate branch that may change only the
// reviewer's prompts. Everything else the measurement runs, and everything that
// scores it, comes from main.
export const CANDIDATE_FILES = ["delegate/agents/pr-reviewer.ts", "delegate/agents/pr-reviewer-subagents.ts"];

const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;

export const validateBranch = (branch: string): string | null => {
  if (!BRANCH_PATTERN.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    return "branch must match ^[A-Za-z0-9._/-]+$, not start with '-' and not contain '..'";
  }
  return null;
};

export const validateRunId = (runId: string): string | null =>
  RUN_ID_PATTERN.test(runId) ? null : "run_id must match ^[a-z0-9-]{1,64}$";

export const validateBudget = (budget: string): string | null => {
  const n = Number(budget);
  return /^\d+(\.\d+)?$/.test(budget) && n > 0 ? null : "budget_usd must be a positive number";
};

export const parseIds = (csv: string): string[] => (csv === "" ? [] : csv.split(","));

// Ids must exist in main's manifest, and targets must be tune cases: a target
// is reported back by name, so naming a holdout case would reveal it.
export const validateIds = (
  field: string,
  ids: string[],
  manifest: ExpectedCase[],
  only?: ExpectedCase["split"],
): string | null => {
  const known = new Map(manifest.map((c) => [c.id, c]));
  const bad = ids.filter((id) => {
    const c = known.get(id);
    return !c || (only !== undefined && c.split !== only);
  });
  return bad.length === 0 ? null : `${field} has ids that are not ${only ?? "known"} cases: ${bad.join(", ")}`;
};

// Reads `git diff --raw --no-renames` between the merge base and the
// candidate. A rename shows up as a delete plus an add so the old path cannot
// hide, and the mode check refuses a symlink or submodule swapped in for one of
// the two files.
export const disallowedChanges = (rawDiff: string): string[] =>
  rawDiff
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const m = /^:\d+ (\d+) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*\t(.+)$/.exec(line);
      if (!m) return [line];
      const [, newMode, status, path] = m;
      return CANDIDATE_FILES.includes(path) && status === "M" && newMode === "100644" ? [] : [path];
    });

export interface RedactedGate {
  pass: boolean;
  regressions: string[];
  rerun: string[];
  targetsMissed: string[];
  costRatio: number | null;
  costOver: boolean;
  cases: GateCase[];
  holdout: { total: number; passed: number; regressions: number };
}

// The gate artifact is downloadable by whoever dispatches, and holdout cases
// must stay hidden from them: only counts survive, no ids or per-case results.
export const redactGate = (gate: Gate): RedactedGate => {
  const holdout = gate.cases.filter((c) => c.split === "holdout");
  const holdoutIds = new Set(holdout.map((c) => c.id));
  const visible = (ids: string[]) => ids.filter((id) => !holdoutIds.has(id));
  return {
    pass: gate.pass,
    regressions: visible(gate.regressions),
    rerun: visible(gate.rerun),
    targetsMissed: visible(gate.targetsMissed),
    costRatio: gate.costRatio,
    costOver: gate.costOver,
    cases: gate.cases.filter((c) => c.split === "tune"),
    holdout: {
      total: holdout.length,
      passed: holdout.filter((c) => c.candRuns > 0 && c.candPassed === c.candRuns).length,
      regressions: holdout.filter((c) => c.outcome === "regression").length,
    },
  };
};

// Builds what the run uploads: the tune cases' results, the masked report and
// the redacted gate. Holdout results never leave the job, so the artifact is
// safe to hand to whoever dispatched.
export const publishRun = (manifest: ExpectedCase[], inDir: string, outDir: string): void => {
  const tune = new Set(manifest.filter((c) => c.split === "tune").map((c) => c.id));
  mkdirSync(outDir, { recursive: true });
  for (const d of readdirSync(inDir, { withFileTypes: true })) {
    if (!d.isDirectory() || !tune.has(d.name)) continue;
    mkdirSync(join(outDir, d.name), { recursive: true });
    for (const f of readdirSync(join(inDir, d.name)).filter((n) => /^run-\d+\.json$/.test(n))) {
      cpSync(join(inDir, d.name, f), join(outDir, d.name, f));
    }
  }
  if (existsSync(join(inDir, "report.md"))) cpSync(join(inDir, "report.md"), join(outDir, "report.md"));
  const gatePath = join(inDir, "gate.json");
  if (existsSync(gatePath)) {
    const gate = JSON.parse(readFileSync(gatePath, "utf-8")) as Gate;
    writeFileSync(join(outDir, "gate.json"), JSON.stringify(redactGate(gate), null, 2));
  }
};

const LITERAL_TEXT_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

// A string that picks what gets loaded or which property is read is code, not
// prompt text: "../eval/expected/manifest.json" or obj["x"] would change what runs.
const isCodeString = (node: ts.Node): boolean => {
  const literal =
    ts.isTemplateHead(node) ? node.parent
    : ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.parent.parent
    : node;
  const p = literal.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isImportTypeNode(p) || ts.isLiteralTypeNode(p) || ts.isElementAccessExpression(p)) return true;
  return (
    ts.isCallExpression(p) &&
    (p.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(p.expression) && p.expression.text === "require"))
  );
};

const tokenStream = (source: string): string[] | null => {
  const parsed = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ESNext } });
  if ((parsed.diagnostics ?? []).length > 0) return null;
  const sf = ts.createSourceFile("candidate.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const walk = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sf);
    if (children.length > 0) {
      children.forEach(walk);
      return;
    }
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
    out.push(LITERAL_TEXT_KINDS.has(node.kind) && !isCodeString(node) ? `${node.kind}:*` : `${node.kind}:${node.getText(sf)}`);
  };
  walk(sf);
  return out;
};

// Returns a reason (never file content) when the two sources differ anywhere but
// in the text of string and template literals. Whitespace and comments cannot
// run, so they may change. `${...}` expressions are code and must match.
export const codeOutsideLiterals = (mainSrc: string, branchSrc: string): string | null => {
  const main = tokenStream(mainSrc);
  if (main === null) return "main's copy does not parse";
  const branch = tokenStream(branchSrc);
  if (branch === null) return "the branch's copy does not parse";
  const shared = Math.min(main.length, branch.length);
  for (let i = 0; i < shared; i++) {
    if (main[i] !== branch[i]) return `code outside string literals differs at token ${i + 1}`;
  }
  return main.length === branch.length ? null : "code outside string literals was added or removed";
};
