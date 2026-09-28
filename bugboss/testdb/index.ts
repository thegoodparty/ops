// The Postgres an incident agent runs omni's database-backed tests against.
//
// omni's harness starts its own Postgres with testcontainers, which needs a
// Docker socket. Fargate has none, so an agent could not run 200 of gp-api's
// 576 test files at all: it wrote fixes whose only check was a fourteen-minute
// CI round trip. A sidecar container in this task shares the network
// namespace, so one Postgres on loopback serves every agent, and omni takes it
// by URL instead of starting one.
//
// Isolation between the fifteen agents that can share it is omni's, not ours.
// Its harness was already built for "one container serves every checkout on
// the machine": a template named for a digest of the migrations it holds, a
// per-suite clone the suite drops in afterAll, and an age-gated sweep for
// clones a killed run left behind. This task is that machine.

import { connect } from "node:net";

import type { TestDatabase } from "../types";

/** Read by omni's test harness. One name serves gp-api and election-api. */
export const TEST_DB_ENV_VAR = "OMNI_TEST_POSTGRES_URL";

const DEFAULT_PORT = 5432;

// new URL() strips the brackets from an IPv6 literal on some Node versions and
// keeps them on others, so both spellings are here rather than a normalizer.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * A URL off loopback is refused rather than passed on.
 *
 * This is not a fence around the agent — the value comes from the task
 * definition and nothing an agent can reach writes it. It is what stops a typo
 * in a container definition pointing fifteen agents' migration replay and
 * `DROP DATABASE ... WITH (FORCE)` at a real cluster. omni's election-api
 * harness has held the same guard since before any of this existed.
 */
export const resolveTestDatabase = (
  env: Record<string, string | undefined>,
): TestDatabase => {
  const url = env[TEST_DB_ENV_VAR];
  if (!url) return { state: "absent" };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { state: "refused", reason: `${TEST_DB_ENV_VAR} is not a URL` };
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    return {
      state: "refused",
      reason: `${TEST_DB_ENV_VAR} is not a Postgres URL (scheme ${parsed.protocol})`,
    };
  }

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    return {
      state: "refused",
      reason:
        `${TEST_DB_ENV_VAR} names host ${parsed.hostname}, which is not loopback. ` +
        "The test harness replays migrations and drops databases, so it may only " +
        "ever reach a Postgres inside this task.",
    };
  }

  // omni derives every per-suite database by replacing this path segment, so a
  // maintenance database called anything else silently produces a wrong URL.
  if (parsed.pathname !== "/postgres") {
    return {
      state: "refused",
      reason:
        `${TEST_DB_ENV_VAR} must name the maintenance database /postgres, not ` +
        `${parsed.pathname}`,
    };
  }

  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORT;
  return { state: "configured", url, host: parsed.hostname, port };
};

export interface TestDatabaseProbe {
  reachable: boolean;
  /** Absent when reachable. */
  error?: string;
}

/**
 * A TCP connect, not a query.
 *
 * Postgres runs initdb against a unix socket and only binds TCP once it is
 * ready to serve, so an accepted connection on this port is the readiness
 * signal, and a client library would be a dependency in both images for no
 * further answer. What this cannot tell apart is a credential mismatch, which
 * is static configuration rather than a runtime failure, and which omni
 * reports by name at the moment a suite runs.
 */
export const probeTestDatabase = (
  target: { host: string; port: number },
  timeoutMs = 2000,
): Promise<TestDatabaseProbe> =>
  new Promise((resolve) => {
    const socket = connect({ host: target.host, port: target.port });
    const settle = (result: TestDatabaseProbe): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle({ reachable: true }));
    socket.once("timeout", () =>
      settle({ reachable: false, error: `no answer in ${timeoutMs}ms` }),
    );
    socket.once("error", (error: Error) =>
      settle({ reachable: false, error: error.message }),
    );
  });

/**
 * How long a cold sidecar is given before its silence means anything.
 *
 * Both containers start together, and Postgres runs initdb before it binds
 * TCP, so at the moment the Boss finishes booting the sidecar is normally not
 * listening yet. A single probe there alarms on every cold deploy, and an
 * alarm that fires during normal operation teaches people to ignore alarms.
 *
 * 90 seconds is past the 60 the sidecar's own health check allows itself as a
 * start period, and far past the few seconds initdb actually takes on a schema
 * this size.
 */
export const TEST_DB_READY_DEADLINE_MS = 90_000;
const RETRY_INTERVAL_MS = 2_000;

export interface TestDatabaseWait extends TestDatabaseProbe {
  /** How long it took to answer. Makes a slow start visible before it fails. */
  waitedMs: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Probe until it answers or the deadline passes, so a cold start is a wait
 * rather than a failure. Never rejects: the caller decides what silence means.
 */
export const awaitTestDatabase = async (
  target: { host: string; port: number },
  deadlineMs = TEST_DB_READY_DEADLINE_MS,
  now: () => number = Date.now,
): Promise<TestDatabaseWait> => {
  const started = now();
  let last: TestDatabaseProbe = { reachable: false, error: "not probed" };

  while (true) {
    last = await probeTestDatabase(target);
    if (last.reachable) return { ...last, waitedMs: now() - started };
    if (now() - started + RETRY_INTERVAL_MS >= deadlineMs) {
      return { ...last, waitedMs: now() - started };
    }
    await sleep(RETRY_INTERVAL_MS);
  }
};
