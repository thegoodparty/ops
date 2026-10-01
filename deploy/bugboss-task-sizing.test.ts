import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import {
  BUGBOSS_CPU,
  BUGBOSS_MEMORY,
  POSTGRES_CPU,
  POSTGRES_MEMORY,
  SQL_RUNNER_CPU,
  SQL_RUNNER_MEMORY,
  TASK_CPU,
  TASK_MEMORY,
  TEST_DB_URL,
} from "./components/bugboss";
import { resolveTestDatabase, TEST_DB_ENV_VAR } from "../bugboss/testdb";

// A pulumi up is all-or-nothing, and a task definition whose containers ask
// for more than the task has is rejected at registration -- which takes the
// whole stack update with it, not just this resource. These are the two sums
// that can be wrong by a typo.
describe("the BugBoss task's container sizing", () => {
  it("does not promise more memory than the task has", () => {
    const total = BUGBOSS_MEMORY + POSTGRES_MEMORY + SQL_RUNNER_MEMORY;
    assert.ok(total <= TASK_MEMORY, `containers ask for ${total} MiB of ${TASK_MEMORY}`);
  });

  it("does not promise more cpu than the task has", () => {
    const total = BUGBOSS_CPU + POSTGRES_CPU + SQL_RUNNER_CPU;
    assert.ok(total <= TASK_CPU, `containers ask for ${total} units of ${TASK_CPU}`);
  });

  // Fargate rejects a task definition whose cpu/memory pair is not one it
  // supports, and a rejected registration fails the whole stack update rather
  // than this one resource. The table for 4 vCPU is 8 GB to 30 GB in 1 GB
  // steps: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-cpu-memory-error.html
  it("asks for a cpu and memory pair Fargate actually offers", () => {
    assert.equal(TASK_CPU, 4096, "the bounds below are the 4 vCPU row");
    assert.ok(TASK_MEMORY >= 8192, `${TASK_MEMORY} is below the 8 GB floor`);
    assert.ok(TASK_MEMORY <= 30720, `${TASK_MEMORY} is above the 30 GB ceiling`);
    assert.equal(TASK_MEMORY % 1024, 0, `${TASK_MEMORY} is not a whole GB`);
  });

  it("leaves the Boss and its fifteen agents the bulk of the task", () => {
    // The sidecar is a test database for a handful of near-empty schemas, not
    // a workload. If this ever needs a larger share, buy a larger task rather
    // than take it from the agents.
    assert.ok(POSTGRES_MEMORY <= TASK_MEMORY / 4);
    assert.ok(POSTGRES_CPU <= TASK_CPU / 4);
  });
});

describe("the test database URL this deploy writes", () => {
  it("is one the Boss will accept and hand to an agent", () => {
    const resolved = resolveTestDatabase({ [TEST_DB_ENV_VAR]: TEST_DB_URL });

    assert.equal(resolved.state, "configured");
    if (resolved.state !== "configured") return;
    assert.equal(resolved.host, "127.0.0.1");
    assert.equal(resolved.port, 5432);
  });
});

/**
 * The Pulumi program is compiled by ts-node from `deploy/`, which has no
 * tsconfig of its own -- so it runs on ts-node's default
 * `moduleResolution: node`, not the `NodeNext` the root tsconfig sets. Under
 * that setting a package export-map subpath does not resolve, and
 * `bugboss/bedrock/model.ts` has one. Importing it from here therefore fails
 * `pulumi preview` with a TS2307 that `npm run build` and `tsc --noEmit`
 * both pass clean, so the first sign of it is a red PR.
 *
 * `bugboss/bedrock/defaults.ts` exists to be the import that is safe. This
 * compiles the program the way Pulumi will rather than asserting anything
 * about which files it names, because the next one to reach into `bugboss/`
 * will not be this one.
 */
describe("the Pulumi program under the resolution Pulumi actually uses", () => {
  it("compiles, so a reachable export-map subpath cannot pass tsc and fail preview", () => {
    const repoRoot = join(__dirname, "..");
    execFileSync(
      join(repoRoot, "node_modules", ".bin", "tsc"),
      [
        "--noEmit",
        "--moduleResolution",
        "node",
        "--module",
        "commonjs",
        "--target",
        "es2022",
        "--esModuleInterop",
        "--skipLibCheck",
        "--strict",
        "--resolveJsonModule",
        join("deploy", "index.ts"),
      ],
      { cwd: repoRoot, stdio: "pipe" },
    );
  });
});
