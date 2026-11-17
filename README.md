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

The delegate system runs `pr-reviewer`, the AI code reviewer (powered by [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk)) behind the required `pr-reviewer` check. A GitHub webhook reaches a Lambda, which dispatches an ECS Fargate task that reviews the PR and posts the review. The Delegate persona in Slack is served by [`agent-swarm/`](./agent-swarm), not by this system.

### Architecture

```
GitHub pull_request / issue_comment webhook
  → Lambda Function URL (signature verification, routing)
    → ECS Fargate task (ephemeral, 1 vCPU / 4GB RAM)
      → pr-reviewer (Claude Agent SDK, read-only tools)
        → Posts the review and the pr-reviewer status to GitHub
```

### Key directories

| Directory             | Purpose                                                      |
| --------------------- | ------------------------------------------------------------ |
| `delegate/framework/` | Agent registry and execution engine                          |
| `delegate/agents/`    | Agent definitions (`pr-reviewer` and its subagents)          |
| `delegate/review/`    | The deterministic half of `pr-reviewer`, and its evals       |
| `delegate/lambdas/`   | Lambda webhook handler, ECS dispatch, secrets, verification  |
| `delegate/worker/`    | Fargate entrypoint, GitHub App auth, Dockerfile              |
| `deploy/`             | Pulumi infrastructure (ECS cluster, Lambda, IAM, CloudWatch) |

### Deployment

Deployed automatically on push to `main` via GitHub Actions. The workflow builds a Docker image, pushes to ECR, and runs Pulumi to update infrastructure. See [`deploy/`](./deploy) for the Pulumi code.

## Runbooks

See [`docs/runbooks.md`](docs/runbooks.md) for the runbooks.
