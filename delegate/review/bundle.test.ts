import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
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
      path: "src/foo.ts",
      line: 10,
      body: "A bug",
      category: "bugs",
      headSha: "abc123",
    });
    assert.deepEqual(result[1], {
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
    git("add", ".");
    git("commit", "-m", "base commit");
    baseSha = git("rev-parse", "HEAD");

    writeFileSync(join(tempDir, "foo.ts"), "const x = 2;\n");
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
    assert.deepEqual(bundle.changedFiles, ["foo.ts"]);
    assert.deepEqual(bundle.priorFindings, []);

    assert.ok(bundle.diff.includes("foo.ts"), "diff should reference the changed file");
    assert.ok(bundle.diff.includes("-const x = 1"), "diff should show removed line");
    assert.ok(bundle.diff.includes("+const x = 2"), "diff should show added line");
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

// The plan is read only when the gate asked for it, and only from `main`.
// Every other path is the no-op guarantee: `DELEGATE_GATING_MODE=off` passes
// `resolvePlan: false`, and then this function makes exactly the GitHub calls
// it made before the gate existed.
describe("buildBundle plan resolution", () => {
  let tempDir: string;
  let baseSha: string;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: tempDir, encoding: "utf8" }).trim();

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bundle-plan-test-"));
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");
    writeFileSync(join(tempDir, "foo.ts"), "const x = 1;\n");
    git("add", ".");
    git("commit", "-m", "base commit");
    baseSha = git("rev-parse", "HEAD");
    writeFileSync(join(tempDir, "foo.ts"), "const x = 2;\n");
    git("add", ".");
    git("commit", "-m", "pr change");
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const PLAN_SHA = "1c7ac96f062c9263697f7208056f9941e4dc499a";

  const stub = (body: string, baseRef = "main") => {
    const calls: Array<{ path: string; ref: string }> = [];
    const github = {
      getPull: async () => ({
        headSha: "unused",
        baseSha,
        baseRef,
        title: "T",
        body,
        author: "u",
        isDraft: false,
        changedFiles: [],
      }),
      getFileAtRef: async (_repo: string, path: string, ref: string) => {
        calls.push({ path, ref });
        return path.endsWith(".md") ? { blobSha: PLAN_SHA, text: "# the plan\n" } : undefined;
      },
    } as unknown as ReturnType<typeof createGitHub>;
    return { github, calls };
  };

  const build = (github: ReturnType<typeof createGitHub>, resolvePlan?: boolean) =>
    buildBundle({
      repo: "thegoodparty/ops",
      prNumber: 4,
      reviewDir: tempDir,
      github,
      priorFindings: [],
      ...(resolvePlan !== undefined ? { resolvePlan } : {}),
    });

  it("makes no extra call and adds no plan when the gate is off", async () => {
    const { github, calls } = stub("Plan: docs/plan.md");
    for (const resolvePlan of [undefined, false]) {
      const bundle = await build(github, resolvePlan);
      assert.equal(bundle.plan, undefined);
    }
    assert.deepEqual(calls, []);
  });

  it("reads the bound plan at the base ref and puts it on the bundle", async () => {
    const { github, calls } = stub("Plan: docs/plan-gated-merges.md\nStep: 4");
    const bundle = await build(github, true);
    assert.deepEqual(calls, [{ path: "docs/plan-gated-merges.md", ref: "main" }]);
    assert.deepEqual(bundle.plan, {
      path: "docs/plan-gated-merges.md",
      blobSha: PLAN_SHA,
      text: "# the plan\n",
    });
  });

  it("does not read a plan off a base ref that is not main", async () => {
    const { github, calls } = stub("Plan: docs/plan.md", "release/2026");
    const bundle = await build(github, true);
    assert.deepEqual(calls, []);
    assert.equal(bundle.plan, undefined);
    assert.equal(bundle.baseRef, "release/2026");
  });

  it("does not read anything when the binding is absent, ambiguous or invalid", async () => {
    for (const body of [
      "no plan here",
      "Plan: docs/a.md\nPlan: docs/b.md",
      "Plan: README.md",
      "Plan: docs/a.txt",
    ]) {
      const { github, calls } = stub(body);
      const bundle = await build(github, true);
      assert.deepEqual(calls, [], body);
      assert.equal(bundle.plan, undefined, body);
    }
  });

  it("leaves the plan off the bundle when it does not exist at the base ref", async () => {
    const github = {
      getPull: async () => ({
        headSha: "unused",
        baseSha,
        baseRef: "main",
        title: "T",
        body: "Plan: docs/not-yet.md",
        author: "u",
        isDraft: false,
        changedFiles: [],
      }),
      getFileAtRef: async () => undefined,
    } as unknown as ReturnType<typeof createGitHub>;
    const bundle = await build(github, true);
    assert.equal(bundle.plan, undefined);
  });
});

// The authority check reads `changedFiles`, so that list must not hide a path.
// `git diff --name-only` reports only the destination of a rename and C-quotes
// non-ASCII paths; both can hide a path from `touches_docs` and from the
// ownership filter. Gated runs ask git for both sides and raw bytes. Ungated
// runs keep the old invocation, because `off` has to stay byte-identical.
describe("buildBundle changed paths for the authority check", () => {
  let tempDir: string;
  let baseSha: string;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: tempDir, encoding: "utf8" }).trim();

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bundle-rename-test-"));
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "docs", "plan.md"), "# plan\n");
    writeFileSync(join(tempDir, "docs", "café.md"), "# accent\n");
    writeFileSync(join(tempDir, "src", "keep.ts"), "export const a = 1;\n");
    git("add", ".");
    git("commit", "-m", "base");
    baseSha = git("rev-parse", "HEAD");

    // A rename out of docs/ and an edit to a non-ASCII path: the first is
    // reported only by its destination, the second is C-quoted.
    execFileSync("git", ["mv", "docs/plan.md", "src/plan.md"], { cwd: tempDir });
    writeFileSync(join(tempDir, "docs", "café.md"), "# accent, edited\n");
    git("add", ".");
    git("commit", "-m", "rename and edit");
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const build = (resolvePlan: boolean) =>
    buildBundle({
      repo: "thegoodparty/ops",
      prNumber: 5,
      reviewDir: tempDir,
      github: {
        getPull: async () => ({
          headSha: "unused",
          baseSha,
          baseRef: "main",
          title: "T",
          body: "no plan",
          author: "u",
          isDraft: false,
          changedFiles: [],
        }),
      } as unknown as ReturnType<typeof createGitHub>,
      priorFindings: [],
      resolvePlan,
    });

  it("keeps the pre-gate list when the gate is off", async () => {
    const bundle = await build(false);
    assert.deepEqual(bundle.changedFiles.sort(), ['"docs/caf\\303\\251.md"', "src/plan.md"].sort());
  });

  it("lists both sides of a rename and the raw path when the gate is on", async () => {
    const bundle = await build(true);
    assert.deepEqual(
      bundle.changedFiles.sort(),
      ["docs/café.md", "docs/plan.md", "src/plan.md"].sort(),
    );
  });
});
