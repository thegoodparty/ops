import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { summarize, renderMarkdown } from "./report";
import type { PairVerdict } from "./judge";

const verdict = (
  winner: PairVerdict["winner"],
  repo = "thegoodparty/ops",
  prNumber = 42,
): PairVerdict => ({
  caseId: randomUUID(),
  repo,
  prNumber,
  winner,
  passes: [
    {
      order: "a=1,b=2",
      winner: winner === "a" || winner === "b" ? winner : "tie",
      margin: "better",
      deciding_criterion: "false approve",
      rationale: "reason",
    },
  ],
});

test("summarize counts winners correctly", () => {
  const verdicts = [verdict("a"), verdict("a"), verdict("b"), verdict("tie"), verdict("unstable")];
  const summary = summarize(verdicts);
  assert.equal(summary.a, 2);
  assert.equal(summary.b, 1);
  assert.equal(summary.ties, 1);
  assert.equal(summary.unstable, 1);
  assert.equal(summary.n, 5);
});

test("summarize sign test excludes ties and unstable", () => {
  const verdicts = [verdict("a"), verdict("a"), verdict("b"), verdict("tie"), verdict("unstable")];
  const summary = summarize(verdicts);
  assert.ok(summary.signTestP > 0 && summary.signTestP <= 1);
});

test("summarize sign test p=1 when no wins on either side", () => {
  const summary = summarize([verdict("tie"), verdict("unstable")]);
  assert.equal(summary.signTestP, 1);
});

test("summarize sign test p approaches significance at 10 wins vs 0 losses from 10 cases", () => {
  const verdicts = Array.from({ length: 10 }, () => verdict("a"));
  const summary = summarize(verdicts);
  assert.ok(summary.signTestP < 0.01, `expected p<0.01 for 10/10, got ${summary.signTestP}`);
});

test("summarize sign test 6-6 split produces p=1", () => {
  const verdicts = [
    ...Array.from({ length: 6 }, () => verdict("a")),
    ...Array.from({ length: 6 }, () => verdict("b")),
  ];
  const summary = summarize(verdicts);
  assert.equal(summary.signTestP, 1);
});

test("summarize sign test 10 vs 2 is statistically significant", () => {
  const verdicts = [
    ...Array.from({ length: 10 }, () => verdict("a")),
    ...Array.from({ length: 2 }, () => verdict("b")),
  ];
  const summary = summarize(verdicts);
  assert.ok(summary.signTestP < 0.05, `expected p<0.05 for 10/12, got ${summary.signTestP}`);
});

test("renderMarkdown contains header and summary table", () => {
  const verdicts = [verdict("a"), verdict("b"), verdict("tie")];
  const summary = summarize(verdicts);
  const md = renderMarkdown(summary, verdicts, { labelA: "main", labelB: "branch" });

  assert.ok(md.includes("PR-reviewer eval report"), "should include title");
  assert.ok(md.includes("main"), "should include labelA");
  assert.ok(md.includes("branch"), "should include labelB");
  assert.ok(md.includes("Sign test"), "should include sign test line");
});

test("renderMarkdown includes per-case table rows with repo#pr", () => {
  const v = verdict("a", "thegoodparty/gp-webapp", 99);
  const summary = summarize([v]);
  const md = renderMarkdown(summary, [v], { labelA: "A", labelB: "B" });

  assert.ok(md.includes("thegoodparty/gp-webapp#99"), "should include repo#pr");
  assert.ok(md.includes(v.caseId), "should include case id");
});

test("renderMarkdown uses labelA and labelB for winner column", () => {
  const verdicts = [verdict("a"), verdict("b"), verdict("tie")];
  const summary = summarize(verdicts);
  const md = renderMarkdown(summary, verdicts, { labelA: "main", labelB: "branch" });

  const lines = md.split("\n").filter((l) => l.includes("| "));
  const dataRows = lines.slice(3);

  const aRow = dataRows.find((l) => l.includes("main") && !l.includes("branch"));
  const bRow = dataRows.find((l) => l.includes("branch") && !l.includes("main"));
  const tieRow = dataRows.find((l) => l.includes("| tie |"));
  assert.ok(aRow, "should have a row showing 'main' as winner");
  assert.ok(bRow, "should have a row showing 'branch' as winner");
  assert.ok(tieRow, "should have a row showing 'tie'");
});
