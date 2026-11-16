import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt } from "./pr-reviewer";
import { prReviewerSubagents } from "./pr-reviewer-subagents";
import { buildScaleCheckXml, SCALE_FACTS, scaleTriggers } from "./scale-check";
import type { Bundle } from "../review/schema";

const fileDiff = (path: string, added: string[]) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${added.length + 1} @@\n const x = 1\n${added.map((l) => `+${l}`).join("\n")}\n`;

const omni = (diff: string) => ({ repo: "thegoodparty/omni", diff });

describe("scaleTriggers", () => {
  it("flags a database query", () => {
    const t = scaleTriggers(omni(fileDiff("packages/gp-api/src/a/a.service.ts", ["const rows = await this.model.findMany({ where })"])));
    assert.deepEqual(t, [{ path: "packages/gp-api/src/a/a.service.ts", signals: ["db-query"] }]);
  });

  it("flags a loop over people data", () => {
    const t = scaleTriggers(omni(fileDiff("packages/gp-api/src/a/b.ts", ["for (const voter of voters) total += voter.weight"])));
    assert.deepEqual(t[0].signals, ["loop-over-people"]);
  });

  it("does not flag a loop over something else", () => {
    assert.deepEqual(scaleTriggers(omni(fileDiff("packages/gp-api/src/a/b.ts", ["for (const key of Object.keys(env)) check(key)"]))), []);
  });

  it("flags a request handler that touches people data", () => {
    const t = scaleTriggers(omni(fileDiff("packages/gp-api/src/a/contacts.controller.ts", ["return this.service.list(contactIds)"])));
    assert.deepEqual(t[0].signals, ["request-path"]);
    const decorated = scaleTriggers(omni(fileDiff("packages/gp-api/src/a/x.ts", ["@Get('people')", "list() { return this.people }"])));
    assert.deepEqual(decorated[0].signals, ["request-path"]);
  });

  it("does not flag a request handler that touches no people data", () => {
    assert.deepEqual(scaleTriggers(omni(fileDiff("packages/gp-api/src/health/version.controller.ts", ["return { sha: process.env.SHA }"]))), []);
  });

  it("ignores tests, docs, removed lines and deleted files", () => {
    const query = ["await prisma.voter.findMany()"];
    assert.deepEqual(scaleTriggers(omni(fileDiff("packages/gp-api/src/a/a.service.test.ts", query))), []);
    assert.deepEqual(scaleTriggers(omni(fileDiff("packages/gp-api/src/a/AGENTS.md", query))), []);
    assert.deepEqual(scaleTriggers(omni(fileDiff("packages/gp-ai/broker/tests/test_x.py", query))), []);
    const removed = "diff --git a/s.ts b/s.ts\n--- a/s.ts\n+++ b/s.ts\n@@ -1,2 +1,1 @@\n const x = 1\n-await prisma.voter.findMany()\n";
    assert.deepEqual(scaleTriggers(omni(removed)), []);
    const deleted = "diff --git a/s.ts b/s.ts\ndeleted file mode 100644\n--- a/s.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-await prisma.voter.findMany()\n";
    assert.deepEqual(scaleTriggers(omni(deleted)), []);
  });

  it("does not run outside the repo the sizes describe", () => {
    const diff = fileDiff("analytics/lib/a.py", ["rows = spark.sql('SELECT * FROM voters')"]);
    assert.deepEqual(scaleTriggers({ repo: "thegoodparty/gp-data-platform", diff }), []);
  });

  it("reads every file section of a multi-file diff", () => {
    const diff =
      fileDiff("packages/gp-api/src/a.ts", ["const n = 1"]) +
      fileDiff("packages/gp-api/src/b.ts", ["const rows = await db.$queryRaw`SELECT id FROM contacts`"]);
    assert.deepEqual(scaleTriggers(omni(diff)).map((t) => t.path), ["packages/gp-api/src/b.ts"]);
  });
});

describe("buildScaleCheckXml", () => {
  it("is empty without triggers", () => {
    assert.equal(buildScaleCheckXml([]), "");
  });

  it("lists the flagged files, escaped", () => {
    const xml = buildScaleCheckXml([{ path: "src/<a>.ts", signals: ["db-query"] }]);
    assert.ok(xml.includes("src/&lt;a>.ts (db-query)"));
    assert.ok(xml.includes("scale-check"));
  });

  it("caps the list", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ path: `f${i}.ts`, signals: ["db-query" as const] }));
    const xml = buildScaleCheckXml(many);
    assert.ok(xml.includes("f24.ts"));
    assert.ok(!xml.includes("f25.ts"));
    assert.ok(xml.includes("5 more"));
  });
});

describe("review prompt and subagents", () => {
  const bundle = (diff: string): Bundle => ({
    repo: "thegoodparty/omni",
    prNumber: 1,
    baseRef: "main",
    baseSha: "a",
    headSha: "b",
    author: "x",
    title: "t",
    body: "",
    changedFiles: [],
    priorFindings: [],
    diff,
  });

  it("adds <scale_check> only when the diff triggers it", () => {
    assert.ok(buildReviewPrompt(bundle(fileDiff("packages/gp-api/src/a.ts", ["await prisma.contact.findMany()"]))).includes("<scale_check>"));
    assert.ok(!buildReviewPrompt(bundle(fileDiff("packages/gp-api/src/a.ts", ["const n = 1"]))).includes("<scale_check>"));
  });

  it("registers the scale-check subagent with the sizes in its prompt", () => {
    const agent = prReviewerSubagents["scale-check"];
    assert.ok(agent);
    assert.ok(agent.prompt.includes(SCALE_FACTS));
    assert.ok(SCALE_FACTS.includes("| Audience cap per resolution | 200,000 |"));
    assert.ok(!SCALE_FACTS.includes("${"));
  });
});
