import { test } from "node:test";
import assert from "node:assert/strict";
import { promptDiff } from "./prompt-diff";

const diff = [
  "diff --git a/src/keep.ts b/src/keep.ts",
  "index 1..2 100644",
  "--- a/src/keep.ts",
  "+++ b/src/keep.ts",
  "@@ -1,2 +1,3 @@",
  " a",
  "+b",
  "-c",
  "+d",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "index 3..0000000",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,3 +0,0 @@",
  "-x",
  "-y",
  "-z",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+n1",
  "+n2",
  "",
].join("\n");

test("deleted files leave the inline diff and become a list and a stat line", () => {
  const pd = promptDiff(diff);
  assert.deepEqual(pd.deletedFiles, ["src/gone.ts"]);
  assert.ok(pd.inline.includes("src/keep.ts"));
  assert.ok(pd.inline.includes("src/new.ts"));
  assert.ok(!pd.inline.includes("src/gone.ts"));
  assert.deepEqual(pd.stat.split("\n"), [
    "src/keep.ts | +2 -1",
    "src/gone.ts | deleted (-3)",
    "src/new.ts | +2 -0",
  ]);
  assert.equal(pd.oversized, false);
});

test("oversized is judged on what remains after deletions", () => {
  assert.equal(promptDiff(diff, 10).oversized, true);
  const onlyDeletes = diff.split("diff --git a/src/gone.ts")[1];
  assert.equal(promptDiff(`diff --git a/src/gone.ts${onlyDeletes}`.split("diff --git a/src/new.ts")[0], 10).oversized, false);
});
