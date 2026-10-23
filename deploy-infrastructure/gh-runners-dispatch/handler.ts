import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

// Starts one gp-ecs runner task per queued workflow_job webhook from the
// gh-runners GitHub App. Design and security model: gh-runners/README.md.

export const RUNNER_LABELS = ["self-hosted", "linux", "x64", "gp-ecs"];

type FunctionUrlEvent = {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
};

type WorkflowJobPayload = {
  action?: string;
  workflow_job?: { id?: number; run_id?: number; labels?: string[] };
  repository?: { full_name?: string };
};

type AppSecret = {
  app_id: string;
  installation_id: string;
  private_key: string;
  webhook_secret: string;
};

export const verifySignature = (
  body: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean => {
  if (!signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

// Every job label must be one the runner registers, or the runner would sit
// registered with a job it can never take.
export const shouldDispatch = (
  githubEvent: string | undefined,
  payload: WorkflowJobPayload,
  allowedRepos: string[],
): { dispatch: boolean; reason: string } => {
  if (githubEvent !== "workflow_job") {
    return { dispatch: false, reason: `event ${githubEvent}` };
  }
  if (payload.action !== "queued") {
    return { dispatch: false, reason: `action ${payload.action}` };
  }
  const repo = payload.repository?.full_name?.toLowerCase();
  if (!repo || !allowedRepos.map((r) => r.toLowerCase()).includes(repo)) {
    return { dispatch: false, reason: `repo ${repo} not allowed` };
  }
  const labels = (payload.workflow_job?.labels ?? []).map((l) => l.toLowerCase());
  if (!labels.includes("gp-ecs")) {
    return { dispatch: false, reason: "no gp-ecs label" };
  }
  const unknown = labels.filter((l) => !RUNNER_LABELS.includes(l));
  if (unknown.length > 0) {
    return { dispatch: false, reason: `labels not served: ${unknown.join(",")}` };
  }
  return { dispatch: true, reason: "queued gp-ecs job" };
};

const requireEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} env var`);
  return value;
};

const secretsClient = new SecretsManagerClient({});
const ecsClient = new ECSClient({});

let cachedSecret: AppSecret | undefined;
let cachedAuth: ReturnType<typeof createAppAuth> | undefined;
let cachedRunnerGroupId: number | undefined;

const getSecret = async (): Promise<AppSecret> => {
  if (cachedSecret) return cachedSecret;
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: requireEnv("SECRET_ARN") }),
  );
  const parsed = JSON.parse(result.SecretString ?? "{}") as Partial<AppSecret>;
  if (
    !parsed.app_id ||
    !parsed.installation_id ||
    !parsed.private_key ||
    !parsed.webhook_secret
  ) {
    throw new Error(
      "GH_RUNNERS_GITHUB_APP must hold app_id, installation_id, private_key and webhook_secret",
    );
  }
  cachedSecret = parsed as AppSecret;
  return cachedSecret;
};

const github = async (token: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gh-runners-dispatch",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
};

const findRunnerGroupId = async (token: string, org: string, groupName: string) => {
  for (let page = 1; ; page++) {
    const result = (await github(
      token,
      "GET",
      `/orgs/${org}/actions/runner-groups?per_page=100&page=${page}`,
    )) as { runner_groups: { id: number; name: string }[] };
    const match = result.runner_groups.find((g) => g.name === groupName);
    if (match) return match.id;
    if (result.runner_groups.length < 100) {
      throw new Error(`Runner group ${groupName} not found in org ${org}`);
    }
  }
};

const respond = (statusCode: number, body: string) => ({ statusCode, body });

export const handler = async (event: FunctionUrlEvent) => {
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const delivery = headers["x-github-delivery"];
  const log = (fields: Record<string, unknown>) =>
    console.log(JSON.stringify({ delivery, ...fields }));

  try {
    const secret = await getSecret();
    const raw = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8");
    if (!verifySignature(raw, headers["x-hub-signature-256"], secret.webhook_secret)) {
      log({ decision: "rejected", reason: "bad signature" });
      return respond(401, "bad signature");
    }

    const payload = JSON.parse(raw.toString("utf8")) as WorkflowJobPayload;
    const allowedRepos = requireEnv("ALLOWED_REPOS").split(",").map((r) => r.trim());
    const decision = shouldDispatch(headers["x-github-event"], payload, allowedRepos);
    const repo = payload.repository?.full_name;
    const jobId = payload.workflow_job?.id;
    const runId = payload.workflow_job?.run_id;
    if (!decision.dispatch) {
      log({ decision: "ignored", reason: decision.reason, repo, jobId });
      return respond(200, "ignored");
    }

    const org = requireEnv("ORG");
    cachedAuth ??= createAppAuth({
      appId: secret.app_id,
      privateKey: secret.private_key,
      installationId: secret.installation_id,
    });
    const { token } = await cachedAuth({ type: "installation" });
    cachedRunnerGroupId ??= await findRunnerGroupId(token, org, requireEnv("RUNNER_GROUP"));

    const runnerName = `gp-ecs-${jobId}-${randomBytes(3).toString("hex")}`;
    const jit = (await github(token, "POST", `/orgs/${org}/actions/runners/generate-jitconfig`, {
      name: runnerName,
      runner_group_id: cachedRunnerGroupId,
      labels: RUNNER_LABELS,
      work_folder: "_work",
    }).catch((error) => {
      // A recreated runner group has a new id; look it up again next time.
      cachedRunnerGroupId = undefined;
      throw error;
    })) as { encoded_jit_config: string };

    const result = await ecsClient.send(
      new RunTaskCommand({
        cluster: requireEnv("ECS_CLUSTER"),
        taskDefinition: requireEnv("RUNNER_TASK_DEFINITION"),
        capacityProviderStrategy: [
          { capacityProvider: requireEnv("RUNNER_CAPACITY_PROVIDER"), weight: 1 },
        ],
        count: 1,
        startedBy: "gh-runners",
        tags: [
          { key: "runner-name", value: runnerName },
          { key: "repo", value: String(repo) },
          { key: "run-id", value: String(runId) },
          { key: "job-id", value: String(jobId) },
        ],
        overrides: {
          containerOverrides: [
            {
              name: "runner",
              environment: [
                { name: "ACTIONS_RUNNER_INPUT_JITCONFIG", value: jit.encoded_jit_config },
              ],
            },
          ],
        },
      }),
    );
    if (result.failures && result.failures.length > 0) {
      throw new Error(`RunTask failures: ${JSON.stringify(result.failures)}`);
    }
    const taskArn = result.tasks?.[0]?.taskArn;
    log({ decision: "dispatched", repo, jobId, runId, runnerName, taskArn });
    return respond(200, taskArn ?? "dispatched");
  } catch (error) {
    log({ decision: "error", error: error instanceof Error ? error.message : String(error) });
    return respond(500, "dispatch failed");
  }
};
