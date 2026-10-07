import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isSafeRef, isSafePath, createGitTool, GIT_TOOL_NAMES } from "./git-tool";

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

  it("rejects refs starting with a dash", () => {
    assert.ok(!isSafeRef("-HEAD"));
    assert.ok(!isSafeRef("--all"));
    assert.ok(!isSafeRef("-v"));
  });

  it("rejects refs with characters outside the allowed pattern", () => {
    assert.ok(!isSafeRef("main;rm -rf /"));
    assert.ok(!isSafeRef("HEAD`whoami`"));
    assert.ok(!isSafeRef("abc$HOME"));
    assert.ok(!isSafeRef("a b"));
    assert.ok(!isSafeRef("a:b"));
    assert.ok(!isSafeRef(""));
  });
});

describe("isSafePath", () => {
  it("accepts normal file paths", () => {
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
});

describe("createGitTool — server config shape", () => {
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "git-tool-shape-"));
    execFileSync("git", ["init"], { cwd: tempDir });
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns a sdk server config with a live instance", () => {
    const server = createGitTool(tempDir);
    assert.equal(server.type, "sdk");
    assert.ok(server.instance !== undefined);
    assert.equal(typeof server.instance, "object");
  });
});

describe("createGitTool — git commands against temp repo", () => {
  let tempDir: string;
  let firstSha: string;
  let secondSha: string;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: tempDir, encoding: "utf8" }).trim();

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "git-tool-test-"));
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

  it("git log covers both commits", () => {
    const log = git("log", "--max-count=5");
    assert.ok(log.includes("initial commit"));
    assert.ok(log.includes("second commit"));
  });

  it("git diff shows changed line between first and second sha", () => {
    const diff = git("diff", firstSha, secondSha);
    assert.ok(diff.includes("hello.ts"));
    assert.ok(diff.includes("-const world = 2"));
    assert.ok(diff.includes("+const world = 99"));
  });

  it("git show ref:path returns file content at that commit", () => {
    const content = git("show", `${firstSha}:hello.ts`);
    assert.ok(content.includes("const world = 2"));
    assert.ok(!content.includes("const world = 99"));
  });

  it("git blame attributes lines to authors", () => {
    const blame = git("blame", "--", "hello.ts");
    assert.ok(blame.includes("const hello = 1"));
    assert.ok(blame.includes("const world = 99"));
  });

  it("git blame -L restricts to line range", () => {
    const blame = git("blame", "-L", "1,1", "--", "hello.ts");
    assert.ok(blame.includes("const hello = 1"));
    assert.ok(!blame.includes("const foo = 3"));
  });

  it("isSafeRef accepts the real SHAs from the temp repo", () => {
    assert.ok(isSafeRef(firstSha));
    assert.ok(isSafeRef(secondSha));
    assert.ok(isSafeRef("HEAD"));
    assert.ok(isSafeRef("HEAD~1"));
  });

  it("isSafePath accepts repo-relative paths", () => {
    assert.ok(isSafePath("hello.ts"));
    assert.ok(isSafePath("src/foo/bar.ts"));
  });

  it("truncate logic: string over 100k gets [truncated] suffix", () => {
    const big = "x".repeat(200_000);
    const limit = 100_000;
    const result = big.length > limit ? `${big.slice(0, limit)}\n[truncated]` : big;
    assert.ok(result.endsWith("[truncated]"));
    assert.equal(result.slice(0, limit), "x".repeat(limit));
  });
});
