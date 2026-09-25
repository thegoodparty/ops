import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { usageCostUsd } from "./bedrock-responses";
import {
  extractJson,
  normalizeFindings,
  normalizeLeads,
  readFileTool,
  resolveInRoot,
} from "./second-opinion";

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
    assert.equal(normalizeLeads(raw, 10).leads.length, 10);
    assert.equal(normalizeLeads(raw, 3).leads.length, 3);
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
    const { leads } = normalizeLeads(raw, 10);
    assert.equal(leads.length, 1);
    assert.deepEqual(leads[0], {
      area: "good",
      category: "security",
      paths: ["src/a.ts"],
      lineRange: null,
      hypothesis: "",
    });
  });

  // rawCount is what lets runSecondOpinion tell "the scout found nothing" from
  // "the scout returned leads we could not use", which it reports as a failure.
  it("reports raw leads that were all unusable", () => {
    const raw = {
      leads: [
        { area: "no paths", category: "correctness", paths: [] },
        { area: "missing paths", category: "correctness" },
      ],
    };
    const { leads, rawCount } = normalizeLeads(raw, 10);
    assert.equal(leads.length, 0);
    assert.equal(rawCount, 2);
    assert.equal(rawCount > 0 && leads.length === 0, true);
  });

  it("reports an empty lead list as zero raw leads", () => {
    const { leads, rawCount } = normalizeLeads({ leads: [] }, 10);
    assert.equal(leads.length, 0);
    assert.equal(rawCount, 0);
    assert.equal(rawCount > 0 && leads.length === 0, false);
  });
});

const withRoot = (fn: (root: string) => void): void => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "second-opinion-"))
  );
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

describe("resolveInRoot", () => {
  it("accepts a path inside the checkout", () => {
    withRoot((root) => {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src/a.ts"), "x");
      assert.deepEqual(resolveInRoot(root, "src/a.ts"), {
        path: path.join(root, "src/a.ts"),
      });
      assert.deepEqual(resolveInRoot(root, "."), { path: root });
      assert.deepEqual(resolveInRoot(root, "src/does-not-exist.ts"), {
        path: path.join(root, "src/does-not-exist.ts"),
      });
    });
  });

  it("rejects traversal, absolute paths, and the parent directory", () => {
    withRoot((root) => {
      for (const candidate of [
        "../../etc/passwd",
        "/proc/1/environ",
        "..",
        "src/../../outside.ts",
      ]) {
        const resolved = resolveInRoot(root, candidate);
        assert.ok("error" in resolved, `${candidate} should be rejected`);
        assert.match(resolved.error, /PR checkout root|outside the PR checkout/);
      }
    });
  });

  it("rejects a symlink inside the checkout that points outside it", () => {
    withRoot((root) => {
      const outside = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "second-opinion-outside-"))
      );
      try {
        fs.writeFileSync(path.join(outside, "secret.txt"), "shh");
        fs.symlinkSync(outside, path.join(root, "escape"));
        const resolved = resolveInRoot(root, "escape/secret.txt");
        assert.ok("error" in resolved);
        assert.match(resolved.error, /outside the PR checkout/);
        assert.match(readFileTool(root, { path: "escape/secret.txt" }), /outside/);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  // path.resolve collapses `..` lexically, the kernel walks it after each
  // symlink, and the two disagree on `link/../x`. Rejecting the segment is
  // what keeps that disagreement from mattering.
  it("rejects a '..' segment even when it lexically lands inside the root", () => {
    withRoot((root) => {
      const outside = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "second-opinion-outside-"))
      );
      try {
        fs.writeFileSync(path.join(outside, "secret.txt"), "shh");
        fs.symlinkSync(outside, path.join(root, "escape"));
        for (const candidate of [
          "escape/../secret.txt",
          "src/../src/a.ts",
          "..",
        ]) {
          const resolved = resolveInRoot(root, candidate);
          assert.ok("error" in resolved, `${candidate} should be rejected`);
        }
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});

describe("readFileTool", () => {
  it("returns the whole file by default", () => {
    withRoot((root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "one\ntwo\nthree");
      assert.equal(readFileTool(root, { path: "a.txt" }), "one\ntwo\nthree");
    });
  });

  it("honours 1-indexed offset and limit", () => {
    withRoot((root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "1\n2\n3\n4\n5");
      assert.equal(readFileTool(root, { path: "a.txt", offset: 2 }), "2\n3\n4\n5");
      assert.equal(readFileTool(root, { path: "a.txt", limit: 2 }), "1\n2");
      assert.equal(
        readFileTool(root, { path: "a.txt", offset: 2, limit: 2 }),
        "2\n3"
      );
    });
  });

  it("truncates at the output cap", () => {
    withRoot((root) => {
      fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(150000));
      const output = readFileTool(root, { path: "big.txt" });
      assert.equal(output.length, 100000);
      assert.ok(output.endsWith("\n[truncated]"));
    });
  });

  it("returns an error string rather than throwing", () => {
    withRoot((root) => {
      assert.match(readFileTool(root, { path: "nope.txt" }), /^\[error: /);
      assert.match(readFileTool(root, { path: "" }), /needs a path/);
      assert.match(readFileTool(root, { path: "/etc/passwd" }), /outside/);
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
