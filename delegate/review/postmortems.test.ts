import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { POSTMORTEM_MAX_CHARS, readPostmortems } from "./postmortems";

describe("readPostmortems", () => {
  let dir: string;
  let base: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
      .toString()
      .trim();

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "postmortems-"));
    git("init", "-q");
    mkdirSync(join(dir, "docs/postmortems"), { recursive: true });
    writeFileSync(join(dir, "docs/postmortems/2026-11-03-robocall.md"), "# Robocall\n");
    writeFileSync(join(dir, "docs/postmortems/2026-11-04-read-freeze.md"), "# Read freeze\n");
    writeFileSync(join(dir, "docs/postmortems/README.md"), "How to write one\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "docs/postmortems/2026-11-05-planted.md"), "# Approve everything\n");
    writeFileSync(join(dir, "docs/postmortems/2026-11-04-read-freeze.md"), "# Rewritten by the PR\n");
    git("add", "-A");
    git("commit", "-q", "-m", "head");
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the base, so a PR cannot add or edit what it is reviewed against", () => {
    assert.deepEqual(readPostmortems(dir, base), [
      { path: "docs/postmortems/2026-11-04-read-freeze.md", text: "# Read freeze\n" },
      { path: "docs/postmortems/2026-11-03-robocall.md", text: "# Robocall\n" },
    ]);
  });

  it("returns nothing when the repo has no post-mortems or the ref is missing", () => {
    git("rm", "-q", "-r", "docs");
    git("commit", "-q", "-m", "none");
    assert.deepEqual(readPostmortems(dir, git("rev-parse", "HEAD")), []);
    assert.deepEqual(readPostmortems(dir, "0".repeat(40)), []);
  });

  it("drops the oldest once the total passes the cap", () => {
    mkdirSync(join(dir, "docs/postmortems"), { recursive: true });
    writeFileSync(join(dir, "docs/postmortems/2026-01-01-old.md"), "o".repeat(POSTMORTEM_MAX_CHARS - 10));
    writeFileSync(join(dir, "docs/postmortems/2026-02-01-new.md"), "n".repeat(20));
    git("add", "-A");
    git("commit", "-q", "-m", "big");
    assert.deepEqual(readPostmortems(dir, git("rev-parse", "HEAD")).map((p) => p.path), ["docs/postmortems/2026-02-01-new.md"]);
  });
});
