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

The delegate system runs AI agents (powered by [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk)) on-demand in response to webhooks. When someone @-mentions the bot in Slack, a Lambda receives the webhook, dispatches an ECS Fargate task, and the agent investigates/responds in the thread.

### Architecture

```
Slack @mention
  → Lambda Function URL (signature verification, routing)
    → ECS Fargate task (ephemeral, 1 vCPU / 4GB RAM)
      → Claude Agent SDK with MCP servers + CLI tools
        → Posts result back to Slack thread
```

### Key directories

| Directory             | Purpose                                                           |
| --------------------- | ----------------------------------------------------------------- |
| `delegate/framework/` | Agent registry, execution engine, callback delivery, MCP config   |
| `delegate/agents/`    | Agent definitions (currently: `slack-responder`)                  |
| `delegate/lambdas/`   | Lambda webhook handler, ECS dispatch, secrets, Slack verification |
| `delegate/worker/`    | Fargate entrypoint, GitHub App auth, Dockerfile                   |
| `delegate/tools/`     | CLI tools available to agents (Databricks Genie)                  |
| `deploy/`             | Pulumi infrastructure (ECS cluster, Lambda, IAM, CloudWatch)      |

### Deployment

Deployed automatically on push to `develop` via GitHub Actions. The workflow builds a Docker image, pushes to ECR, and runs Pulumi to update infrastructure. See [`deploy/`](./deploy) for the Pulumi code.

## Runbooks

See [`docs/runbooks.md`](docs/runbooks.md) for the runbooks.
