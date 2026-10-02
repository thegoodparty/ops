import assert from "node:assert/strict";
import { test } from "node:test";

import { renderTimeline } from "./activity";
import { blind, blindSide } from "./blind";

// Shaped like a closing report a system might upload to the thread: a summary
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
  const { text } = blind(POSTMORTEM, "prose", { identifying: ["bugboss/incident-83-pool"] });
  assert.ok(!text.includes("3f9a2c1d7e"));
  assert.ok(!text.includes("2213"));
  assert.ok(!text.includes("bugboss/incident-83-pool"));
  assert.ok(!text.includes("2026-09-28"));
  assert.ok(!text.includes("claude-opus"));
  assert.match(text, /<sha>/);
  assert.match(text, /PR <n>/);
  assert.match(text, /\/pull\/<n>/);
  assert.match(text, /<redacted>/);
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

test("branch names of either common shape are replaced; file paths are not", () => {
  const { text } = blind(
    "Opened fix/users-zip-read from bugboss/incident-83-pool; see packages/gp-api/src/users/users.schema.ts and a/src/pool.ts",
    "prose",
    { identifying: ["bugboss/incident-83-pool"] },
  );
  assert.ok(!text.includes("fix/users-zip-read"));
  assert.ok(!text.includes("bugboss/incident-83-pool"));
  assert.match(text, /Opened <branch> from <redacted>/);
  assert.match(text, /packages\/gp-api\/src\/users\/users\.schema\.ts/);
  assert.match(text, /a\/src\/pool\.ts/);
});

test("a rendered timeline keeps every message and loses only identifiers and run statements", () => {
  const T0 = Date.UTC(2026, 0, 1, 12);
  const timeline = renderTimeline(
    {
      alertAt: T0,
      events: [
        { at: T0, kind: "alert_fired", refire: false },
        { at: T0 + 120_000, kind: "slack_post", ts: "1790871995.216999", threadTs: null, text: "Incident 83: P2024 on election-api\nInvestigating. Root cause suspected in the 25-connection pool." },
        { at: T0 + 600_000, kind: "slack_human", ts: "1790872595.000001", threadTs: "1790871995.216999", text: "It works now, you can resolve it." },
        { at: T0 + 660_000, kind: "slack_post", ts: "1790872655.000002", threadTs: "1790871995.216999", text: "Which environment was that on? Prod still shows the error at 2026-09-28T14:02:11Z." },
        { at: T0 + 2_400_000, kind: "pr_opened", number: 2213, title: "Cap the officeholder read", files: ["packages/election-api/src/officeholders.ts"] },
        { at: T0 + 3_000_000, kind: "merged", number: 2213 },
        { at: T0 + 3_100_000, kind: "slack_file", ts: "1790875095.000003", name: "postmortem.md", text: POSTMORTEM },
        { at: T0 + 3_200_000, kind: "closed" },
      ],
    },
    (s) => s,
  );
  const { output, droppedLines } = blindSide(
    { timeline, diff: "index 3f9a2c1d..9b8e7f6a 100644\n+const limit = 50" },
    { identifying: ["bugboss/incident-83-pool"] },
  );
  const text = output.timeline;
  for (const kept of [
    "Investigating. Root cause suspected in the 25-connection pool.",
    "It works now, you can resolve it.",
    "Which environment was that on? Prod still shows the error at <time>.",
    "Cap the officeholder read",
    "packages/election-api/src/officeholders.ts",
    "Add a row cap",
    "Incident closed",
  ]) {
    assert.ok(text.includes(kept), `lost: ${kept}\n${text}`);
  }
  for (const gone of ["2213", "3f9a2c1d7e", "bugboss/incident-83-pool", "2026-09-28", "$22.52", "124 turns", "1790871995"]) {
    assert.ok(!text.includes(gone), `still contains ${gone}`);
  }
  assert.match(text, /Pull request #<n> opened/);
  assert.match(text, /\*\*\+02:00\*\*/);
  assert.ok(droppedLines >= 8);
  assert.match(output.diff ?? "", /index <sha>\.\.<sha>/);
  assert.match(output.diff ?? "", /\+const limit = 50/);
});

test("blindSide keeps an absent diff absent", () => {
  const { output, droppedLines } = blindSide({ timeline: "**+00:00** Alert fired\n", diff: null });
  assert.equal(output.diff, null);
  assert.equal(droppedLines, 0);
});

test("a repository slug whose name merely starts with a branch keyword is not a branch", () => {
  const text = blindSide(
    { timeline: "Working on thegoodparty/bugboss-eval-sandbox and acme/eval-data, branch swain/bug-77, then fix/zip-read.", diff: null },
    { identifying: ["swain/bug-77"] },
  ).output.timeline;
  assert.match(text, /thegoodparty\/bugboss-eval-sandbox/);
  assert.match(text, /acme\/eval-data/);
  assert.match(text, /branch <redacted>, then <branch>/);
});

test("a dollar amount in evidence survives; a dollar amount about the run does not", () => {
  const { text } = blind("The candidate was charged $499.80 for texts that never went out.\nEstimated cost: $22.52 for this run.", "prose");
  assert.match(text, /charged \$499\.80/);
  assert.ok(!text.includes("$22.52"));
});
