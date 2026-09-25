import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { usageCostUsd } from "./bedrock-responses";
import { extractJson, normalizeFindings, normalizeLeads } from "./second-opinion";

describe("extractJson", () => {
  it("parses a trailing JSON line", () => {
    const text = 'I looked at the diff.\n{"findings":[],"summary":"clean"}';
    assert.deepEqual(extractJson(text), { findings: [], summary: "clean" });
  });

  it("parses JSON with prose above it", () => {
    const text = [
      "Here is what I found while reading the controller.",
      "It looks fine, so nothing to report.",
      "",
      '{"leads":[{"area":"a","paths":["x.ts"]}],"summary":"one lead"}',
    ].join("\n");
    assert.deepEqual(extractJson(text), {
      leads: [{ area: "a", paths: ["x.ts"] }],
      summary: "one lead",
    });
  });

  it("parses JSON inside a fenced code block", () => {
    const text = [
      "Result:",
      "```json",
      "{",
      '  "findings": [],',
      '  "summary": "nothing"',
      "}",
      "```",
    ].join("\n");
    assert.deepEqual(extractJson(text), { findings: [], summary: "nothing" });
  });

  it("returns undefined for garbage", () => {
    assert.equal(extractJson("no json here, just words"), undefined);
    assert.equal(extractJson(""), undefined);
  });
});

describe("normalizeFindings", () => {
  it("drops entries missing file, line, or body", () => {
    const raw = {
      findings: [
        { line: 3, severity: "blocker", body: "b" },
        { file: "a.ts", severity: "blocker", body: "b" },
        { file: "a.ts", line: 3, severity: "blocker" },
      ],
    };
    assert.deepEqual(normalizeFindings(raw, "area", "correctness"), []);
  });

  it("coerces a numeric-string line", () => {
    const raw = {
      findings: [
        { file: "a.ts", line: "42", severity: "concern", body: "careful" },
      ],
    };
    assert.deepEqual(normalizeFindings(raw, "area", "correctness"), [
      {
        file: "a.ts",
        line: 42,
        severity: "concern",
        body: "careful",
        leadArea: "area",
        leadCategory: "correctness",
      },
    ]);
  });

  it("rejects an unknown severity", () => {
    const raw = {
      findings: [
        { file: "a.ts", line: 1, severity: "critical", body: "b" },
        { file: "a.ts", line: 2, body: "b" },
      ],
    };
    assert.deepEqual(normalizeFindings(raw, "area", "security"), []);
  });

  it("drops lines GitHub cannot anchor a comment to", () => {
    const raw = {
      findings: [
        { file: "a.ts", line: 0, severity: "blocker", body: "b" },
        { file: "a.ts", line: -3, severity: "blocker", body: "b" },
        { file: "a.ts", line: 2.5, severity: "blocker", body: "b" },
      ],
    };
    assert.deepEqual(normalizeFindings(raw, "area", "correctness"), []);
  });

  it("preserves startLine when present and omits it when absent", () => {
    const raw = {
      findings: [
        { file: "a.ts", line: 9, startLine: 7, severity: "nit", body: "x" },
        { file: "b.ts", line: 4, severity: "nit", body: "y" },
      ],
    };
    const findings = normalizeFindings(raw, "area", "tests");
    assert.equal(findings.length, 2);
    assert.equal(findings[0].startLine, 7);
    assert.equal("startLine" in findings[1], false);
  });

  it("stamps leadArea and leadCategory", () => {
    const raw = {
      findings: [{ file: "a.ts", line: 1, severity: "blocker", body: "b" }],
    };
    const findings = normalizeFindings(raw, "Timezone logic", "cross-file");
    assert.equal(findings[0].leadArea, "Timezone logic");
    assert.equal(findings[0].leadCategory, "cross-file");
  });
});

describe("normalizeLeads", () => {
  it("caps at maxLeads", () => {
    const raw = {
      leads: Array.from({ length: 12 }, (_, i) => ({
        area: `lead ${i}`,
        category: "correctness",
        paths: ["a.ts"],
        lineRange: null,
        hypothesis: "maybe",
      })),
    };
    assert.equal(normalizeLeads(raw, 10).length, 10);
    assert.equal(normalizeLeads(raw, 3).length, 3);
  });

  it("drops leads with no paths", () => {
    const raw = {
      leads: [
        { area: "no paths", category: "correctness", paths: [] },
        { area: "missing paths", category: "correctness" },
        { area: "bad paths", category: "correctness", paths: [1, ""] },
        { area: "good", category: "security", paths: ["src/a.ts"] },
      ],
    };
    const leads = normalizeLeads(raw, 10);
    assert.equal(leads.length, 1);
    assert.deepEqual(leads[0], {
      area: "good",
      category: "security",
      paths: ["src/a.ts"],
      lineRange: null,
      hypothesis: "",
    });
  });
});

describe("usageCostUsd", () => {
  it("prices a known usage triple", () => {
    const cost = usageCostUsd({
      inputTokens: 1_000_000,
      cachedInputTokens: 900_000,
      outputTokens: 100_000,
    });
    assert.ok(Math.abs(cost - 3.036) < 1e-9, `got ${cost}`);
  });

  it("bills cached tokens at the cached rate without double-billing", () => {
    const allCached = usageCostUsd({
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });
    const noneCached = usageCostUsd({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    assert.ok(Math.abs(allCached - 0.44) < 1e-9, `got ${allCached}`);
    assert.ok(Math.abs(noneCached - 4.4) < 1e-9, `got ${noneCached}`);
  });

  it("clamps the uncached count when cached exceeds total input", () => {
    const cost = usageCostUsd({
      inputTokens: 100,
      cachedInputTokens: 500,
      outputTokens: 0,
    });
    assert.ok(Math.abs(cost - 500 * 0.44 / 1_000_000) < 1e-12, `got ${cost}`);
  });
});
