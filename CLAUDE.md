# Ops

Operations tooling and AI agent infrastructure for GoodParty's Serve product.

## Repo Structure

- `scripts/` — Operational automation scripts, run via `npm run script <name>`
- `utils/` — Shared utilities (Grafana log search, People API client)
- `delegate/` — AI agent framework powered by Claude Agent SDK
- `deploy/` — Pulumi IaC for AWS infrastructure (ECS, Lambda, etc.)
- `deploy-org/` — Pulumi IaC for organization-level resources (OUs, member accounts)
- `deploy-workbench/` — Pulumi IaC for the contents of the `goodparty-workbench` account
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
- `delegate/worker/` — Fargate container entrypoint, GitHub App auth, Dockerfile. The entrypoint enforces a hard wall-clock deadline (`AGENT_DEADLINE_MS`, default 45m) that aborts the agent and exits the task — ECS has no native per-task timeout, and the SDK's `maxTurns`/`maxBudgetUsd` caps only fire between turns, so a hung tool call would otherwise run forever. The entrypoint also does deterministic per-agent repo checkouts before the agent starts, so no agent clones mid-run: `slack-responder` gets a full shallow clone of `omni@main` at `/app/omni` (its cwd); `pr-reviewer` gets the PR's repo checked out at the exact reviewed head SHA at `/app/review` (its cwd) — repo-agnostic, submodules synced, and the head SHA is resolved from the live PR on the re-review path where dispatch omits it. Workflow agents (`*-agent`) still get the sparse `packages/runbooks`-only clone. For `pr-reviewer` it additionally captures `gh pr diff` once to `$PR_DIFF_FILE` (both models' subagents read that file instead of re-fetching, and the tokenless second-opinion process cannot fetch it at all) and starts that process — see `delegate/review/` below.
- `delegate/review/` — the `pr-reviewer`'s second-opinion pass. The reviewer is a two-model pipeline: the Claude side (orchestrator → `scout` → N parallel `deep-reviewer`s) runs alongside a second, independent pass that drives the *same* scout/deep-reviewer prompts through GPT-5.6 Sol on Bedrock (`us.openai.gpt-5.6-sol`). The entrypoint spawns it as a child process that **has no shell**: because it drives a model over untrusted PR content, its only tools are `read_file`, `list_files`, `grep` and `read_diff`, all read-only and all confined by path check to the PR checkout. It also holds **no GitHub token**, so it reads `$PR_DIFF_FILE` rather than the API and posts nothing itself. Its env is a positive allowlist (AWS credentials and the review paths) — defense in depth rather than the boundary, since the child shares the worker's UID and could read the parent's environ from a shell; removing execution is what makes the confinement hold. Auth is SigV4 as the ECS task role (no static API key); the task role is scoped to that one model and holds no `aws-marketplace:*`, so the model is subscribed out of band via `npm run script enable-bedrock-models` with `BEDROCK_TARGET=delegate`. The orchestrator consolidates both sets at the end: cross-model agreement is a confidence signal, and a finding only one model raises must survive an explicit adjudication pass before it's posted. `SECOND_OPINION_ENABLED=false` falls back to the Claude-only review, and so does a failed or timed-out second pass.
- `delegate/tools/` — CLI tools available to agents (Databricks Genie)
- The Dockerfile vendors the Superpowers skills library (pinned tag) at `/app/plugins/superpowers`; `slack-responder` loads it as a local Claude Agent SDK plugin (`plugins: [{ type: 'local', ... }]`) so it can invoke `superpowers:systematic-debugging` and friends via the `Skill` tool (`Skill` is in the framework's default `allowedTools`).
- Agents run in the SDK's isolation mode by default (no `settingSources`), so CLAUDE.md is NOT auto-loaded. `slack-responder` opts in with `settingSources: ['project']` so omni's CLAUDE.md loads into its context (its cwd is the omni checkout). `pr-reviewer` deliberately stays isolated: it reads a repo's CLAUDE.md via the Read tool as reference to review *against*, rather than injecting it as system instructions — otherwise a PR could edit CLAUDE.md to steer the verdict (prompt injection).

### Adding a new agent

1. Create a new file in `delegate/agents/` using `defineAgent()` from the framework
2. Import it in `delegate/agents/index.ts`
3. Add a webhook route in `delegate/lambdas/handler.ts` if needed

### Environment

Delegate secrets are stored in AWS Secrets Manager under the key `DELEGATES`. See `delegate/.env.example` for the required keys.

## Deploy

Infrastructure is managed with Pulumi (TypeScript) and deployed via GitHub Actions.

- **Stack:** `organization/ops/ops-dev` (single environment; the name is a
  holdover — resources are tagged `Environment: infra`, not `dev`, because
  `EngineerAccess` grants blanket mutate on `dev`-tagged resources. Renaming
  the stack needs a state migration and is out of scope for now.)
- **Backend:** `s3://goodparty-iac-state`
- **Region:** us-west-2
- **Second account, in progress:** a `goodparty-workbench` child account for
  developer inner-loop tooling (coding agents against Bedrock). Adds two Pulumi
  projects to this repo, each with its own scoped CI role: `deploy-org/`
  (stack `organization/org/main`, role `github-actions-org-deploy`, deployed by
  `.github/workflows/deploy-org.yml`) for organization-level resources, and
  `deploy-workbench/` (stack `organization/workbench/main`, account
  024901689212, role `github-actions-workbench-deploy`, deployed by
  `.github/workflows/deploy-workbench.yml`) for the new account's contents.
  `deploy-workbench/` is the one project whose provider points at a different
  account than its credentials, so every resource there must name the
  provider explicitly; the default provider is disabled to enforce it.
  Design, rationale, staged plan and progress checklist:
  [`docs/workbench-account.md`](./docs/workbench-account.md). Read that before
  touching `components/identity-center.ts`, the deploy role, or anything
  account-related.

### What gets deployed

- ECS Fargate cluster + task definition (1 vCPU, 4GB RAM) for running agents
- Lambda Function URL as the webhook endpoint (no auth, Slack signature verification in-handler)
- CloudWatch log group for agent execution logs
- IAM roles for ECS execution, task, and Lambda — including the task role's single-model Bedrock grant for the `pr-reviewer`'s second-opinion pass (`utils/bedrock-models.ts`), deliberately without `aws-marketplace:*`
- IAM Identity Center permission sets and account assignments

### CI/CD

On push to `main`, the GitHub Actions workflow:

1. Type-checks with `tsc --noEmit`
2. Bundles the Lambda handler with esbuild
3. Compiles the worker TypeScript
4. Builds and pushes a Docker image to ECR
5. Runs `pulumi up` via `deploy/deploy.sh`

PRs run type-checking and builds but skip the deploy step.

Pulumi previews on PRs, under a scoped read-only role, are in progress:
plan, reasoning and progress checklist in
[`docs/pr-previews.md`](./docs/pr-previews.md). Read it before touching
`deploy/components/ci-roles*`, the `deploy.sh` scripts, or PR-triggered
workflows.

## Build Commands

```bash
npm run build          # Bundle Lambda handler and compile delegate TypeScript
```
