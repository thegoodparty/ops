// The incident agent's workspace, `/work/<id>`, and what keeps it across
// restarts. `/work` is an EFS mount (deploy/components/bugboss.ts), so the
// checkout, its node_modules and whatever the agent had not committed yet
// outlive the task that every ops deploy replaces. This file is the part that
// makes a relaunch use them instead of starting over, and the part that
// deletes them once nothing will relaunch into them.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeAlarm } from "../logging";

const alarm = makeAlarm("workspace");

export const DEFAULT_WORK_ROOT = "/work";
export const DEFAULT_OMNI_REPO = "https://github.com/thegoodparty/omni.git";

export interface AgentPaths {
  workDir: string;
  checkout: string;
  npmCiLog: string;
  npmCiDone: string;
  npmCiFailed: string;
  npmCiPid: string;
}

export const computePaths = (workRoot: string, incidentId: string): AgentPaths => {
  const workDir = join(workRoot, incidentId);
  return {
    workDir,
    checkout: join(workDir, "omni"),
    npmCiLog: join(workDir, "npm-ci.log"),
    npmCiDone: join(workDir, "npm-ci.done"),
    npmCiFailed: join(workDir, "npm-ci.failed"),
    npmCiPid: join(workDir, "npm-ci.pid"),
  };
};

const exec = (
  command: string,
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, env, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${command} failed: ${stderr || stdout || error.message}`));
        else resolve(stdout);
      },
    );
  });

/**
 * `cloned` is a first launch or a lost workspace; `reused` is a relaunch that
 * kept its work; `reused_unfetched` kept it but could not fetch, so origin is
 * as stale as the restart left it and the agent has to be told.
 */
export type CheckoutOutcome = "cloned" | "reused" | "reused_unfetched";

// Every lock git holds while it writes: index.lock, HEAD.lock,
// packed-refs.lock, refs/**/<name>.lock, config.lock. Objects are skipped:
// git takes no locks there, and it is most of the tree.
const staleGitLocks = async (dir: string): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "objects") found.push(...(await staleGitLocks(path)));
    } else if (entry.name.endsWith(".lock")) {
      found.push(path);
    }
  }
  return found;
};

/**
 * A partial clone, not a shallow one: investigation is half git history, and
 * `--depth 1` is blind to it. Blobs are fetched on demand.
 *
 * An existing checkout is kept as it is -- branch, index, uncommitted edits --
 * and only fetched, because the edits are the work a restart used to throw
 * away. The clone lands beside `dest` and is renamed into place, so a task
 * killed mid-clone leaves a `.partial` directory rather than a `.git` that
 * looks whole and is not.
 *
 * `env` is git's whole environment when given. This runs in the Boss process,
 * whose own environment holds every secret it has, and the clone needs only
 * PATH, HOME and a GitHub token.
 */
export const prepareCheckout = async (
  repoUrl: string,
  dest: string,
  env?: Record<string, string>,
): Promise<CheckoutOutcome> => {
  if (existsSync(join(dest, ".git"))) {
    // Left by a git command the last task died inside. Nothing else can be
    // holding them: one agent per incident, and the previous one is dead or
    // this launch would not be happening. Left in place, every git command
    // the agent runs fails until it works out why.
    for (const lock of await staleGitLocks(join(dest, ".git"))) {
      await rm(lock, { force: true });
    }
    try {
      await exec("git", ["fetch", "--quiet", "origin"], dest, env);
    } catch (error) {
      // A stale origin is something the agent can fix with one command; a
      // launch that dies here takes the whole workspace's value with it.
      console.warn(
        JSON.stringify({
          component: "agent",
          event: "checkout_fetch_failed",
          dest,
          error: String(error),
        }),
      );
      return "reused_unfetched";
    }
    return "reused";
  }
  const partial = `${dest}.partial`;
  await rm(partial, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });
  await exec("git", ["clone", "--filter=blob:none", repoUrl, partial], undefined, env);
  await rename(partial, dest);
  return "cloned";
};

/** What node_modules was installed from. A different hash means a different tree. */
export const lockfileHash = (checkout: string): string => {
  const lockfile = join(checkout, "package-lock.json");
  if (!existsSync(lockfile)) return "no-lockfile";
  return createHash("sha256").update(readFileSync(lockfile)).digest("hex");
};

const bootId = (): string => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "";
  }
};

/** What `npmCiRunning` reads back: this boot, and the pid of the install. */
export const npmCiPidRecord = (pid: number): string => `${bootId()}:${pid}`;

/**
 * Whether the install recorded in the pid file is still going.
 *
 * It is detached from the agent, so it outlives an agent that crashed and is
 * being relaunched in the same task, and a second `npm ci` into the same
 * node_modules would corrupt both. The boot id is what makes a pid from a
 * task that no longer exists mean nothing: each Fargate task is its own VM,
 * and a live process that happens to hold the same number in the new one is
 * not that install.
 */
export const npmCiRunning = (pidFile: string): boolean => {
  let record: string;
  try {
    record = readFileSync(pidFile, "utf8").trim();
  } catch {
    return false;
  }
  const split = record.lastIndexOf(":");
  if (record.slice(0, split) !== bootId()) return false;
  const pid = Number(record.slice(split + 1));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export interface NpmCiMarkers {
  checkout: string;
  npmCiDone: string;
  npmCiFailed: string;
  npmCiPid: string;
}

/**
 * Whether `npm ci` has to run. node_modules is kept when the done marker
 * names the lockfile the checkout has now, which is the whole point of it
 * surviving a restart: an install is minutes, and a relaunch that wiped it
 * cost incident 94 nine turns of finding out why its tests failed.
 *
 * A recorded failure is left alone, as it always was: the agent has read it
 * and can run `npm ci` itself.
 */
export const npmCiNeeded = (markers: NpmCiMarkers): boolean => {
  if (existsSync(markers.npmCiFailed)) return false;
  if (npmCiRunning(markers.npmCiPid)) return false;
  if (!existsSync(markers.npmCiDone)) return true;
  return readFileSync(markers.npmCiDone, "utf8").trim() !== lockfileHash(markers.checkout);
};

// The done marker holds the lockfile hash it installed, so a relaunch can
// tell node_modules it may keep from node_modules that no longer matches.
export const npmCiCommand = (paths: AgentPaths, lockHash: string): string =>
  `npm ci > ${paths.npmCiLog} 2>&1 && echo ${lockHash} > ${paths.npmCiDone} || cp ${paths.npmCiLog} ${paths.npmCiFailed}`;

/**
 * Starts `npm ci` detached and returns at once. `env` is the install's whole
 * environment when given, for the same reason as `prepareCheckout`'s, and
 * more so: an install runs the checkout's own postinstall scripts.
 */
export const startNpmCi = (paths: AgentPaths, env?: Record<string, string>): void => {
  if (!npmCiNeeded(paths)) return;
  rmSync(paths.npmCiDone, { force: true });
  const child = spawn("/bin/sh", ["-c", npmCiCommand(paths, lockfileHash(paths.checkout))], {
    cwd: paths.checkout,
    env,
    detached: true,
    stdio: "ignore",
  });
  // A spawn that cannot start (a missing checkout is ENOENT) arrives as an
  // `error` event, and an unheard one is an uncaughtException that restarts
  // the Boss and every agent with it. The failed marker is what the agent
  // and the next relaunch read, the same as an install that ran and failed.
  child.on("error", (err) => {
    let marker: string | undefined;
    try {
      mkdirSync(paths.workDir, { recursive: true });
      writeFileSync(paths.npmCiFailed, `npm ci did not start: ${String(err)}\n`);
    } catch (markerErr: unknown) {
      marker = String(markerErr);
    }
    alarm("npm_ci_spawn_failed", { checkout: paths.checkout, error: String(err), markerError: marker });
  });
  if (child.pid) writeFileSync(paths.npmCiPid, npmCiPidRecord(child.pid));
  child.unref();
};

/** Where a swept workspace waits to be deleted. A dot-name, so the sweep never reads it as an incident. */
export const TRASH_DIR = ".trash";

/**
 * Move every workspace nobody will relaunch into out of the way, and return
 * their incident ids.
 *
 * Only `removable` decides. It is a question about the database, and the
 * dispatcher is the one that can answer it together with which agents are
 * alive. A rename is a single metadata operation, so this is instant even on
 * a 5 GB tree; the delete itself is `emptyTrash`, which is slow on EFS and
 * must not hold up a tick.
 */
export const sweepWorkspaces = async (args: {
  workRoot: string;
  removable: (incidentId: string) => boolean;
  now?: () => number;
}): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(args.workRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const trash = join(args.workRoot, TRASH_DIR);
  const swept: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!args.removable(entry.name)) continue;
    await mkdir(trash, { recursive: true });
    await rename(
      join(args.workRoot, entry.name),
      join(trash, `${entry.name}-${(args.now ?? Date.now)()}`),
    );
    swept.push(entry.name);
  }
  return swept;
};

export const emptyTrash = async (workRoot: string): Promise<void> => {
  await rm(join(workRoot, TRASH_DIR), { recursive: true, force: true });
};
