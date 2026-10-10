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

The delegate system runs the `pr-reviewer` agent (powered by [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk)) on GitHub webhooks. A Lambda receives the webhook, dispatches an ECS Fargate task, and the task reviews the PR. The Delegate Slack bot is the self-hosted agent-swarm in [`agent-swarm/`](./agent-swarm).

### Architecture

```
GitHub webhook
  → Lambda Function URL (signature verification, routing)
    → ECS Fargate task (ephemeral, 1 vCPU / 4GB RAM)
      → Claude Agent SDK
        → Posts the review to the PR
```

### Key directories

| Directory             | Purpose                                                           |
| --------------------- | ----------------------------------------------------------------- |
| `delegate/framework/` | Agent registry and execution engine                                |
| `delegate/agents/`    | Agent definitions (currently: `pr-reviewer`)                       |
| `delegate/lambdas/`   | Lambda webhook handler, ECS dispatch, secrets, GitHub verification |
| `delegate/review/`    | The deterministic half of `pr-reviewer`, plus its evals            |
| `delegate/worker/`    | Fargate entrypoint, GitHub App auth, Dockerfile                    |
| `deploy/`             | Pulumi infrastructure (ECS cluster, Lambda, IAM, CloudWatch)       |

### Deployment

Deployed automatically on push to `main` via GitHub Actions. The workflow builds a Docker image, pushes to ECR, and runs Pulumi to update infrastructure. See [`deploy/`](./deploy) for the Pulumi code.

## Runbooks

See [`docs/runbooks.md`](docs/runbooks.md) for the runbooks.
