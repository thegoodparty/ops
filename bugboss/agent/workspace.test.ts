import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { computePaths, startNpmCi } from "./run";
import {
  lockfileHash,
  npmCiNeeded,
  npmCiPidRecord,
  npmCiRunning,
  prepareCheckout,
  sweepWorkspaces,
} from "./workspace";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// A local origin, so a clone is real and a second one is detectable.
const makeOrigin = () => {
  const origin = mkdtempSync(join(tmpdir(), "bugboss-origin-"));
  git(origin, "init", "--quiet", "--initial-branch=main");
  git(origin, "config", "user.email", "t@example.com");
  git(origin, "config", "user.name", "t");
  writeFileSync(join(origin, "package-lock.json"), '{"lockfileVersion":3}');
  git(origin, "add", "-A");
  git(origin, "commit", "--quiet", "-m", "one");
  return origin;
};

test("a relaunch into an existing workspace keeps it, uncommitted work and all, and fetches", async () => {
  const origin = makeOrigin();
  const dest = join(mkdtempSync(join(tmpdir(), "bugboss-work-")), "inc-7", "omni");

  assert.equal(await prepareCheckout(origin, dest), "cloned");
  git(dest, "checkout", "--quiet", "-b", "fix/the-bug");
  writeFileSync(join(dest, "uncommitted.ts"), "half a fix");
  const gitDirMarker = join(dest, ".git", "not-a-fresh-clone");
  writeFileSync(gitDirMarker, "");
  // What a task killed inside a git command leaves behind.
  const locks = [
    join(dest, ".git", "index.lock"),
    join(dest, ".git", "HEAD.lock"),
    join(dest, ".git", "refs", "heads", "fix", "the-bug.lock"),
  ];
  for (const lock of locks) writeFileSync(lock, "");

  git(origin, "commit", "--quiet", "--allow-empty", "-m", "two");

  assert.equal(await prepareCheckout(origin, dest), "reused");
  assert.ok(existsSync(gitDirMarker), "the checkout was cloned again");
  assert.equal(readFileSync(join(dest, "uncommitted.ts"), "utf8"), "half a fix");
  assert.equal(git(dest, "branch", "--show-current"), "fix/the-bug");
  assert.equal(git(dest, "rev-parse", "origin/main"), git(origin, "rev-parse", "main"));
  for (const lock of locks) assert.ok(!existsSync(lock), lock);
});

test("a relaunch that cannot fetch still keeps the workspace, and says it did not fetch", async () => {
  const origin = makeOrigin();
  const dest = join(mkdtempSync(join(tmpdir(), "bugboss-work-")), "inc-7", "omni");
  await prepareCheckout(origin, dest);
  writeFileSync(join(dest, "uncommitted.ts"), "half a fix");
  git(dest, "remote", "set-url", "origin", join(origin, "gone"));

  assert.equal(await prepareCheckout(origin, dest), "reused_unfetched");
  assert.equal(readFileSync(join(dest, "uncommitted.ts"), "utf8"), "half a fix");
});

test("a missing workspace is cloned, and one a killed clone left half-made is cloned again", async () => {
  const origin = makeOrigin();
  const dest = join(mkdtempSync(join(tmpdir(), "bugboss-work-")), "inc-7", "omni");

  assert.equal(await prepareCheckout(origin, dest), "cloned");
  assert.ok(existsSync(join(dest, ".git")));
  assert.ok(!existsSync(`${dest}.partial`));

  const other = join(mkdtempSync(join(tmpdir(), "bugboss-work-")), "inc-8", "omni");
  mkdirSync(`${other}.partial/.git`, { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "stray"), "");
  assert.equal(await prepareCheckout(origin, other), "cloned");
  assert.equal(git(other, "rev-parse", "HEAD"), git(origin, "rev-parse", "main"));
  assert.ok(!existsSync(join(other, "stray")));
});

const installedWorkspace = () => {
  const paths = computePaths(mkdtempSync(join(tmpdir(), "bugboss-work-")), "inc-7");
  mkdirSync(join(paths.checkout, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(paths.checkout, "package-lock.json"), '{"lockfileVersion":3}');
  writeFileSync(paths.npmCiLog, "added 1 package");
  writeFileSync(paths.npmCiDone, `${lockfileHash(paths.checkout)}\n`);
  return paths;
};

test("an unchanged lockfile keeps node_modules across a relaunch", () => {
  const paths = installedWorkspace();

  assert.equal(npmCiNeeded(paths), false);
  startNpmCi(paths);
  assert.ok(existsSync(join(paths.checkout, "node_modules", "left-pad")));
  assert.ok(existsSync(paths.npmCiDone), "the agent's monitor still sees a finished install");
  assert.ok(!existsSync(paths.npmCiPid), "no install was started");
});

test("a changed lockfile, or an install the restart interrupted, needs npm ci again", () => {
  const changed = installedWorkspace();
  writeFileSync(join(changed.checkout, "package-lock.json"), '{"lockfileVersion":3,"x":1}');
  assert.equal(npmCiNeeded(changed), true);

  const interrupted = installedWorkspace();
  writeFileSync(interrupted.npmCiDone, "");
  assert.equal(npmCiNeeded(interrupted), true);
});

test("an install still running from an earlier launch in this task is not started twice", () => {
  const paths = installedWorkspace();
  writeFileSync(join(paths.checkout, "package-lock.json"), '{"changed":true}');

  writeFileSync(paths.npmCiPid, npmCiPidRecord(process.pid));
  assert.equal(npmCiRunning(paths.npmCiPid), true);
  assert.equal(npmCiNeeded(paths), false);

  // The same pid recorded by a task that no longer exists means nothing.
  writeFileSync(paths.npmCiPid, `another-boot:${process.pid}`);
  assert.equal(npmCiRunning(paths.npmCiPid), false);
  assert.equal(npmCiNeeded(paths), true);
});

test("the sweep moves only what it is told is removable, and never its own trash", async () => {
  const root = mkdtempSync(join(tmpdir(), "bugboss-work-"));
  for (const id of ["open", "closed"]) mkdirSync(join(root, id, "omni"), { recursive: true });
  mkdirSync(join(root, ".trash"));
  writeFileSync(join(root, "stray-file"), "");

  const swept = await sweepWorkspaces({
    workRoot: root,
    removable: (id) => id !== "open",
    now: () => 42,
  });

  assert.deepEqual(swept, ["closed"]);
  assert.ok(existsSync(join(root, "open", "omni")));
  assert.ok(existsSync(join(root, ".trash", "closed-42", "omni")));
  assert.ok(existsSync(join(root, "stray-file")));
});
