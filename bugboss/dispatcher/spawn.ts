// The spawn boundary. Design spec: docs/bugboss/design.md, Job 3 and
// Topology.
//
// Agents are child processes of the Boss, not separate ECS tasks, so the
// dispatcher's "is it alive" question is answered in-process. This file is
// the one seam: the dispatcher decides what to launch and when to kill it,
// and something else decides what launching means. In prod that is
// createChildProcessSpawn; in the E2E it is a function that drives the tool
// API directly.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

import type { ToolApi } from "../types";

/** A live child the deadline backstop can reach. */
export interface AgentProcess {
  pid: number;
  /** SIGKILL. The agent's own deadline cannot fire inside a wedged agent. */
  kill: () => void;
}

/**
 * Everything a launch is handed. It extends ToolApi so an in-process agent
 * can act on its incident without a socket, which is what lets a test
 * substitute a fake; a real child ignores those methods and reaches the same
 * API over loopback with `token`.
 */
export interface AgentSpawnContext extends ToolApi {
  incidentId: string;
  /** Null on a first launch. Non-null means resume, never restart. */
  sessionRef: string | null;
  /** 1 on the first launch. */
  attempt: number;
  /** Epoch ms. The agent's in-container deadline; the parent is the backstop. */
  deadlineAt: number;
  /** Bearer for the tool API, scoped to this incident alone. */
  token: string;
  /** The child's complete environment. Nothing is inherited. */
  env: Record<string, string>;
  /**
   * A real child registers itself so the deadline backstop can kill it. An
   * in-process agent never calls this and is bounded by its own promise.
   */
  register: (proc: AgentProcess) => void;
}

/** Resolves when the agent is done, however it ended. */
export type SpawnAgent = (ctx: AgentSpawnContext) => Promise<void>;

export interface ChildProcessSpawnConfig {
  /** Node entrypoint for the incident agent. */
  modulePath: string;
  execPath?: string;
  args?: string[];
  cwd?: string;
  /** Seam for tests; defaults to node:child_process spawn. */
  spawnFn?: typeof nodeSpawn;
}

export const createChildProcessSpawn = (
  cfg: ChildProcessSpawnConfig,
): SpawnAgent => {
  const spawnFn = cfg.spawnFn ?? nodeSpawn;
  return (ctx) =>
    new Promise<void>((resolve, reject) => {
      const child: ChildProcess = spawnFn(
        cfg.execPath ?? process.execPath,
        [cfg.modulePath, ...(cfg.args ?? [])],
        {
          cwd: cfg.cwd,
          // Passing env explicitly is the scrub: node does not merge it with
          // the parent's environment.
          env: ctx.env,
          stdio: ["ignore", "inherit", "inherit"],
        },
      );

      ctx.register({
        pid: child.pid ?? 0,
        kill: () => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        },
      });

      child.once("error", reject);
      // The exit status is the only thing a dying agent gets to say: run.ts
      // exits 1 from its failure handler. Resolving on any exit made a crash
      // byte-identical to a clean hand_off, so `agent_failed` could only ever
      // fire for a spawn that never started at all.
      child.once("exit", (code, signal) => {
        if (signal) reject(new Error(`agent killed by ${signal}`));
        else if (code !== 0) reject(new Error(`agent exited ${code}`));
        else resolve();
      });
    });
};
