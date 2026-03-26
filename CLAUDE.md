# Ops

Operations tooling and AI agent infrastructure for GoodParty's Serve product.

## Repo Structure

- `scripts/` — Operational automation scripts, run via `npm run script <name>`
- `utils/` — Shared utilities (Grafana log search, People API client)
- `delegate/` — AI delegate powered by Claude Agent SDK (Slack responder + agent job execution)
- `jobs/` — Scheduled jobs (workflow and agent), auto-discovered and deployed via cron
- `deploy/` — Pulumi IaC for AWS infrastructure (ECS, Lambda, etc.)
- `.github/workflows/` — CI/CD and scheduled automation

## Scripts

Scripts are standalone TypeScript modules in `scripts/`, each exporting a default async function. Run with:

```bash
npm run script <script-name>
```

Environment variables for scripts live in `scripts/.env` (see `scripts/.env.example`).

## Delegate

The delegate is a Claude-powered AI assistant that runs in ECS Fargate. It handles two things:

1. **Slack responses** — When someone @-mentions the bot, a Lambda webhook dispatches an ECS task that investigates and responds in the thread.
2. **Agent job execution** — Scheduled agent jobs (see Jobs below) dispatch ECS tasks that run the agent, validate structured output, and execute a typed callback.

All delegate runs share a base system prompt (`delegate/system-prompt.ts`) with context about available tools, services, and observability. The Slack responder and agent jobs each layer their own instructions on top.

```
Slack @mention → Lambda (webhook) → ECS Fargate → Claude Agent SDK → Slack thread
Scheduled agent job → Lambda (dispatcher) → ECS Fargate → Claude Agent SDK → validate output → callback
```

### Key directories

- `delegate/framework/` — `runAgent()` execution engine, callback delivery, MCP config, types
- `delegate/lambdas/` — Lambda webhook handler with Slack signature verification, ECS dispatch
- `delegate/worker/` — Fargate container entrypoint, agent job runner, GitHub App auth, Dockerfile
- `delegate/tools/` — CLI tools available to the agent (Databricks Genie)
- `delegate/system-prompt.ts` — Shared base system prompt for all delegate runs

### Environment

Delegate secrets are stored in AWS Secrets Manager under the key `DELEGATES`. See `delegate/.env.example` for the required keys.

## Jobs

Scheduled jobs run on CloudWatch Event Rules. There are two types:

### Workflow jobs

Deterministic jobs that run as individual Lambda functions. Each `.ts` file in `jobs/` that exports a `defineJob(...)` call becomes its own Lambda.

```typescript
import { defineJob } from "./framework";

export default defineJob(
  { schedule: "cron(0 14 ? * MON-FRI *)" },
  async (ctx) => {
    ctx.github; // authenticated Octokit instance
    ctx.slack; // authenticated @slack/web-api WebClient
    ctx.clickup; // authenticated Axios instance for ClickUp API v2
  },
);
```

### Agent jobs

AI-powered jobs that run the delegate agent, validate structured output against a Zod schema, then execute a deterministic callback with the typed result. Each `.ts` file in `jobs/` that exports a `defineAgentJob(...)` call is deployed as a thin dispatcher Lambda that triggers an ECS Fargate task.

```typescript
import { z } from "zod";
import { defineAgentJob } from "./framework";

export default defineAgentJob(
  {
    schedule: "cron(0 10 ? * MON *)",
    agent: {
      prompt: "Review documentation in each repo for drift...",
      model: "claude-sonnet-4-20250514",
    },
    outputSchema: z.object({
      prs: z.array(
        z.object({
          repo: z.string(),
          url: z.string(),
          summary: z.string(),
        }),
      ),
    }),
  },
  async (ctx, output) => {
    // output is fully typed as z.infer<typeof outputSchema>
    await ctx.slack.chat.postMessage({
      channel: "#serve-dev",
      text: `Created ${output.prs.length} PRs`,
    });
  },
);
```

Agent jobs:

- Receive the shared base system prompt + their job-specific prompt
- Get the output schema injected into the prompt as JSON Schema
- Retry up to 3 times if the agent's output doesn't match the schema
- Post an error to `#serve-dev` if all retries fail

### How it works

At build time, `generate-lambdas.ts` discovers all job files and checks their `type`:

- **Workflow jobs** (`type: "job"`) — bundled with esbuild as self-contained Lambdas
- **Agent jobs** (`type: "agent"`) — a thin dispatcher Lambda is generated that triggers an ECS Fargate task via `AGENT_JOB` env var; the job definition itself is compiled by `tsc` and included in the Docker image

Both types get a `dist/jobs/manifest.json` entry. Pulumi reads the manifest and creates the appropriate Lambda + CloudWatch Event Rule per job.

### Adding a new job

1. Create a new `.ts` file in `jobs/`
2. Export a default `defineJob(...)` or `defineAgentJob(...)` call
3. Deploy — the build pipeline picks it up automatically

### Schedule format

The `schedule` field is a [CloudWatch schedule expression](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-schedule-expressions.html):

- **Cron**: `cron(0 14 ? * MON-FRI *)` — 6-field cron (min hr dom month dow year). Exactly one of day-of-month or day-of-week must be `?`.
- **Rate**: `rate(30 minutes)` — fixed interval. Singular when value is 1 (`rate(1 hour)`).

### Job context

Both job types receive a `ctx` object with:

- `ctx.github` — An authenticated `Octokit` instance from `@octokit/rest` (GitHub App auth)
- `ctx.slack` — An authenticated `@slack/web-api` `WebClient`
- `ctx.clickup` — An authenticated Axios instance for the [ClickUp API v2](https://developer.clickup.com/reference)

## Deploy

Infrastructure is managed with Pulumi (TypeScript) and deployed via GitHub Actions.

- **Stack:** `organization/ops/ops-dev` (single environment)
- **Backend:** `s3://goodparty-iac-state`
- **Region:** us-west-2

### What gets deployed

- ECS Fargate cluster + task definition (1 vCPU, 4GB RAM) for the delegate
- Lambda Function URL as the Slack webhook endpoint
- Per-job Lambda functions + CloudWatch Event Rules (workflow jobs run in Lambda, agent jobs dispatch to ECS)
- CloudWatch log group for delegate execution logs
- IAM roles for ECS execution, task, Lambda, and jobs

### CI/CD

On push to `develop`, the GitHub Actions workflow:

1. Type-checks with `tsc --noEmit`
2. Bundles the Lambda handler with esbuild
3. Compiles the worker TypeScript
4. Builds and pushes a Docker image to ECR
5. Runs `pulumi up` via `deploy/deploy.sh`

PRs run type-checking and builds but skip the deploy step.

## Build Commands

```bash
npm run build          # Compile TypeScript, bundle Lambda handlers, and generate job Lambdas
```
