import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildBundle, priorFindingsFrom } from "./bundle";
import type { createGitHub } from "./github";
import type { ReviewRecord } from "./schema";

describe("priorFindingsFrom", () => {
  it("returns empty array for undefined record", () => {
    assert.deepEqual(priorFindingsFrom(undefined), []);
  });

  it("maps record findings to PriorFinding with headSha from the record", () => {
    const record = {
      headSha: "abc123",
      findings: [
        {
          id: "00000000-0000-0000-0000-000000000001",
          path: "src/foo.ts",
          line: 10,
          body: "A bug",
          category: "bugs" as const,
          confidence: "high" as const,
          demoted: false,
        },
        {
          id: "00000000-0000-0000-0000-000000000002",
          path: "src/bar.ts",
          line: 20,
          body: "Security issue",
          category: "security" as const,
          confidence: "medium" as const,
          demoted: false,
          commentId: 999,
        },
      ],
    } as unknown as ReviewRecord;

    const result = priorFindingsFrom(record);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      id: "00000000-0000-0000-0000-000000000001",
      path: "src/foo.ts",
      line: 10,
      body: "A bug",
      category: "bugs",
      headSha: "abc123",
    });
    assert.deepEqual(result[1], {
      id: "00000000-0000-0000-0000-000000000002",
      path: "src/bar.ts",
      line: 20,
      body: "Security issue",
      category: "security",
      headSha: "abc123",
    });
  });
});

describe("buildBundle", () => {
  let tempDir: string;
  let baseSha: string;
  let headSha: string;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: tempDir, encoding: "utf8" }).trim();

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bundle-test-"));
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");

    writeFileSync(join(tempDir, "foo.ts"), "const x = 1;\n");
    writeFileSync(join(tempDir, "gone.ts"), "const deletedBody = 1;\n");
    git("add", ".");
    git("commit", "-m", "base commit");
    baseSha = git("rev-parse", "HEAD");

    writeFileSync(join(tempDir, "foo.ts"), "const x = 2;\n");
    rmSync(join(tempDir, "gone.ts"));
    git("add", ".");
    git("commit", "-m", "pr change");
    headSha = git("rev-parse", "HEAD");
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("builds bundle with correct metadata from github and git-computed diff", async () => {
    const capturedBase = baseSha;
    const stubGitHub = {
      getPull: async (_repo: string, _prNumber: number) => ({
        headSha: "unused-by-bundle",
        baseSha: capturedBase,
        baseRef: "main",
        title: "Test PR",
        body: "PR description",
        author: "testuser",
        isDraft: false,
        changedFiles: ["foo.ts"],
      }),
    } as unknown as ReturnType<typeof createGitHub>;

    const bundle = await buildBundle({
      repo: "acme/test-repo",
      prNumber: 1,
      reviewDir: tempDir,
      github: stubGitHub,
      priorFindings: [],
    });

    assert.equal(bundle.repo, "acme/test-repo");
    assert.equal(bundle.prNumber, 1);
    assert.equal(bundle.baseRef, "main");
    assert.equal(bundle.baseSha, capturedBase);
    assert.equal(bundle.headSha, headSha);
    assert.equal(bundle.author, "testuser");
    assert.equal(bundle.title, "Test PR");
    assert.equal(bundle.body, "PR description");
    assert.deepEqual(bundle.changedFiles, ["foo.ts", "gone.ts"]);
    assert.deepEqual(bundle.priorFindings, []);

    assert.ok(bundle.diff.includes("foo.ts"), "diff should reference the changed file");
    assert.ok(bundle.diff.includes("-const x = 1"), "diff should show removed line");
    assert.ok(bundle.diff.includes("+const x = 2"), "diff should show added line");
    assert.ok(bundle.diff.includes("deleted file mode"), "diff should name the deleted file");
    assert.ok(!bundle.diff.includes("deletedBody"), "diff should omit a deleted file's contents");
  });

  it("changedFiles is empty when merge-base equals HEAD", async () => {
    const capturedHead = headSha;
    const stubGitHub = {
      getPull: async () => ({
        headSha: capturedHead,
        baseSha: capturedHead,
        baseRef: "main",
        title: "No changes",
        body: "",
        author: "testuser",
        isDraft: false,
        changedFiles: [],
      }),
    } as unknown as ReturnType<typeof createGitHub>;

    const bundle = await buildBundle({
      repo: "acme/test-repo",
      prNumber: 2,
      reviewDir: tempDir,
      github: stubGitHub,
      priorFindings: [],
    });

    assert.deepEqual(bundle.changedFiles, []);
    assert.equal(bundle.diff, "");
  });

  it("passes priorFindings through to bundle", async () => {
    const priorFindings = [
      {
        id: "00000000-0000-0000-0000-000000000099",
        path: "src/old.ts",
        line: 5,
        body: "old finding",
        category: "bugs" as const,
        headSha: "oldshavalue",
      },
    ];

    const capturedBase = baseSha;
    const stubGitHub = {
      getPull: async () => ({
        headSha: "unused",
        baseSha: capturedBase,
        baseRef: "main",
        title: "T",
        body: "",
        author: "u",
        isDraft: false,
        changedFiles: [],
      }),
    } as unknown as ReturnType<typeof createGitHub>;

    const bundle = await buildBundle({
      repo: "acme/test-repo",
      prNumber: 3,
      reviewDir: tempDir,
      github: stubGitHub,
      priorFindings,
    });

    assert.deepEqual(bundle.priorFindings, priorFindings);
  });
});
