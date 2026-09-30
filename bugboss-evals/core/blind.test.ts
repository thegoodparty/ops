import assert from "node:assert/strict";
import { test } from "node:test";

import { blind, blindOutput } from "./blind";

// Shaped like the closing report BugBoss uploads (report/render.ts): a summary
// line with tokens, turns and an estimated cost, and an "Agent run" section.
const POSTMORTEM = [
  "# Incident 83 postmortem",
  "",
  "election-api exhausted its 25-connection Prisma pool: each state-wide officeholder read held a connection for the 7 MB response, and voter-density requests queued past the 20 s pool timeout.",
  "",
  "1.2M tokens · 124 turns · on us.anthropic.claude-opus-5 (est. $22.52)",
  "resolved in 2h 14m · time to detect 6m",
  "Fixed in https://github.com/thegoodparty/omni/pull/2213 (PR #2213) on branch bugboss/incident-83-pool, commit 3f9a2c1d7e.",
  "Confirmed at 2026-09-28T14:02:11Z that P2024 stopped.",
  "",
  "## Agent run",
  "",
  "| | |",
  "| --- | --- |",
  "| Model | us.anthropic.claude-opus-5 |",
  "| Turns | 124 |",
  "| Cache read | 1,000,000 |",
  "",
  "**Estimated cost: $22.52.** An estimate, not a bill.",
  "",
  "## Follow-ups",
  "",
  "- Add a row cap to the officeholder list.",
].join("\n");

test("prose loses every statement of the run's cost, tokens, turns and duration", () => {
  const { text, droppedLines } = blind(POSTMORTEM, "prose");
  for (const leak of ["$22.52", "124", "tokens", "2h 14m", "time to detect", "Estimated cost", "Cache read"]) {
    assert.ok(!text.includes(leak), `still contains ${leak}:\n${text}`);
  }
  assert.ok(droppedLines >= 8);
});

test("prose keeps evidence about the system, including its own durations", () => {
  const { text } = blind(POSTMORTEM, "prose");
  assert.match(text, /25-connection Prisma pool/);
  assert.match(text, /20 s pool timeout/);
  assert.match(text, /7 MB response/);
  assert.match(text, /## Follow-ups/);
  assert.match(text, /Add a row cap/);
});

test("identifiers are replaced: SHAs, PR numbers, branches, timestamps and model ids", () => {
  const { text } = blind(POSTMORTEM, "prose");
  assert.ok(!text.includes("3f9a2c1d7e"));
  assert.ok(!text.includes("2213"));
  assert.ok(!text.includes("bugboss/incident-83-pool"));
  assert.ok(!text.includes("2026-09-28"));
  assert.ok(!text.includes("claude-opus"));
  assert.match(text, /<sha>/);
  assert.match(text, /PR <n>/);
  assert.match(text, /\/pull\/<n>/);
  assert.match(text, /<branch>/);
  assert.match(text, /<time>/);
});

test("the caller's identifying strings are replaced, longest first", () => {
  const { text } = blind("built from feat/cheaper-pr-wait-v2 and feat/cheaper", "prose", {
    identifying: ["feat/cheaper", "feat/cheaper-pr-wait-v2"],
  });
  assert.equal(text, "built from <redacted> and <redacted>");
});

test("a diff loses no lines, only identifiers", () => {
  const diff = [
    "diff --git a/src/pool.ts b/src/pool.ts",
    "index 3f9a2c1d..9b8e7f6a 100644",
    "--- a/src/pool.ts",
    "+++ b/src/pool.ts",
    "@@ -1,3 +1,3 @@",
    "-const limit = 25",
    '+const cost = "$1.50" // 12 turns',
    "+// see #2213",
  ].join("\n");
  const { text, droppedLines } = blind(diff, "diff");
  assert.equal(droppedLines, 0);
  assert.equal(text.split("\n").length, diff.split("\n").length);
  assert.match(text, /index <sha>\.\.<sha>/);
  assert.match(text, /\$1\.50/);
  assert.match(text, /#<n>/);
});

test("blindOutput keeps an absent part absent and counts dropped lines", () => {
  const { output, droppedLines } = blindOutput({
    rootCause: "Pool exhaustion. 40 turns in.",
    diff: null,
    postmortem: null,
  });
  assert.equal(output.diff, null);
  assert.equal(output.postmortem, null);
  assert.equal(output.rootCause, "");
  assert.equal(droppedLines, 1);
});
