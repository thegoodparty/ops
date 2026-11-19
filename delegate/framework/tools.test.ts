import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confineTo, normalizeGuardPath } from "./tool-paths";
import { createReadTools, globToRegExp } from "./tools";

// The read tools the reviewer gets, and the confinement each one runs.
//
// The property this file exists for is the one S3's amendment left open: **the
// guard and the tool opening the file are the same code**. `createReadTools` calls
// `confineTo` itself, `pathGuardHook` calls the same `confineTo`, and
// `applyGuard` calls it a third time — so no spelling can pass one and reach
// something else through another. The adversarial table in `review/run.test.ts`
// pins the guard; this pins the tools, which are the half that actually opens
// files.

const checkout = () => {
  const root = mkdtempSync(join(tmpdir(), "read-tools-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "alpha\nbeta\ngamma\n");
  writeFileSync(join(root, "README.md"), "# hi\n");
  return root;
};

const run = async (root: string, tool: "Read" | "Grep" | "Glob", input: Record<string, unknown>) => {
  const tools = createReadTools({ root });
  return (await (tools[tool].execute as (i: unknown) => Promise<string>)(input)) as string;
};

test("Read returns numbered lines and honours offset and limit", async () => {
  const root = checkout();
  const all = await run(root, "Read", { file_path: "src/a.ts" });
  assert.match(all, /1\|alpha/);
  assert.match(all, /3\|gamma/);
  const page = await run(root, "Read", { file_path: "src/a.ts", offset: 2, limit: 1 });
  assert.match(page, /2\|beta/);
  assert.doesNotMatch(page, /alpha/);
});

test("Read refuses every path outside the checkout, both spellings included", async () => {
  // The table from the plan's section 3, run against the tool rather than the
  // guard. A tool that confined only the normalised spelling would open
  // `@l/…` through a committed symlink; one that confined only the literal
  // spelling would open the normalised path. Both are denied here.
  const root = checkout();
  symlinkSync("/", join(root, "@l"));
  symlinkSync("/", join(root, "l"));
  symlinkSync("/etc", join(root, "etc-link"));

  for (const bad of [
    "/proc/1/environ",
    "../../etc/passwd",
    "@/etc/hostname",
    "@../../etc/passwd",
    "\u00a0/etc/hostname",
    "etc-link/hostname",
    "@l/proc/1/environ",
    "@l/etc/hostname",
  ]) {
    const out = await run(root, "Read", { file_path: bad });
    assert.match(out, /outside the review checkout/, bad);
  }

  // And an `@`-prefixed path that stays inside is still allowed, so the strip did
  // not simply turn every `@` argument into a refusal.
  assert.match(await run(root, "Read", { file_path: "@src/a.ts" }), /alpha/);
});

test("Read reports a missing file rather than throwing", async () => {
  // A thrown tool error becomes a run failure; the model reads tool output, so a
  // missing file has to be something it can see and move on from.
  const root = checkout();
  const out = await run(root, "Read", { file_path: "nope.ts" });
  assert.match(out, /Could not read nope\.ts/);
});

test("Grep matches with a regular expression and reports path:line:text", async () => {
  const root = checkout();
  const out = await run(root, "Grep", { pattern: "bet" });
  assert.match(out, /src\/a\.ts:2:beta/);
  assert.equal(await run(root, "Grep", { pattern: "nothing-matches-this" }), "No matches found.");
});

test("Grep refuses a path outside the checkout and an invalid expression", async () => {
  const root = checkout();
  assert.match(await run(root, "Grep", { pattern: "x", path: "/etc" }), /outside the review checkout/);
  assert.match(await run(root, "Grep", { pattern: "(" }), /Invalid regular expression/);
});

test("Grep's output_mode changes the shape, and a glob narrows the search", async () => {
  const root = checkout();
  assert.match(await run(root, "Grep", { pattern: "alpha", output_mode: "files_with_matches" }), /^src\/a\.ts$/);
  assert.match(await run(root, "Grep", { pattern: "alpha", output_mode: "count" }), /^src\/a\.ts:1$/);
  // `*.md` finds README.md and not src/a.ts, and the pattern has to occur in the
  // file for it to appear at all.
  writeFileSync(join(root, "NOTES.md"), "alpha\n");
  const md = await run(root, "Grep", { pattern: "alpha", glob: "*.md", output_mode: "files_with_matches" });
  assert.equal(md, "NOTES.md");
});

test("Glob finds files by pattern and refuses a start path outside", async () => {
  const root = checkout();
  const out = await run(root, "Glob", { pattern: "*.ts" });
  assert.match(out, /src\/a\.ts/);
  assert.match(await run(root, "Glob", { pattern: "*", path: "/etc" }), /outside the review checkout/);
});

test("Grep and Glob do not walk through a symlink committed in the checkout", async () => {
  // The PR author owns the checkout, so a symlink is a file they can commit. The
  // walk used to check containment only on the path the model named, then recurse
  // with `statSync`/`readdirSync`/`readFileSync`, all of which follow links — so a
  // search from `.` reached `/proc/self/environ` and could quote it into a posted
  // review. Every entry is re-checked now. Both directions are asserted, so a
  // future "optimisation" that skips the per-entry check fails here.
  const root = checkout();
  symlinkSync("/", join(root, "l"));
  symlinkSync("/etc", join(root, "etc-link"));

  // A pattern that matches any line: if the walk follows the link, `/etc/passwd`
  // and the rest of the filesystem come back as matches.
  const grep = await run(root, "Grep", { pattern: "." });
  assert.doesNotMatch(grep, /root:/, "a symlinked / must not be searched");
  assert.doesNotMatch(grep, /etc-link\//, "a symlinked /etc must not be listed");
  // The checkout's own files are still found, so the check is not simply refusing
  // everything.
  assert.match(grep, /src\/a\.ts/);

  const glob = await run(root, "Glob", { pattern: "**/*" });
  assert.doesNotMatch(glob, /^l\//m, "a symlinked / must not be walked");
  assert.doesNotMatch(glob, /^etc-link\//m, "a symlinked /etc must not be walked");
  assert.match(glob, /src\/a\.ts/);
});

test("a pair of symlink loops inside the checkout does not blow the walk up", async () => {
  // `a -> .` alone is survivable by accident: the kernel allows 40 symlinks per
  // path resolution, so the walk descends 40 levels and stops. Two of them branch
  // at every level — on the order of 2^40 paths — and the review hangs until the
  // task deadline kills it, which fails the run for a PR that committed two
  // innocent-looking links. Both walks keep a set of visited real paths now, so
  // each directory is entered once. The assertion is the timing, because that is
  // the property: completing at all is what the exponential walk cannot do.
  const root = checkout();
  symlinkSync(".", join(root, "loop-a"));
  symlinkSync(".", join(root, "loop-b"));

  const started = Date.now();
  const grep = await run(root, "Grep", { pattern: "alpha" });
  const glob = await run(root, "Glob", { pattern: "**/*" });
  const elapsed = Date.now() - started;

  assert.match(grep, /src\/a\.ts/, "the checkout is still searched");
  assert.match(glob, /src\/a\.ts/);
  // A generous bound: the honest walk is milliseconds, the exponential one does
  // not finish at all. Anything above a few seconds means the set stopped working.
  assert.ok(elapsed < 5_000, `the walks finished in ${elapsed}ms`);
});

test("globToRegExp handles the two forms a model actually writes", () => {
  // `*.ts` matches at any depth (a model that has used any other glob expects
  // that), and `src/**/*.ts` matches under `src/` at any depth including none.
  const bare = globToRegExp("*.ts");
  assert.ok(bare.test("a.ts"));
  assert.ok(bare.test("src/deep/a.ts"));
  assert.equal(bare.test("a.md"), false);

  const scoped = globToRegExp("src/**/*.ts");
  assert.ok(scoped.test("src/a.ts"));
  assert.ok(scoped.test("src/deep/a.ts"));
  assert.equal(scoped.test("lib/a.ts"), false);
});

test("confineTo resolves a candidate inside the root and reports it", () => {
  // The `resolved` half is what a tool opens, so it has to be the normalised
  // spelling — otherwise the guard and the open could disagree, which is the
  // class of bug the both-spellings check exists to survive.
  const root = checkout();
  const confine = confineTo(root);
  assert.deepEqual(confine.check("src/a.ts"), { inside: true, resolved: join(root, "src", "a.ts") });
  assert.equal(confine.check("@src/a.ts").inside, true);
  assert.equal(confine.check("/etc/passwd").inside, false);
});

test("normalizeGuardPath is one implementation, re-exported for the guard", () => {
  // The guard module and the tools module must strip the same characters, or a
  // path one accepts is a path the other opens somewhere else.
  assert.equal(normalizeGuardPath("@/etc/hostname"), "/etc/hostname");
  assert.equal(normalizeGuardPath("\u00a0/etc/hostname"), "/etc/hostname");
  assert.equal(normalizeGuardPath("@@a"), "@a");
});
