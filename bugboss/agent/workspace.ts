// The incident agent's workspace, `/work/<id>`, and what keeps it across
// restarts. `/work` is an EFS mount (deploy/components/bugboss.ts), so the
// checkout, its node_modules and whatever the agent had not committed yet
// outlive the task that every ops deploy replaces. This file is the part that
// makes a relaunch use them instead of starting over, and the part that
// deletes them once nothing will relaunch into them.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const exec = (
  command: string,
  args: string[],
  cwd?: string,
  timeout?: number,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, timeout, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
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
 */
export const prepareCheckout = async (
  repoUrl: string,
  dest: string,
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
      await exec("git", ["fetch", "--quiet", "origin"], dest);
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
  await exec("git", ["clone", "--filter=blob:none", repoUrl, partial]);
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

/** Where a swept workspace waits to be deleted. A dot-name, so the sweep never reads it as an incident. */
export const TRASH_DIR = ".trash";

/**
 * Move every workspace nobody will relaunch into out of the way, and return
 * their incident ids.
 *
 * Only `removable` decides. It is a question about the database, and the
 * dispatcher is the one that can answer it together with which children are
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

// In a child process, never `fs.rm`. Node's recursive rm queues one libuv
// threadpool task per file, and the Boss's DNS lookups wait in that same
// four-thread queue. Emptying a workspace with node_modules on EFS starved
// every new outbound connection for minutes: Slack, S3 and Bedrock calls all
// timed out while the event loop itself stayed healthy.
//
// The deadline is above the 23 minutes a full omni workspace took on 10-01. A
// killed rm loses nothing: the next tick's rm starts on what is left.
export const emptyTrash = async (workRoot: string): Promise<void> => {
  await exec("rm", ["-rf", join(workRoot, TRASH_DIR)], undefined, 45 * 60 * 1000);
};
