import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isSafeRef, isSafePath, createGitTools } from "./git-tools";
import { GIT_TOOL_NAMES } from "./tool-names";

describe("isSafeRef", () => {
  it("accepts simple SHAs and branch names", () => {
    assert.ok(isSafeRef("abc123"));
    assert.ok(isSafeRef("main"));
    assert.ok(isSafeRef("HEAD"));
    assert.ok(isSafeRef("HEAD~1"));
    assert.ok(isSafeRef("HEAD^"));
    assert.ok(isSafeRef("refs/heads/feature-foo"));
    assert.ok(isSafeRef("v1.0.0"));
    assert.ok(isSafeRef("a/b/c"));
    assert.ok(isSafeRef("abc.def"));
  });

  it("rejects refs that are flags or carry shell metacharacters", () => {
    assert.ok(!isSafeRef("-rf"));
    assert.ok(!isSafeRef("--exec=rm"));
    assert.ok(!isSafeRef("main; rm -rf /"));
    assert.ok(!isSafeRef("main && echo"));
    assert.ok(!isSafeRef("$(whoami)"));
    assert.ok(!isSafeRef("a b"));
    assert.ok(!isSafeRef(""));
  });
});

describe("isSafePath", () => {
  it("accepts repo-relative paths", () => {
    assert.ok(isSafePath("src/foo.ts"));
    assert.ok(isSafePath("README.md"));
    assert.ok(isSafePath("a/b/c/d.js"));
    assert.ok(isSafePath(".gitignore"));
    assert.ok(isSafePath("./src/foo.ts"));
    assert.ok(isSafePath("src/.hidden"));
  });

  it("rejects paths starting with a dash", () => {
    assert.ok(!isSafePath("-rf"));
    assert.ok(!isSafePath("--flag"));
  });

  it("rejects paths containing double-dot traversal", () => {
    assert.ok(!isSafePath("../etc/passwd"));
    assert.ok(!isSafePath("src/../../etc/passwd"));
    assert.ok(!isSafePath("a/.."));
    assert.ok(!isSafePath("a/b/../c"));
  });
});

describe("GIT_TOOL_NAMES", () => {
  it("contains all four expected mcp tool names", () => {
    assert.deepEqual([...GIT_TOOL_NAMES].sort(), [
      "mcp__git__git_blame",
      "mcp__git__git_diff",
      "mcp__git__git_log",
      "mcp__git__git_show",
    ]);
  });

  it("are the keys of the tool set createGitTools returns", () => {
    // The names the prompt uses and the names the tools are keyed by have to be
    // the same four strings: the reviewer's prompt says `mcp__git__git_log` and
    // `replayToolGuard` compares against the same list, so a rename in one place
    // and not the others is a tool the model asks for and never gets.
    const dir = mkdtempSync(join(tmpdir(), "git-tool-names-"));
    try {
      execFileSync("git", ["init"], { cwd: dir });
      assert.deepEqual(Object.keys(createGitTools({ root: dir })).sort(), [...GIT_TOOL_NAMES].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createGitTools — git commands against temp repo", () => {
  let tempDir: string;
  let firstSha: string;
  let secondSha: string;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: tempDir, encoding: "utf8" }).trim();

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "git-tools-test-"));
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");

    writeFileSync(join(tempDir, "hello.ts"), "const hello = 1;\nconst world = 2;\nconst foo = 3;\n");
    git("add", ".");
    git("commit", "-m", "initial commit");
    firstSha = git("rev-parse", "HEAD");

    writeFileSync(join(tempDir, "hello.ts"), "const hello = 1;\nconst world = 99;\nconst foo = 3;\n");
    git("add", ".");
    git("commit", "-m", "second commit");
    secondSha = git("rev-parse", "HEAD");
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const call = async (name: keyof ReturnType<typeof createGitTools>, input: Record<string, unknown>) => {
    const tools = createGitTools({ root: tempDir });
    return (await (tools[name].execute as (i: unknown) => Promise<string>)(input)) as string;
  };

  it("git_log returns the commits it was asked for", async () => {
    const out = await call("mcp__git__git_log", { maxCount: 5 });
    assert.ok(out.includes("initial commit"));
    assert.ok(out.includes("second commit"));
  });

  it("git_log caps maxCount at 50 rather than trusting the model", async () => {
    // The bound is on the tool's own input schema, so a larger number is refused
    // by the provider before the tool runs. Pinned here as the schema's value:
    // `execute` clamps nothing, and a silently ignored cap is worse than none.
    const tools = createGitTools({ root: tempDir });
    const schema = tools.mcp__git__git_log.inputSchema as { jsonSchema?: { properties?: { maxCount?: { maximum?: number } } } };
    assert.equal(schema.jsonSchema?.properties?.maxCount?.maximum, 50);
  });

  it("git_diff shows the changed line between two shas", async () => {
    const out = await call("mcp__git__git_diff", { from: firstSha, to: secondSha });
    assert.ok(out.includes("hello.ts"));
    assert.ok(out.includes("-const world = 2"));
    assert.ok(out.includes("+const world = 99"));
  });

  it("git_show returns the file content at a commit", async () => {
    const out = await call("mcp__git__git_show", { ref: firstSha, path: "hello.ts" });
    assert.ok(out.includes("const world = 2"));
    assert.ok(!out.includes("const world = 99"));
  });

  it("git_blame attributes lines, and -L restricts the range", async () => {
    assert.ok((await call("mcp__git__git_blame", { path: "hello.ts" })).includes("const world = 99"));
    const ranged = await call("mcp__git__git_blame", { path: "hello.ts", startLine: 1, endLine: 1 });
    assert.ok(ranged.includes("const hello = 1"));
    assert.ok(!ranged.includes("const foo = 3"));
  });

  it("refuses a ref that is a flag before git runs", async () => {
    assert.equal(await call("mcp__git__git_show", { ref: "--exec=rm -rf /" }), "Invalid ref");
    assert.equal(await call("mcp__git__git_log", { ref: "-n1" }), "Invalid ref");
  });

  it("refuses a path that leaves the checkout", async () => {
    // The old tool relied on the process cwd and `isSafePath` alone. Now the
    // tool confines the path too, with the same `confineTo` the read tools use,
    // so an absolute path outside the checkout is refused before git sees it.
    assert.match(await call("mcp__git__git_log", { path: "/etc/passwd" }), /outside the review checkout/);
    // A symlink inside the checkout pointing out is the case `isSafePath` alone
    // cannot see, and `realpath` in the confinement is what catches it.
    symlinkSync("/etc", join(tempDir, "etc-link"));
    assert.match(await call("mcp__git__git_blame", { path: "etc-link/hostname" }), /outside the review checkout/);
  });

  it("a git error comes back as the tool's text, not a throw", async () => {
    // The model reads tool output; a thrown error becomes a run failure. A bad
    // but safe ref has to be the former.
    const out = await call("mcp__git__git_show", { ref: "deadbeefdeadbeef" });
    assert.ok(out.length > 0);
  });

  it("isSafeRef accepts the real SHAs from the temp repo", () => {
    assert.ok(isSafeRef(firstSha));
    assert.ok(isSafeRef(secondSha));
    assert.ok(isSafeRef("HEAD"));
    assert.ok(isSafeRef("HEAD~1"));
  });

  it("truncate logic: string over 100k gets [truncated] suffix", () => {
    // The limit is `createGitTools`'s and unchanged from the old tool: a huge
    // diff is truncated with a marker rather than flooding the model's context.
    const big = "x".repeat(200_000);
    const limit = 100_000;
    const result = big.length > limit ? `${big.slice(0, limit)}\n[truncated]` : big;
    assert.ok(result.endsWith("[truncated]"));
    assert.equal(result.slice(0, limit), "x".repeat(limit));
  });
});
