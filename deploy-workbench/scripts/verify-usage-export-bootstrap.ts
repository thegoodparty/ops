import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { WORKBENCH_ACCOUNT_ID } from "../../utils/accounts";
import {
  USAGE_EXPORT_BOOTSTRAP_FUNCTION_NAME,
  USAGE_EXPORT_BOOTSTRAP_TIMEOUT_SECONDS,
  USAGE_EXPORT_SECRET_JSON_KEY,
  USAGE_EXPORT_SECRET_NAME,
  isBootstrapOutcome,
} from "../bifrost/usage-export-contract";
import { assumeRoleEnvironment, tryRunAws } from "./aws-role";

/**
 * Invoke the usage export's bootstrap function after the apply, and fail the run
 * when it did not provision.
 *
 * Step 3 of the landing order. The function is invoked on **every** deploy and
 * no-ops once the export's secret holds a password, so this is not a one-time
 * step with a flag to remember; the no-op is in the handler, keyed on the
 * secret, so a later deploy cannot rotate a working password out from under the
 * export.
 *
 * `RequestResponse`, like `verify-convergence.ts` and for the same reason: an
 * `Event` invoke returns `202` whether the run provisioned or threw, and a
 * workflow that invokes and moves on is green over a role that was never created.
 *
 * ## Three outcomes, and the one that is a failure
 *
 * - **`provisioned`** — exit 0.
 * - **`already-provisioned`** — exit 0. This is the normal case on every deploy
 *   after the first, and it is what makes the step safe to keep in the workflow.
 * - **anything else** — exit 1, including an unreadable reply. A Lambda can return
 *   anything on a bug, and an unrecognised value is not a pass.
 *
 * A throttle is retried rather than failed, for the reason the reconciler's script
 * records: the function is capped at `reservedConcurrentExecutions: 1`, and a
 * deploy going red over a scheduling collision would be the wrong colour. A
 * window that expires on nothing but throttles is reported as "never ran".
 *
 * ## `ResourceNotFound`, and why it is a real check rather than a tolerance
 *
 * The bootstrap function's resource is deleted in a follow-up PR once the export
 * has run, and this step stays behind for a deploy or two afterwards. So a
 * `ResourceNotFound` must not fail the run. But it also means "the function was
 * never created", which is exactly what a skipped or constrained apply of the new
 * module looks like — so treating it as success unconditionally would let a
 * deploy go green with no role and no password, and the first symptom would be an
 * alarmed export the next morning.
 *
 * So on `ResourceNotFound` this reads the export's secret and looks for a
 * non-empty password, which is the same marker the handler's no-op uses. Found:
 * a previous run provisioned it, exit 0. Missing: nothing was ever provisioned,
 * exit 1 naming the function it could not find.
 *
 * ## Why this hop, and that no IAM is needed
 *
 * Same-account invoke is authorised by the caller's own policy, so no
 * resource-based policy and no new grant. It makes the identical `pulumi-deploy`
 * hop `scripts/verify-service.ts` and `scripts/verify-convergence.ts` make, and
 * that role is `AdministratorAccess`, so `lambda:InvokeFunction` and the
 * `GetSecretValue` on the export's secret are already held. The hop is inside the
 * script rather than a `configure-aws-credentials` step for the reason `aws-role.ts`
 * records: the job's environment stays on the first-hop session.
 */

const DEFAULT_ROLE_ARN = `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/pulumi-deploy`;
const DEFAULT_REGION = "us-west-2";
const DEFAULT_RETRY_WINDOW_SECONDS = 120;

const argument = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

export const isThrottle = (stderr: string): boolean => /TooManyRequestsException|\b429\b/.test(stderr);

/** A missing function, which is a state to check rather than a failure by itself. */
export const isResourceNotFound = (text: string): boolean =>
  /ResourceNotFoundException|ResourceNotFound/.test(text);

/**
 * What the export's secret says about provisioning.
 *
 * Deliberately not "does the secret exist": an empty container is what a rotation
 * leaves behind, and it means "not provisioned". The question is whether a
 * password is in it.
 */
export const secretHasPassword = (env: NodeJS.ProcessEnv, secretName: string): boolean => {
  const result = tryRunAws(
    ["secretsmanager", "get-secret-value", "--secret-id", secretName, "--query", "SecretString", "--output", "text"],
    env,
  );
  if (!result.ok) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return false;
  }
  const value = (parsed as Record<string, unknown>)?.[USAGE_EXPORT_SECRET_JSON_KEY];
  return typeof value === "string" && value !== "";
};

export type BootstrapAttempt =
  | { kind: "provisioned" }
  | { kind: "already-provisioned" }
  | { kind: "removed-and-provisioned" }
  | { kind: "removed-and-not-provisioned" }
  | { kind: "throttled" }
  | { kind: "failed"; message: string };

/**
 * One invoke, classified. Exported so a test can drive every branch without AWS.
 *
 * `invoke` and `secretHasPassword` are injected for the same reason.
 */
export const classifyInvoke = (args: {
  stdout: string;
  stderr: string;
  status: number | null;
  payload: string | undefined;
  secretHasPassword: () => boolean;
}): BootstrapAttempt => {
  const text = `${args.stdout}\n${args.stderr}`;
  if (args.status !== 0 || /"FunctionError"\s*:|Unhandled exception/.test(args.stdout)) {
    if (isThrottle(text)) return { kind: "throttled" };
    if (isResourceNotFound(text)) {
      return args.secretHasPassword()
        ? { kind: "removed-and-provisioned" }
        : { kind: "removed-and-not-provisioned" };
    }
    return { kind: "failed", message: firstLine(text) };
  }

  let payload: unknown;
  try {
    payload = args.payload === undefined ? undefined : JSON.parse(args.payload);
  } catch {
    payload = undefined;
  }
  if (!isBootstrapOutcome(payload)) {
    // Not a pass. An unrecognised reply is a change to the contract, and reading
    // it as success is how a broken provisioning stays green.
    return { kind: "failed", message: `unrecognised reply: ${String(args.payload).slice(0, 200)}` };
  }
  return payload.outcome === "provisioned" ? { kind: "provisioned" } : { kind: "already-provisioned" };
};

const firstLine = (text: string): string =>
  text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "no message";

export const invokeArguments = (args: {
  functionName: string;
  region: string;
  outFile: string;
}): string[] => [
  "lambda",
  "invoke",
  "--function-name",
  args.functionName,
  "--invocation-type",
  // Load-bearing: `Event` returns before the work does and is green on a failed
  // provision, which is the bug this script exists to stop.
  "RequestResponse",
  // No payload: the handler takes none. `--cli-read-timeout` above the function's
  // own timeout so a slow run is reported as its result rather than cut off.
  "--cli-read-timeout",
  String(USAGE_EXPORT_BOOTSTRAP_TIMEOUT_SECONDS + 30),
  "--region",
  args.region,
  args.outFile,
];

export const main = async (argv: string[] = process.argv.slice(2)): Promise<number> => {
  const functionName = argument(argv, "--function-name") ?? USAGE_EXPORT_BOOTSTRAP_FUNCTION_NAME;
  const secretName = argument(argv, "--secret-name") ?? USAGE_EXPORT_SECRET_NAME;
  const roleArn = argument(argv, "--role-arn") ?? process.env.WORKBENCH_DEPLOY_ROLE_ARN ?? DEFAULT_ROLE_ARN;
  const region = argument(argv, "--region") ?? process.env.AWS_REGION ?? DEFAULT_REGION;
  const windowSeconds = Number(argument(argv, "--retry-window-seconds") ?? DEFAULT_RETRY_WINDOW_SECONDS);
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    console.error("--retry-window-seconds must be a positive number");
    return 1;
  }

  const env = assumeRoleEnvironment(roleArn, "bifrost-usage-export-bootstrap");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-export-bootstrap-"));
  const outFile = path.join(directory, "out.json");
  const deadline = Date.now() + windowSeconds * 1000;
  let throttles = 0;

  try {
    while (true) {
      const result = tryRunAws(
        invokeArguments({ functionName, region, outFile }),
        env,
      );
      let payload: string | undefined;
      try {
        payload = fs.readFileSync(outFile, "utf8");
      } catch {
        payload = undefined;
      }
      const attempt = classifyInvoke({
        stdout: result.ok ? result.stdout : "",
        stderr: result.ok ? "" : result.stderr,
        status: result.ok ? 0 : (result.status ?? null),
        payload,
        secretHasPassword: () => secretHasPassword(env, secretName),
      });

      switch (attempt.kind) {
        case "provisioned":
          console.log("bifrost usage export bootstrap: provisioned the read-only role and wrote its password");
          return 0;
        case "already-provisioned":
          console.log("bifrost usage export bootstrap: already provisioned, nothing to do");
          return 0;
        case "removed-and-provisioned":
          console.log(
            `bifrost usage export bootstrap: ${functionName} is gone and the export secret holds a password, so provisioning happened earlier. The removal PR can also delete this step.`,
          );
          return 0;
        case "removed-and-not-provisioned":
          console.error(
            `bifrost usage export bootstrap: ${functionName} is gone and the export secret has no password. Nothing was ever provisioned; either the apply did not create the function or it was removed too early.`,
          );
          return 1;
        case "failed":
          console.error(`bifrost usage export bootstrap: the run failed: ${attempt.message}`);
          return 1;
        case "throttled":
          throttles++;
          break;
      }

      if (Date.now() + 2_000 >= deadline) {
        console.error(
          `bifrost usage export bootstrap: never ran. ${throttles} attempt(s) were throttled; that is reservedConcurrentExecutions: 1 colliding with a run, not a provisioning failure. The window was ${windowSeconds}s against a ${USAGE_EXPORT_BOOTSTRAP_TIMEOUT_SECONDS}s timeout.`,
        );
        return 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(
        `the usage export bootstrap check could not complete: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exitCode = 1;
    },
  );
}
