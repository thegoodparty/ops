import { WORKBENCH_ACCOUNT_ID } from "../../utils/accounts";
import { assumeRoleEnvironment, runAws } from "./aws-role";

/**
 * Fail the run when the service does not come back up after the apply.
 *
 * The 2026-10-26 outage did not end when the task definition was found to be
 * bad: the deploy run reported success, and a later merge's apply was a
 * "62 unchanged" no-op that also reported success. Nothing in the pipeline
 * ever said the service it had just deployed was empty. It sat at running 0 /
 * desired 1 for about three hours until a human hit a 503.
 *
 * This waits for an honest steady state: one deployment, its rollout
 * `COMPLETED`, and `runningCount === desiredCount` with nothing pending. A
 * deployment whose `rolloutState` is `FAILED` stops the wait immediately. On a
 * timeout or a failed rollout it prints the service's recent `events[]`, so
 * the log says why instead of only that the check failed.
 *
 * The timeout is a CLI argument and defaults to 600 seconds. The observed
 * replacement took about two minutes; five times that is long enough not to
 * flake and still bounded, and the workflow passes 600 explicitly. The job's
 * timeout is raised alongside it so the failure message are printed rather
 * than the job being killed mid-wait.
 */

export type ServiceDeployment = {
  id?: string;
  status?: string;
  rolloutState?: string;
  taskDefinition?: string;
  desiredCount?: number;
  runningCount?: number;
  pendingCount?: number;
  failedTasks?: number;
};

export type ServiceEvent = {
  createdAt?: string;
  message?: string;
};

export type ServiceDescription = {
  status?: string;
  desiredCount?: number;
  runningCount?: number;
  pendingCount?: number;
  deployments?: ServiceDeployment[];
  events?: ServiceEvent[];
};

export type ServiceEvaluation = {
  state: "ready" | "waiting" | "failed";
  reason: string;
};

/**
 * Decide one `describe-services` response. Pure, so the interesting cases are
 * tested without AWS, a clock or a running service.
 */
export const evaluateService = (
  service: ServiceDescription,
): ServiceEvaluation => {
  const desired = service.desiredCount ?? 0;
  const running = service.runningCount ?? 0;
  const pending = service.pendingCount ?? 0;
  const deployments = service.deployments ?? [];

  if (service.status && service.status !== "ACTIVE") {
    return {
      state: "failed",
      reason: `service status is ${service.status}, not ACTIVE`,
    };
  }

  if (deployments.length === 0) {
    return {
      state: "failed",
      reason: "the service has no deployments, so it cannot be steady",
    };
  }

  const failed = deployments.find(
    (deployment) => deployment.rolloutState === "FAILED",
  );
  if (failed) {
    return {
      state: "failed",
      reason: `deployment ${failed.id ?? "(unknown id)"} has rolloutState FAILED`,
    };
  }

  const primary =
    deployments.find((deployment) => deployment.status === "PRIMARY") ??
    deployments[0];
  const rolloutComplete =
    primary.rolloutState === undefined || primary.rolloutState === "COMPLETED";

  if (
    deployments.length === 1 &&
    rolloutComplete &&
    running === desired &&
    pending === 0
  ) {
    return {
      state: "ready",
      reason: `running ${running}/${desired}, rollout ${
        primary.rolloutState ?? "COMPLETED"
      }`,
    };
  }

  return {
    state: "waiting",
    reason: `running ${running}/${desired}, pending ${pending}, deployments ${
      deployments.length
    }, rollout ${primary.rolloutState ?? "unknown"}`,
  };
};

export type WaitResult =
  | {
      ok: true;
      service: ServiceDescription;
      evaluation: ServiceEvaluation;
    }
  | {
      ok: false;
      service?: ServiceDescription;
      evaluation?: ServiceEvaluation;
      reason: string;
      timedOut: boolean;
    };

export const waitForSteadyState = async (options: {
  describe: () =>
    | ServiceDescription
    | Promise<ServiceDescription>;
  timeoutMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<WaitResult> => {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;

  while (true) {
    const service = await options.describe();
    const evaluation = evaluateService(service);

    if (evaluation.state === "ready") {
      return { ok: true, service, evaluation };
    }

    if (evaluation.state === "failed") {
      return {
        ok: false,
        service,
        evaluation,
        reason: evaluation.reason,
        timedOut: false,
      };
    }

    if (now() >= deadline) {
      return {
        ok: false,
        service,
        evaluation,
        reason: `timed out after ${Math.round(
          options.timeoutMs / 1000,
        )}s waiting for a steady state: ${evaluation.reason}`,
        timedOut: true,
      };
    }

    await sleep(options.intervalMs);
  }
};

export const formatServiceEvents = (
  service: ServiceDescription | undefined,
): string => {
  const events = service?.events ?? [];
  if (events.length === 0) {
    return "  (no service events were returned)";
  }

  return events
    .slice(0, 20)
    .map(
      (event) =>
        `  ${event.createdAt ?? "(no timestamp)"} ${
          event.message ?? "(no message)"
        }`,
    )
    .join("\n");
};

const DEFAULT_ROLE_ARN = `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/pulumi-deploy`;
const DEFAULT_REGION = "us-west-2";
const DEFAULT_CLUSTER = "bifrost";
const DEFAULT_SERVICE = "bifrost";
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_INTERVAL_SECONDS = 10;

const argument = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const positiveNumber = (value: string | undefined, name: string, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got ${value}`);
  }
  return parsed;
};

const describeService = (
  cluster: string,
  serviceName: string,
  region: string,
  env: NodeJS.ProcessEnv,
): ServiceDescription => {
  const raw = runAws(
    [
      "ecs",
      "describe-services",
      "--cluster",
      cluster,
      "--services",
      serviceName,
      "--region",
      region,
      "--output",
      "json",
    ],
    env,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `aws ecs describe-services returned output this script could not parse for ${cluster}/${serviceName}`,
    );
  }

  const services =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { services?: unknown }).services
      : undefined;

  if (!Array.isArray(services) || services.length === 0) {
    throw new Error(
      `aws ecs describe-services returned no service ${serviceName} in cluster ${cluster}; the apply did not create it or this check cannot see it`,
    );
  }

  return services[0] as ServiceDescription;
};

export const main = async (
  argv: string[] = process.argv.slice(2),
): Promise<number> => {
  try {
    const cluster =
      argument(argv, "--cluster") ??
      process.env.BIFROST_CLUSTER_NAME ??
      DEFAULT_CLUSTER;
    const serviceName =
      argument(argv, "--service") ??
      process.env.BIFROST_SERVICE_NAME ??
      DEFAULT_SERVICE;
    const timeoutSeconds = positiveNumber(
      argument(argv, "--timeout-seconds"),
      "--timeout-seconds",
      DEFAULT_TIMEOUT_SECONDS,
    );
    const intervalSeconds = positiveNumber(
      argument(argv, "--interval-seconds"),
      "--interval-seconds",
      DEFAULT_INTERVAL_SECONDS,
    );
    const roleArn =
      argument(argv, "--role-arn") ??
      process.env.WORKBENCH_DEPLOY_ROLE_ARN ??
      DEFAULT_ROLE_ARN;
    const region =
      argument(argv, "--region") ?? process.env.AWS_REGION ?? DEFAULT_REGION;

    const env = assumeRoleEnvironment(roleArn, "bifrost-service-check");

    const result = await waitForSteadyState({
      describe: () => describeService(cluster, serviceName, region, env),
      timeoutMs: timeoutSeconds * 1000,
      intervalMs: intervalSeconds * 1000,
    });

    if (!result.ok) {
      console.error(
        `Service ${cluster}/${serviceName} did not reach a steady state: ${result.reason}`,
      );
      console.error("Recent service events:");
      console.error(formatServiceEvents(result.service));
      return 1;
    }

    const running = result.service.runningCount ?? 0;
    const desired = result.service.desiredCount ?? 0;
    console.log(
      `Service ${cluster}/${serviceName} is stable: running ${running}/${desired}, rollout COMPLETED.`,
    );
    return 0;
  } catch (error) {
    console.error(
      `Service health check could not complete: ${
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
        `Service health check could not complete: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exitCode = 1;
    },
  );
}
