# Ops

Operations tooling and AI agent infrastructure for GoodParty's Serve product.

## How to use this file

This is the map, not the manual. It carries repo-wide facts and points at
the detailed docs. **Read the nearest `CLAUDE.md` to what you are changing**
rather than loading everything: `delegate/` and `deploy/` each have their
own.

## Repo Structure

- `delegate/` — AI agent framework powered by Claude Agent SDK
- `scripts/` — Operational automation scripts, run via `npm run script <name>`
- `utils/` — Shared utilities (Grafana log search, People API client)
- `deploy/` — Pulumi IaC for AWS infrastructure (ECS, Lambda, etc.)
- `deploy-org/` — Pulumi IaC for organization-level resources (OUs, member accounts)
- `deploy-workbench/` — Pulumi IaC for the contents of the `goodparty-workbench` account
- `deploy-infrastructure/` — Pulumi IaC for the contents of the `goodparty-infrastructure` account
- `.github/workflows/` — CI/CD and scheduled automation

## Repo-wide facts that will bite

**There is no prettier config.** No `.prettierrc`, no `prettier` key, and
`main` is not prettier-clean. Do not run `prettier --write` here: it applies
defaults this repo does not use and reformats files nobody touched.

**Tests are `node --test` via `tsx`**, files named `*.test.ts`. Run the
whole suite with `npm test`.

**Commit with `--no-verify`.** Explain *why* in PR bodies, not what. No
"test plan" section, no Co-Authored-By.

## Review and approval

Who has to approve a PR here depends on which paths it touches. The default
branch requires one approving review plus code-owner review.
`.github/CODEOWNERS` **owns every path by default** and names a short opt-out
list, so a human on `@thegoodparty/gp-contrib` must approve anything not
explicitly opted out. A path with no owner satisfies the code-owner half
vacuously, so on an opted-out path a `delegate-reviewer[bot]` approval is
enough to merge, with no human behind it.

**Everything merges on a bot approval except** the paths `.github/CODEOWNERS`
opts out:

- `docs/`, `README.md` — documentation.
- `.gitignore` — inert.
- `CLAUDE.md`, at the root and in any directory — removed from the review list
  by #173, and preserved as an opt-out here.

**A human on `@thegoodparty/gp-contrib` must approve** everything else. The
owned entries worth naming, because the file being edited does not obviously
reach a credential:

- `.github/`, `delegate/`, `deploy/`, `deploy-org/`, `deploy-workbench/`,
  `deploy-infrastructure/` — the trees that define IAM, CI and the reviewer
  itself
- `utils/`, `scripts/`, `run-script.ts` — these look like library and tooling
  code but are reached by IaC and by a credentialled workflow. See below.
- `package.json`, `package-lock.json`, `tsconfig.json`, `.dockerignore`

Keep changes that need a human in their own PR: one file under an owned path
pulls the whole PR into human review.

**The non-obvious part.** Some owned paths are owned because something
outside their directory reaches in, and you cannot see it from the file:
`deploy/components/identity-center/policies.ts` imports its permission-set
resource ARNs from `utils/bedrock-models.ts` and its account ids from
`utils/accounts.ts`; `deploy-workbench.yml` runs
`scripts/enable-bedrock-models.ts` under a deploy role; and `run-script.ts`
dynamically imports anything in `scripts/`. Before you assume a file is
harmless, check what executes it, or what reads it.

The same applies to CI ordering. `deploy.yml` runs install, test and build
**strictly before** the Configure AWS Credentials step, because the deploy
role carries `AdministratorAccess` and `npm test` executes repository
code. Do not move a step that runs
repository code below that credentials step.

Both halves are explained at length in `.github/CODEOWNERS`. Read it before
adding a path to either side; scope by directory, not by file.

## Scripts

Scripts are standalone TypeScript modules in `scripts/`, each exporting a default async function. Run with:

```bash
npm run script <script-name>
```

Environment variables for scripts live in `scripts/.env` (see `scripts/.env.example`).

## Delegate

The delegate system runs the `pr-reviewer` agent on GitHub webhooks. Architecture:

```
GitHub webhook → Lambda (webhook handler) → ECS Fargate task → Claude Agent SDK → review posted to the PR
```

The Delegate Slack bot is the self-hosted agent-swarm in `agent-swarm/`, not this.

### Key directories

- `delegate/framework/` — Agent registry and execution engine
- `delegate/agents/` — Agent definitions (currently: `pr-reviewer`)
- `delegate/lambdas/` — Lambda webhook handler with GitHub signature verification, ECS dispatch
- `delegate/worker/` — Fargate container entrypoint, GitHub App auth, Dockerfile. The entrypoint enforces a hard wall-clock deadline (`AGENT_DEADLINE_MS`, default 45m) that aborts the agent and exits the task — ECS has no native per-task timeout, and the SDK's `maxTurns`/`maxBudgetUsd` caps only fire between turns, so a hung tool call would otherwise run forever. The entrypoint also checks out the PR's repo at the exact reviewed head SHA at `/app/review` (the agent's cwd) before the agent starts, so no agent clones mid-run — repo-agnostic, submodules synced, and the head SHA is resolved from the live PR on the re-review path where dispatch omits it.
- `delegate/review/eval/` — pairwise eval for the pr-reviewer: snapshot production cases from S3, replay them from any checkout, judge variants with a blind model, and post results as a PR comment via `.github/workflows/delegate-eval.yml` (comment `delegate eval` on a PR to trigger it). See `delegate/review/eval/README.md`.
- `delegate/review/` — the deterministic half of `pr-reviewer`. The agent only reads code and emits a structured review (`schema.ts`: findings + summary, or `failed`); everything that touches GitHub or AWS lives here. `run.ts` is the sequence: S3 lock per `(pr, sha)` → build the agent's input bundle (`bundle.ts`: PR metadata, locally computed diff, the bot's own prior findings from S3) → run the agent with an allowlisted environment (no credentials), only Read/Grep/Glob plus a read-only git MCP tool (`git-tool.ts`), and a PreToolUse hook that denies any file path outside the checkout (so `/proc/<pid>/environ` of the worker is unreachable) → validate the output → derive the verdict (`gates.ts`: approve iff zero findings; who may merge is GitHub's job via classic branch protection on `main`) → anchor every finding to a diff line (`anchors.ts`: snap or clamp into the nearest hunk; a path outside the diff is dropped but still blocks approval; the body carries the verdict and the reasoning, never a finding) → post one review pinned to the reviewed sha, set the `pr-reviewer` status on that sha, dismiss the approval if the tip moved during the run → write the `ReviewRecord` to `s3://delegate-reviews/reviews/<repo>/<pr>/<sha>/<runId>.json`. A finding is a blocker by definition. Thread state on GitHub is never an input: a prior finding stays open until the agent stops finding it, and the poster un-resolves a human-resolved thread whose finding is still present. A schema failure or subagent failure is a run failure (`error` status, failure comment, `review_failed` event), never a partial review.
- Agents run in the SDK's isolation mode (no `settingSources`), so CLAUDE.md is NOT auto-loaded. `pr-reviewer` deliberately stays isolated: it reads a repo's CLAUDE.md via the Read tool as reference to review *against*, rather than injecting it as system instructions — otherwise a PR could edit CLAUDE.md to steer the verdict (prompt injection). For the same reason the PR title and body reach it wrapped in `<untrusted>`, and author comments and replies do not reach it at all; author pushback on a finding goes to a human reviewer, who approves instead of the bot.

### Adding a new agent

1. Create a new file in `delegate/agents/` using `defineAgent()` from the framework
2. Import it in `delegate/agents/index.ts`
3. Add a webhook route in `delegate/lambdas/handler.ts`
4. Give it a branch in `delegate/worker/entrypoint.ts`, which today runs only `pr-reviewer`

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
- IAM roles for ECS execution, task, and Lambda
- IAM Identity Center permission sets and account assignments

### CI/CD

On push to `main`, the GitHub Actions workflow:

1. Type-checks with `tsc --noEmit`
2. Bundles the Lambda handler with esbuild
3. Compiles the worker TypeScript
4. Builds and pushes a Docker image to ECR
5. Runs `pulumi up` via `deploy/deploy.sh`

PRs run type-checking and builds but skip the deploy step, and run
`pulumi preview` for `ops`, `org` and `workbench` under the scoped read-only
`github-actions-pulumi-preview` role, posting one comment per project per run.
Read [`docs/pr-previews.md`](./docs/pr-previews.md) before touching
`deploy/components/ci-roles*`, the `deploy.sh` scripts, or PR-triggered
workflows; it records the role, its threat model, and how to run a preview
locally under `gp-readonly`.

Narrowing the shared deploy role's trust for the other repositories that
assume it, and sizing roles for their PR-triggered workflows, is a separate
plan:
[`docs/deploy-role-trust.md`](./docs/deploy-role-trust.md). Read it alongside
the above before editing `githubActionsPulumiDeployTrust`.

## Build Commands

```bash
npm run build          # Bundle Lambda handler and compile delegate TypeScript
```
