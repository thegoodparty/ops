import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CANDIDATE_FILES, codeOutsideLiterals, disallowedChanges, publishRun, redactGate, validateBranch, validateBudget, validateIds, validateRunId } from "./dispatch";
import type { ExpectedCase, Gate } from "./expect";

const raw = (status: string, path: string, mode = "100644") =>
  `:100644 ${mode} 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 ${status}\t${path}`;

test("the two reviewer files may change", () => {
  assert.deepEqual(disallowedChanges(CANDIDATE_FILES.map((f) => raw("M", f)).join("\n") + "\n"), []);
});

test("an empty diff is allowed", () => {
  assert.deepEqual(disallowedChanges(""), []);
});

test("a change to the scorer is refused even beside an allowed file", () => {
  const diff = [raw("M", CANDIDATE_FILES[0]), raw("M", "delegate/review/eval/expect.ts")].join("\n");
  assert.deepEqual(disallowedChanges(diff), ["delegate/review/eval/expect.ts"]);
});

test("the workflow, manifests and package files are refused", () => {
  const paths = [".github/workflows/delegate-eval-run.yml", "delegate/review/eval/expected/manifest.json", "package.json"];
  assert.deepEqual(disallowedChanges(paths.map((p) => raw("M", p)).join("\n")), paths);
});

test("a rename out of a reviewer file shows as a delete and is refused", () => {
  assert.deepEqual(disallowedChanges(raw("D", CANDIDATE_FILES[1])), [CANDIDATE_FILES[1]]);
});

test("a reviewer file turned into a symlink is refused", () => {
  assert.deepEqual(disallowedChanges(raw("M", CANDIDATE_FILES[0], "120000")), [CANDIDATE_FILES[0]]);
});

test("a line that is not raw diff output is refused, not skipped", () => {
  assert.deepEqual(disallowedChanges("garbage"), ["garbage"]);
});

test("branch names", () => {
  assert.equal(validateBranch("hill-climb/run-1.a_b"), null);
  for (const bad of ["", "-x", "a b", "a;b", "a$(x)", "a..b", "a\nb"]) assert.notEqual(validateBranch(bad), null, bad);
});

test("run ids", () => {
  assert.equal(validateRunId("climb-2026-10-27"), null);
  for (const bad of ["", "A", "a/b", "a_b", "a".repeat(65)]) assert.notEqual(validateRunId(bad), null, bad);
});

test("budgets", () => {
  assert.equal(validateBudget("150"), null);
  assert.equal(validateBudget("12.5"), null);
  for (const bad of ["", "0", "-1", "1e9", "NaN", "$5"]) assert.notEqual(validateBudget(bad), null, bad);
});

const mk = (id: string, split: "tune" | "holdout"): ExpectedCase =>
  ({ id, split, expect: { verdict: "approve" }, tests: "t", source: "simulated", kind: "bug", bundle: "b.json" }) as ExpectedCase;
const manifest = [mk("t1", "tune"), mk("t2", "tune"), mk("h1", "holdout")];

test("ids must exist, and a holdout case cannot be named where tune is required", () => {
  assert.equal(validateIds("cases", ["t1", "t2"], manifest, "tune"), null);
  assert.match(validateIds("cases", ["nope"], manifest) ?? "", /nope/);
  assert.match(validateIds("targets", ["t1", "h1"], manifest, "tune") ?? "", /h1/);
  assert.equal(validateIds("cases", ["h1"], manifest), null);
});

const gateCase = (id: string, split: "tune" | "holdout", outcome: Gate["cases"][number]["outcome"], candPassed: number) => ({
  id, split, mainPassed: 3, mainCompleted: 3, flaky: false, candPassed, candRuns: 3, outcome,
});

test("the redacted gate carries holdout as counts only", () => {
  const gate: Gate = {
    regressions: ["t1", "h1"],
    rerun: ["h2"],
    targetsMissed: ["t2"],
    costRatio: 1.2,
    costOver: true,
    pass: false,
    cases: [
      gateCase("t1", "tune", "regression", 1),
      gateCase("t2", "tune", "pass", 3),
      gateCase("h1", "holdout", "regression", 0),
      gateCase("h2", "holdout", "rerun", 2),
      gateCase("h3", "holdout", "pass", 3),
    ],
  };
  const red = redactGate(gate);
  assert.deepEqual(red.regressions, ["t1"]);
  assert.deepEqual(red.rerun, []);
  assert.deepEqual(red.targetsMissed, ["t2"]);
  assert.deepEqual(red.cases.map((c) => c.id), ["t1", "t2"]);
  assert.deepEqual(red.holdout, { total: 3, passed: 1, regressions: 1 });
  assert.equal(red.pass, false);
  assert.doesNotMatch(JSON.stringify(red), /h1|h2|h3/);
});

test("publish copies tune results and the redacted gate, never holdout results", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-publish-"));
  const inDir = join(root, "in");
  for (const c of ["t1", "h1"]) {
    mkdirSync(join(inDir, c), { recursive: true });
    writeFileSync(join(inDir, c, "run-1.json"), "{}");
  }
  writeFileSync(join(inDir, "t1", "notes.txt"), "extra");
  writeFileSync(join(inDir, "report.md"), "report");
  writeFileSync(
    join(inDir, "gate.json"),
    JSON.stringify({
      regressions: ["h1"], rerun: [], targetsMissed: [], costRatio: null, costOver: false, pass: false,
      cases: [gateCase("t1", "tune", "pass", 3), gateCase("h1", "holdout", "regression", 0)],
    }),
  );
  const out = join(root, "out");
  publishRun(manifest, inDir, out);
  assert.equal(existsSync(join(out, "t1", "run-1.json")), true);
  assert.equal(existsSync(join(out, "t1", "notes.txt")), false);
  assert.equal(existsSync(join(out, "h1")), false);
  assert.equal(readFileSync(join(out, "report.md"), "utf-8"), "report");
  assert.doesNotMatch(readFileSync(join(out, "gate.json"), "utf-8"), /h1/);
});

const SRC = [
  'import { query } from "@anthropic-ai/claude-agent-sdk";',
  'export const MODEL = "claude-sonnet-4-5";',
  'export const TOOLS = ["Read", "Grep"];',
  "export const prompt = (name: string) => `Review ${name.toUpperCase()} carefully.`;",
  "",
].join("\n");

test("identical sources pass", () => {
  assert.equal(codeOutsideLiterals(SRC, SRC), null);
});

test("changed string and template literal text passes", () => {
  const next = SRC.replace("Review ", "Look hard at ").replace(" carefully.", " and be terse.").replace('"Grep"', '"Glob"');
  assert.equal(codeOutsideLiterals(SRC, next), null);
});

test("a changed model id string passes", () => {
  assert.equal(codeOutsideLiterals(SRC, SRC.replace("claude-sonnet-4-5", "claude-opus-4-1")), null);
});

test("comment and whitespace changes pass", () => {
  assert.equal(codeOutsideLiterals(SRC, `// note\n${SRC.replace("= ", "=  ")}`), null);
});

test("a changed ${} expression is refused", () => {
  assert.match(codeOutsideLiterals(SRC, SRC.replace("name.toUpperCase()", "process.env.X")) ?? "", /differs/);
});

test("an added statement is refused", () => {
  assert.notEqual(codeOutsideLiterals(SRC, `${SRC}writeFileSync("run-1.json", "{}");\n`), null);
});

test("an added import is refused", () => {
  assert.notEqual(codeOutsideLiterals(SRC, `import fs from "node:fs";\n${SRC}`), null);
});

test("a changed import specifier is refused", () => {
  assert.notEqual(codeOutsideLiterals(SRC, SRC.replace("@anthropic-ai/claude-agent-sdk", "../eval/expected/manifest.json")), null);
});

test("a changed identifier is refused", () => {
  assert.notEqual(codeOutsideLiterals(SRC, SRC.replace("MODEL", "MODEL2")), null);
});

test("an unparseable branch is refused", () => {
  assert.match(codeOutsideLiterals(SRC, `${SRC}const = ;`) ?? "", /does not parse/);
});

test("the reason never contains file content", () => {
  const reason = codeOutsideLiterals(SRC, SRC.replace("name.toUpperCase()", "SECRET_VALUE"));
  assert.doesNotMatch(reason ?? "", /SECRET_VALUE|toUpperCase/);
});
