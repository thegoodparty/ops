# Ops

Operations tooling and AI agent infrastructure for GoodParty's Serve product.

## Repo Structure

- `scripts/` — Operational automation scripts, run via `npm run script <name>`
- `utils/` — Shared utilities (Grafana log search, People API client)
- `delegate/` — AI agent framework powered by Claude Agent SDK
- `deploy/` — Pulumi IaC for AWS infrastructure (ECS, Lambda, etc.)
- `.github/workflows/` — CI/CD and scheduled automation

## Scripts

Scripts are standalone TypeScript modules in `scripts/`, each exporting a default async function. Run with:

```bash
npm run script <script-name>
```

Environment variables for scripts live in `scripts/.env` (see `scripts/.env.example`).

## Delegate

The delegate system runs AI agents triggered by webhooks. Architecture:

```
Slack @mention → Lambda (webhook handler) → ECS Fargate task → Claude Agent SDK → callback to Slack
```

### Key directories

- `delegate/framework/` — Agent registry, execution engine, callback delivery, MCP config
- `delegate/agents/` — Agent definitions (currently: `slack-responder` using claude-opus-4-6)
- `delegate/lambdas/` — Lambda webhook handler with Slack signature verification, ECS dispatch
- `delegate/worker/` — Fargate container entrypoint, GitHub App auth, Dockerfile. The entrypoint enforces a hard wall-clock deadline (`AGENT_DEADLINE_MS`, default 45m) that aborts the agent and exits the task — ECS has no native per-task timeout, and the SDK's `maxTurns`/`maxBudgetUsd` caps only fire between turns, so a hung tool call would otherwise run forever. The entrypoint also does deterministic per-agent repo checkouts before the agent starts, so no agent clones mid-run: `slack-responder` gets a full shallow clone of `omni@develop` at `/app/omni` (its cwd); `pr-reviewer` gets the PR's repo checked out at the exact reviewed head SHA at `/app/review` (its cwd) — repo-agnostic, submodules synced, and the head SHA is resolved from the live PR on the re-review path where dispatch omits it. Workflow agents (`*-agent`) still get the sparse `packages/runbooks`-only clone.
- `delegate/tools/` — CLI tools available to agents (Databricks Genie)
- The Dockerfile vendors the Superpowers skills library (pinned tag) at `/app/plugins/superpowers`; `slack-responder` loads it as a local Claude Agent SDK plugin (`plugins: [{ type: 'local', ... }]`) so it can invoke `superpowers:systematic-debugging` and friends via the `Skill` tool (`Skill` is in the framework's default `allowedTools`).

### Adding a new agent

1. Create a new file in `delegate/agents/` using `defineAgent()` from the framework
2. Import it in `delegate/agents/index.ts`
3. Add a webhook route in `delegate/lambdas/handler.ts` if needed

### Environment

Delegate secrets are stored in AWS Secrets Manager under the key `DELEGATES`. See `delegate/.env.example` for the required keys.

## Deploy

Infrastructure is managed with Pulumi (TypeScript) and deployed via GitHub Actions.

- **Stack:** `organization/ops/ops-dev` (single environment)
- **Backend:** `s3://goodparty-iac-state`
- **Region:** us-west-2

### What gets deployed

- ECS Fargate cluster + task definition (1 vCPU, 4GB RAM) for running agents
- Lambda Function URL as the webhook endpoint (no auth, Slack signature verification in-handler)
- CloudWatch log group for agent execution logs
- IAM roles for ECS execution, task, and Lambda

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
npm run build          # Bundle Lambda handler and compile delegate TypeScript
```
