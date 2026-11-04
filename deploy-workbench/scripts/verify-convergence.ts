import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { WORKBENCH_ACCOUNT_ID } from "../../utils/accounts";
import {
  VK_JANITOR_FUNCTION_NAME,
  VK_JANITOR_RETRY_MAX_MS,
  VK_JANITOR_RETRY_WINDOW_SECONDS,
  VK_JANITOR_TIMEOUT_SECONDS,
  retryDelayMs,
} from "../bifrost/vk-janitor-contract";
import {
  decideInvokeAttempt,
  pollOutcome,
  type InvokeAttempt,
  type PollOutcome,
  type ReconcilerDecision,
} from "../bifrost/reconciler-summary";
import { assumeRoleEnvironment, tryRunAws } from "./aws-role";

/**
 * Invoke the reconciler after the apply and fail the run when it did not
 * converge.
 *
 * Step 4 of `docs/bifrost-reconciler.md`, and decision 5 is the reason it
 * exists: a fire-and-forget `InvokeFunction` returns `202` and a request id
 * whether the reconciler converged or threw, so a workflow that invokes and
 * moves on goes green over a config that never landed. That is the `75d30ae`
 * class of bug with a different mechanism — the apply looks converged while the
 * gateway runs the old file — so this invokes with `InvocationType:
 * RequestResponse`, reads the summary the run returned, and fails on anything
 * that is not `converged`.
 *
 * ## Three outcomes, and why a throttle is not one of the failures
 *
 * The function is capped at `reservedConcurrentExecutions: 1`
 * (`bifrost-vk-janitor.ts`), so a capped function has no queue: an invoke that
 * arrives while a scheduled tick is running is **throttled**, not delayed, and
 * `RequestResponse` returns `TooManyRequestsException` (a `429`) rather than a
 * result. A deploy that went red over that would be red for a reason that has
 * nothing to do with the change, which is the wrong colour in the direction that
 * erodes trust in the signal.
 *
 * So the three states are kept apart, and `bifrost/reconciler-summary.ts` owns
 * the classification because the Lambda's own reply has to be readable the same
 * way:
 *
 * - **converged** — the run returned a summary whose `outcome` is `converged`.
 *   Exit 0.
 * - **not converged** — the run returned a summary that is not, a `200` with a
 *   `FunctionError` header, or no readable summary at all. Exit 1. Step 6's
 *   three-in-a-row alarm counts this.
 * - **never ran** — every attempt inside the window was throttled. Exit 1, with
 *   a message that says the function was never entered. Counted separately by
 *   whoever reads the log, and the answer to a pattern of them is a second rule,
 *   not a bigger cap.
 *
 * The retry window is `VK_JANITOR_RETRY_WINDOW_SECONDS` (300s), pinned above
 * `VK_JANITOR_TIMEOUT_SECONDS` (120s) at module load in
 * `bifrost/vk-janitor-contract.ts`: a tick cannot hold the reservation longer
 * than its own timeout, so a window shorter than that would expire while the run
 * the deploy is waiting behind is still legal.
 *
 * ## Why this hop, and that no IAM is needed
 *
 * Same-account IAM principal calling a function is authorised by the caller's
 * own policy; it needs no resource-based policy on the function at all. This
 * makes the identical `pulumi-deploy` hop `scripts/verify-service.ts` makes, and
 * that role is `AdministratorAccess` (`deploy-workbench/deploy-role.ts`), so the
 * invoke needs **no new grant**. Adding one would be decoration. If the deploy
 * path is ever narrowed to a scoped role, `lambda:InvokeFunction` on this one
 * function ARN is the single statement it needs, and this hop is the shape that
 * would carry it (`scripts/aws-role.ts`).
 *
 * The hop is made inside the script rather than with another
 * `configure-aws-credentials` step, for the reason `aws-role.ts` records: the
 * job's environment has to stay on the first-hop session, because the Bedrock
 * step after this one makes the same hop itself.
 */

const DEFAULT_ROLE_ARN = `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/pulumi-deploy`;
const DEFAULT_REGION = "us-west-2";

const argument = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const positiveNumber = (
  value: string | undefined,
  name: string,
  fallback: number,
): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got ${value}`);
  }
  return parsed;
};

/**
 * Whether a failed `aws lambda invoke` was the throttle.
 *
 * The CLI prints the service's error code in its message, and the SDK surfaces
 * the same code as an exception class. Both spellings are matched because the
 * CLI's wording is not a stable API: what is stable is
 * `TooManyRequestsException`, and reading a throttle as anything else is the
 * one mistake this function exists to prevent.
 *
 * Only ever called on a non-zero exit, and only its verdict is used — the
 * message is passed through to the log and cannot carry a credential, since a
 * throttle happens before the function is entered and no payload exists yet.
 */
export const isThrottle = (stderr: string): boolean =>
  /TooManyRequestsException|\b429\b/.test(stderr);

/**
 * Whether the response metadata says the run threw. `lambda invoke` exits 0 on a
 * `200`, and a `FunctionError` is a field of that response's metadata rather
 * than a non-zero exit, so the status alone cannot tell a run that converged
 * from one that threw.
 */
export const isFunctionError = (stdout: string): boolean =>
  /"FunctionError"\s*:|FunctionError|Unhandled exception|Runtime\.\w+/.test(stdout);

const invokeOnce = (args: {
  functionName: string;
  region: string;
  env: NodeJS.ProcessEnv;
  payload: string;
  outFile: string;
}): InvokeAttempt => {
  const result = tryRunAws(
    [
      "lambda",
      "invoke",
      "--function-name",
      args.functionName,
      "--invocation-type",
      // Load-bearing. `Event` returns before the work does and is green on a
      // failed convergence, which is the bug this whole script is here to stop.
      "RequestResponse",
      "--payload",
      args.payload,
      // The function's own timeout plus slack, so a slow run is reported as its
      // own result rather than cut off by the CLI's default three-second read.
      "--cli-read-timeout",
      String(VK_JANITOR_TIMEOUT_SECONDS + 60),
      "--region",
      args.region,
      args.outFile,
    ],
    args.env,
  );

  if (!result.ok) {
    if (isThrottle(result.stderr)) {
      return { kind: "throttled", message: "TooManyRequestsException" };
    }
    // Anything else is a failure to invoke rather than a run that failed, and it
    // must not be read as a convergence failure: the function was not entered.
    throw new Error(
      `aws lambda invoke failed (exit ${result.status ?? "no exit"}): ${result.stderr}`,
    );
  }

  // `aws lambda invoke` writes the run's own payload to `args.outFile` and the
  // **response metadata** to stdout: `{"StatusCode": 200, "FunctionError":
  // ...}`. So the marker that says the function threw is in stdout, above the
  // payload, and reading only the payload would go green on a run that failed.
  // (On success `tryRunAws` returns no stderr, which is why this reads the
  // stream the metadata is actually on.)
  if (isFunctionError(result.stdout)) {
    return { kind: "function-error", message: firstLine(result.stdout) };
  }

  let payload: unknown;
  try {
    payload = fs.readFileSync(args.outFile, "utf8");
  } catch {
    payload = undefined;
  }
  return { kind: "ok", payload };
};

const firstLine = (text: string): string =>
  text.split("\n").map((line) => line.trim()).find((line) => line !== "") ??
  "no message";

/**
 * The retry loop, with the clock and the invoke injected so a test can drive the
 * throttle case without AWS and without waiting.
 *
 * The loop stops at the first decision that is not a retry — a run that
 * converged, or one that did not — and only an exhausted window turns a series
 * of throttles into `never-ran`. Retries are capped at the window: the delay is
 * taken from `retryDelayMs` and the loop refuses to start an attempt it cannot
 * finish inside the deadline, so the script cannot outlive the job by sleeping.
 */
export const pollForConvergence = async (options: {
  invoke: (attempt: number) => InvokeAttempt | Promise<InvokeAttempt>;
  retryWindowMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  initialDelayMs?: number;
  maxDelayMs?: number;
}): Promise<{ outcome: PollOutcome; decisions: ReconcilerDecision[] }> => {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.retryWindowMs;
  const decisions: ReconcilerDecision[] = [];
  let attempt = 0;

  while (true) {
    const invocation = await options.invoke(attempt);
    const decision = decideInvokeAttempt(invocation);
    decisions.push(decision);

    if (decision.kind !== "retry") {
      return {
        outcome: pollOutcome({ decisions, windowExpired: true }),
        decisions,
      };
    }

    const delay = retryDelayFor(attempt, options);
    attempt++;
    if (now() + delay >= deadline) {
      return {
        outcome: pollOutcome({ decisions, windowExpired: true }),
        decisions,
      };
    }
    await sleep(delay);
  }
};

const retryDelayFor = (
  attempt: number,
  options: { initialDelayMs?: number; maxDelayMs?: number },
): number =>
  retryDelayMs({
    attempt,
    initialMs: options.initialDelayMs,
    maxMs: options.maxDelayMs ?? VK_JANITOR_RETRY_MAX_MS,
  });

/** Why a run did not converge, in the words the log can print. */
export const formatFailure = (outcome: PollOutcome): string => {
  if (outcome.kind === "converged") {
    return `the reconciler converged (trigger ${outcome.summary.trigger}): config changed ${outcome.summary.config.changed}, unchanged ${outcome.summary.config.unchanged}; governance changed ${outcome.summary.governance.changed}, unchanged ${outcome.summary.governance.unchanged}`;
  }
  if (outcome.kind === "not-converged") {
    return `the reconciler ran and did not converge: ${outcome.reason}`;
  }
  return `the reconciler never ran: ${outcome.reason}`;
};

export const main = async (
  argv: string[] = process.argv.slice(2),
): Promise<number> => {
  try {
    // The literal `bifrost/vk-janitor-contract.ts` declares, which the Pulumi
    // module's own name constant is pinned equal to. The flag exists so a
    // renamed stack can be checked by hand without editing the script.
    const functionName =
      argument(argv, "--function-name") ?? VK_JANITOR_FUNCTION_NAME;
    const roleArn =
      argument(argv, "--role-arn") ??
      process.env.WORKBENCH_DEPLOY_ROLE_ARN ??
      DEFAULT_ROLE_ARN;
    const region =
      argument(argv, "--region") ?? process.env.AWS_REGION ?? DEFAULT_REGION;
    const retryWindowSeconds = positiveNumber(
      argument(argv, "--retry-window-seconds"),
      "--retry-window-seconds",
      VK_JANITOR_RETRY_WINDOW_SECONDS,
    );

    const env = assumeRoleEnvironment(roleArn, "bifrost-reconciler");

    // `aws lambda invoke` writes the run's payload to a file and the response
    // metadata to stdout, so the payload needs somewhere to land. It is a
    // summary of counts and a trigger by construction (`reconciler-summary.ts`)
    // and holds no secret, so nothing here depends on the file's permissions;
    // the temporary directory is only hygiene.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vk-reconciler-"));
    const outFile = path.join(directory, "out.json");

    try {
      const { outcome, decisions } = await pollForConvergence({
        invoke: () =>
          invokeOnce({
            functionName,
            region,
            env,
            // The deploy's trigger label. The function runs the same work either
            // way; the label is what tells a throttle-driven pattern from a
            // convergence failure in the log, and what step 6's alarm will
            // report on.
            payload: JSON.stringify({ action: "reconcile", trigger: "deploy" }),
            outFile,
          }),
        retryWindowMs: retryWindowSeconds * 1000,
        initialDelayMs: 2_000,
        maxDelayMs: VK_JANITOR_RETRY_MAX_MS,
      });

      if (outcome.kind === "converged") {
        console.log(formatFailure(outcome));
        return 0;
      }

      console.error(formatFailure(outcome));
      if (outcome.kind === "never-ran") {
        console.error(
          `  ${decisions.length} attempt(s) were throttled. That is the function's reservedConcurrentExecutions: 1 colliding with a run, not a convergence failure; the deploy's retry window is ${retryWindowSeconds}s against a ${VK_JANITOR_TIMEOUT_SECONDS}s timeout.`,
        );
      }
      if (outcome.kind === "not-converged" && outcome.summary) {
        console.error(
          `  revocation ${outcome.summary.revocation.outcome}, governance ${outcome.summary.governance.outcome} (changed ${outcome.summary.governance.changed}, unchanged ${outcome.summary.governance.unchanged}), config ${outcome.summary.config.outcome} (changed ${outcome.summary.config.changed}, unchanged ${outcome.summary.config.unchanged})`,
        );
      }
      return 1;
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(
      `the reconciler check could not complete: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }
};

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(
        `the reconciler check could not complete: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exitCode = 1;
    },
  );
}
