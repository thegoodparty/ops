This repo houses operations tooling for the GoodParty products.

## Scripts

### Setup

To set up the project for running scripts, just do the following:

```bash
npm install
cp .env.example .env
# Now, fill in real values in .env
```

### Running Scripts

See [`scripts`](./scripts) for all of the supported scripts.

To run a script, use the `script` command:

```bash
npm run script <script-name>
```

For example, to run the `poll-problem` script, you can run:

```bash
npm run script poll-problem <arg>
```

## Delegate

The delegate is a Claude-powered AI assistant (powered by [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk)) that runs in ECS Fargate. It handles Slack responses and agent job execution.

When someone @-mentions the bot in Slack, a Lambda webhook dispatches an ECS Fargate task that investigates and responds in the thread. Scheduled agent jobs also run through the delegate — see Jobs below.

```
Slack @mention → Lambda (webhook) → ECS Fargate → Claude Agent SDK → Slack thread
```

### Key directories

| Directory                   | Purpose                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `delegate/framework/`       | `runAgent()` execution engine, callback delivery, MCP config |
| `delegate/lambdas/`         | Lambda webhook handler, ECS dispatch, Slack verification     |
| `delegate/worker/`          | Fargate entrypoint, agent job runner, GitHub App auth        |
| `delegate/tools/`           | CLI tools available to the agent (Databricks Genie)          |
| `delegate/system-prompt.ts` | Shared base system prompt for all delegate runs              |
| `deploy/`                   | Pulumi infrastructure (ECS cluster, Lambda, IAM, CloudWatch) |

### Deployment

Deployed automatically on push to `develop` via GitHub Actions. The workflow builds a Docker image, pushes to ECR, and runs Pulumi to update infrastructure. See [`deploy/`](./deploy) for the Pulumi code.

## Jobs

Scheduled jobs run on CloudWatch Event Rules. There are two types:

### Workflow jobs

Deterministic jobs that run as Lambda functions. Each `.ts` file in `jobs/` that exports `defineJob(...)` becomes its own Lambda.

```typescript
import { defineJob } from "./framework";

export default defineJob(
  { schedule: "cron(0 14 ? * MON-FRI *)" },
  async (ctx) => {
    // ctx.github — authenticated Octokit instance
    // ctx.slack  — authenticated @slack/web-api WebClient
    // ctx.clickup — authenticated Axios instance for ClickUp API v2
  },
);
```

### Agent jobs

AI-powered jobs that run the delegate agent, validate structured output against a Zod schema, then execute a deterministic callback. Each `.ts` file exporting `defineAgentJob(...)` is deployed as a thin dispatcher Lambda that triggers an ECS Fargate task.

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
    // output is typed as z.infer<typeof outputSchema>
    await ctx.slack.chat.postMessage({
      channel: "#serve-dev",
      text: `Created ${output.prs.length} PRs`,
    });
  },
);
```

Agent jobs receive the shared base system prompt, retry up to 3 times on schema validation failure, and post errors to `#serve-dev` if all retries fail.

### Adding a job

1. Create a new `.ts` file in `jobs/`
2. Export a default `defineJob(...)` or `defineAgentJob(...)` call
3. Deploy — the build pipeline picks it up automatically

The `schedule` field is a [CloudWatch schedule expression](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-schedule-expressions.html):

- **Cron**: `cron(0 14 ? * MON-FRI *)` — 6-field (min hr dom month dow year), exactly one of dom/dow must be `?`
- **Rate**: `rate(30 minutes)` — fixed interval, singular when value is 1 (`rate(1 hour)`)

## Runbooks

See [`docs/runbooks.md`](docs/runbooks.md) for the runbooks.
