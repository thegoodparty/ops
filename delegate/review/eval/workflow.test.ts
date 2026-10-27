import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Structural checks on the dispatched eval's security properties, read from
// the workflow text so they fail in CI before a change to the file merges.
const workflows = join(__dirname, "..", "..", "..", ".github", "workflows");
const run = readFileSync(join(workflows, "delegate-eval-run.yml"), "utf-8");
const ledger = readFileSync(join(workflows, "delegate-eval-ledger.yml"), "utf-8");

const jobs = (text: string): Map<string, string> => {
  const body = text.slice(text.indexOf("\njobs:\n") + 1);
  const out = new Map<string, string>();
  let name: string | null = null;
  for (const line of body.split("\n").slice(1)) {
    const m = /^ {2}([a-z-]+):\s*$/.exec(line);
    if (m) {
      name = m[1];
      out.set(name, "");
    } else if (name && !/^\s*#/.test(line)) out.set(name, `${out.get(name)}${line}\n`);
  }
  return out;
};

const CANDIDATE_JOBS = ["candidate", "candidate-rerun"];

test("only a manual dispatch from main starts it", () => {
  assert.match(run, /\non:\n {2}workflow_dispatch:/);
  assert.doesNotMatch(run, /^ {2}(pull_request|pull_request_target|issue_comment|push|schedule|workflow_run):/m);
  assert.match(jobs(run).get("prepare") ?? "", /if: github\.ref == 'refs\/heads\/main'/);
});

test("no expression is substituted into a shell script", () => {
  for (const text of [run, ledger]) {
    let indent = -1;
    for (const line of text.split("\n")) {
      const lead = line.length - line.trimStart().length;
      if (indent >= 0 && line.trim() !== "" && lead <= indent) indent = -1;
      if (indent >= 0) assert.doesNotMatch(line, /\$\{\{/, line);
      if (/^\s*(- )?run: [|>]/.test(line)) indent = lead;
      else if (/^\s*(- )?run: /.test(line)) assert.doesNotMatch(line, /\$\{\{/, line);
    }
  }
});

test("the jobs that run the candidate's files call no writer workflow and assume only the read role", () => {
  for (const name of CANDIDATE_JOBS) {
    const job = jobs(run).get(name) ?? "";
    assert.ok(job.length > 0, name);
    assert.doesNotMatch(job, /uses: \.\//, name);
    assert.doesNotMatch(job, /cache-push|ledger/, name);
    const roles = [...job.matchAll(/role-to-assume: (\S+)/g)].map((m) => m[1]);
    assert.deepEqual(roles, ["arn:aws:iam::333022194791:role/github-actions-delegate-eval"], name);
  }
});

test("the candidate jobs check out main, and take the branch only as the two-file artifact", () => {
  for (const name of CANDIDATE_JOBS) {
    const job = jobs(run).get(name) ?? "";
    const refs = [...job.matchAll(/^\s+ref: (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(refs, ["${{ github.sha }}"], name);
    assert.match(job, /artifact-ids: \$\{\{ needs\.prepare\.outputs\.cand_files_id \}\}/, name);
    assert.doesNotMatch(job, /inputs\.branch|branch_sha/, name);
  }
});

test("the writers are reachable only through the two reusable workflows", () => {
  const callers = [...jobs(run)].filter(([, body]) => /uses: \.\//.test(body)).map(([n]) => n);
  assert.deepEqual(callers.sort(), ["ledger", "main-cache-push"]);
  assert.match(jobs(run).get("main-cache-push") ?? "", /uses: \.\/\.github\/workflows\/delegate-eval-cache-push\.yml/);
  assert.match(jobs(run).get("ledger") ?? "", /uses: \.\/\.github\/workflows\/delegate-eval-ledger\.yml/);
});

test("scoring, gating and the cost sum run with no AWS credentials", () => {
  for (const name of ["gate", "score", "cost"]) {
    const job = jobs(run).get(name) ?? "";
    assert.ok(job.length > 0, name);
    assert.doesNotMatch(job, /role-to-assume|id-token/, name);
  }
});

test("the ledger workflow assumes only the ledger role and runs main's checkout", () => {
  assert.deepEqual(
    [...ledger.matchAll(/role-to-assume: (\S+)/g)].map((m) => m[1]),
    ["arn:aws:iam::333022194791:role/github-actions-delegate-eval-ledger"],
  );
  assert.match(ledger, /ref: \$\{\{ inputs\.main-sha \}\}/);
});

test("the targets come from the dispatch input, not a file", () => {
  assert.match(jobs(run).get("gate") ?? "", /TARGETS: \$\{\{ inputs\.targets \}\}/);
  assert.match(jobs(run).get("score") ?? "", /TARGETS: \$\{\{ inputs\.targets \}\}/);
});

test("no step input or output carries case ids, so holdout ids stay out of the log", () => {
  assert.doesNotMatch(run, /outputs\.rerun\b|RERUN_IDS: \$\{\{/);
  assert.match(jobs(run).get("gate") ?? "", /has_rerun/);
});

test("the ledger records every measured dispatch, with or without a cost file", () => {
  const job = jobs(run).get("ledger") ?? "";
  assert.doesNotMatch(job, /artifact_id != ''/);
  assert.match(job, /estimate-usd: \$\{\{ needs\.prepare\.outputs\.estimate \}\}/);
});
