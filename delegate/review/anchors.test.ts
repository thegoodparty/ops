import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDiffAnchors, isAnchorable, placeFindings } from "./anchors";
import type { Finding } from "./schema";

describe("parseDiffAnchors", () => {
  it("parses a single-hunk diff into new-side line numbers", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc1234..def5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,4 @@ some context
 unchanged1
+added
 unchanged2`;
    const anchors = parseDiffAnchors(diff);
    const set = anchors.get("src/foo.ts")!;
    assert.ok(set, "expected entry for src/foo.ts");
    assert.ok(set.has(10), "context line at 10");
    assert.ok(set.has(11), "added line at 11");
    assert.ok(set.has(12), "context line at 12");
    assert.equal(anchors.size, 1);
  });

  it("accumulates both hunks for a multi-hunk diff", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@ first hunk
 line1
+newline2
 line3
 line4
@@ -20,2 +21,3 @@ second hunk
 line21
+newline22
 line23`;
    const anchors = parseDiffAnchors(diff);
    const set = anchors.get("src/foo.ts")!;
    // first hunk: new-side 1..4
    assert.ok(set.has(1));
    assert.ok(set.has(2));
    assert.ok(set.has(3));
    assert.ok(set.has(4));
    // second hunk: new-side 21..23
    assert.ok(set.has(21));
    assert.ok(set.has(22));
    assert.ok(set.has(23));
    // gaps between hunks must not be present
    assert.ok(!set.has(10));
    assert.ok(!set.has(20));
  });

  it("uses the new (b/) path for renamed files", () => {
    const diff = `diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1,2 +1,3 @@ renamed
 line1
+added
 line2`;
    const anchors = parseDiffAnchors(diff);
    assert.ok(!anchors.has("old.ts"), "must not create entry for old path");
    const set = anchors.get("new.ts")!;
    assert.ok(set.has(1));
    assert.ok(set.has(2));
    assert.ok(set.has(3));
  });

  it("produces no entry for a deleted file", () => {
    const diff = `diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
--- a/deleted.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
-line2
-line3`;
    const anchors = parseDiffAnchors(diff);
    assert.equal(anchors.size, 0, "deleted file must not create an anchor entry");
  });

  it("handles a new file where all lines are added", () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,3 @@
+line1
+line2
+line3`;
    const anchors = parseDiffAnchors(diff);
    const set = anchors.get("new.ts")!;
    assert.ok(set.has(1));
    assert.ok(set.has(2));
    assert.ok(set.has(3));
    assert.ok(!set.has(4));
  });

  it("handles multiple files in one diff", () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,2 @@
 a1
+a2
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -5,1 +5,2 @@
 b5
+b6`;
    const anchors = parseDiffAnchors(diff);
    assert.ok(anchors.get("a.ts")!.has(1));
    assert.ok(anchors.get("a.ts")!.has(2));
    assert.ok(anchors.get("b.ts")!.has(5));
    assert.ok(anchors.get("b.ts")!.has(6));
  });
});

describe("isAnchorable", () => {
  it("returns true when the single line is present", () => {
    const anchors = new Map([["foo.ts", new Set([5, 6, 7])]]);
    assert.equal(isAnchorable(anchors, "foo.ts", 6), true);
  });

  it("returns false when the single line is absent", () => {
    const anchors = new Map([["foo.ts", new Set([5, 6, 7])]]);
    assert.equal(isAnchorable(anchors, "foo.ts", 99), false);
  });

  it("returns true when all lines in an endLine range are present", () => {
    const anchors = new Map([["foo.ts", new Set([5, 6, 7, 8])]]);
    assert.equal(isAnchorable(anchors, "foo.ts", 5, 8), true);
  });

  it("returns false when an endLine range crosses a hunk boundary (gap in anchors)", () => {
    // hunks cover 5-8 and 21-23; range 8-21 spans the gap
    const anchors = new Map([["foo.ts", new Set([5, 6, 7, 8, 21, 22, 23])]]);
    assert.equal(isAnchorable(anchors, "foo.ts", 8, 21), false);
  });

  it("returns false for a path not in the map", () => {
    const anchors = new Map<string, Set<number>>();
    assert.equal(isAnchorable(anchors, "missing.ts", 1), false);
  });
});

describe("placeFindings", () => {
  const anchoredFinding: Finding = {
    path: "foo.ts",
    line: 5,
    body: "issue here",
    category: "bugs",
    confidence: "high",
  };

  const unanchoredFinding: Finding = {
    path: "foo.ts",
    line: 99,
    body: "old issue",
    category: "conventions",
    confidence: "medium",
  };

  const findingWithSuggestion: Finding = {
    path: "foo.ts",
    line: 99,
    body: "please fix this",
    suggestion: "const x = 1;",
    category: "bugs",
    confidence: "high",
  };

  it("marks a finding as not demoted when anchorable", () => {
    const anchors = new Map([["foo.ts", new Set([5])]]);
    const result = placeFindings([anchoredFinding], anchors);
    assert.equal(result[0].demoted, false);
    assert.deepEqual(result[0].finding, anchoredFinding);
  });

  it("marks a finding as demoted when not anchorable", () => {
    const anchors = new Map([["foo.ts", new Set([5])]]);
    const result = placeFindings([unanchoredFinding], anchors);
    assert.equal(result[0].demoted, true);
    assert.deepEqual(result[0].finding, unanchoredFinding);
  });

  it("folds suggestion into body and drops suggestion field when demoted", () => {
    const anchors = new Map<string, Set<number>>();
    const result = placeFindings([findingWithSuggestion], anchors);
    assert.equal(result[0].demoted, true);
    assert.ok(result[0].finding.body.includes("please fix this"));
    assert.ok(result[0].finding.body.includes("const x = 1;"));
    assert.equal(result[0].finding.suggestion, undefined);
  });

  it("preserves suggestion when finding is anchorable", () => {
    const anchors = new Map([["foo.ts", new Set([99])]]);
    const result = placeFindings([findingWithSuggestion], anchors);
    assert.equal(result[0].demoted, false);
    assert.equal(result[0].finding.suggestion, "const x = 1;");
  });

  it("handles mixed anchorable and demoted findings", () => {
    const anchors = new Map([["foo.ts", new Set([5])]]);
    const result = placeFindings([anchoredFinding, unanchoredFinding], anchors);
    assert.equal(result[0].demoted, false);
    assert.equal(result[1].demoted, true);
  });

  it("returns empty array for empty input", () => {
    const anchors = new Map<string, Set<number>>();
    assert.deepEqual(placeFindings([], anchors), []);
  });
});
