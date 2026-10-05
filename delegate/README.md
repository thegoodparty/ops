# Delegate

AI agent framework powered by the Claude Agent SDK. Lambda webhook receives Slack/GitHub events, dispatches an ECS Fargate task that runs the agent, callback returns the result to the original surface.

See `ops/CLAUDE.md` for the high-level architecture and `delegate/.env.example` for the full env contract.

## Workflow agents (PRD-to-code)

Four phase agents drive a PRD → tech design → Epic → task-execution flow, each invoked by a Slack `@delegate <verb>` mention. The flow is meant to compose: a `tech-design` produces the input to `epic`, which produces task IDs for `work`. Iterations happen via continuation verbs replied in-thread.

### Write verbs (start a new run)

Each write verb starts a fresh phase in a new thread. Examples below target this repo (`ops`); substitute repo names / list IDs / IDs as appropriate for your workflow.

#### `tech-design` — produce a draft technical design from a PRD

```
@delegate tech-design <prd-url> [repos: name,name]
```

The agent reads the PRD (Google Doc, ClickUp doc, Confluence, or pasted text URL), recons the named repos (or infers from the PRD if `repos:` is omitted), and creates a `[DRAFT] <title>` ClickUp doc with a tech design. Reply `bless` once you've reviewed it; reply `edit "..."` to iterate. Multi-repo recons take longer (~5–10 min) and cost more (~$1–3) than single-repo (~2–5 min, ~$0.50).

Examples:

```
@delegate tech-design https://goodparty.clickup.com/90132012119/v/dc/2ky4jq2q-92493
@delegate tech-design https://goodparty.clickup.com/90132012119/v/dc/2ky4jq2q-92493 repos: ops
@delegate tech-design https://docs.google.com/document/d/abc123/edit repos: ops, gp-api
```

#### `epic` — turn a blessed tech design into a ClickUp Epic + subtasks

```
@delegate epic <design-url> [list:<list-id>]
```

The agent fetches the blessed design, generates an Epic + N agent-ready subtasks (Context / Implementation Details / AC / Test Plan), and POSTs them to ClickUp. The target list comes from (in order): the `list:<id>` Slack arg → a `clickupListId:` field in the design's frontmatter → an explicit error. Reply `bless` to commit, `abandon` to keep the draft tickets but stop iterating. (Use `epic-edit` for edits, not `edit`.)

To find a list ID, open the list in ClickUp and copy the trailing number from the URL (`/li/<list-id>`).

Examples:

```
@delegate epic https://goodparty.clickup.com/90132012119/v/dc/2ky4jq2q-91893/2ky4jq2q-71533 list:901327113572
@delegate epic https://goodparty.clickup.com/90132012119/v/dc/abc-def/page-id
```

#### `epic-edit` — modify an existing Epic + subtasks in place

```
@delegate epic-edit <epic-url> <feedback>
```

The agent loads the Epic, reads the feedback, and posts a proposed diff plan (add/modify/delete subtasks, field changes). Reply `bless` to apply it, `edit "..."` to revise the plan, or `abandon` to discard. Use this instead of `edit` when iterating on an already-created Epic — the dedicated edit agent has snapshot-before-change discipline and won't delete subtasks without an explicit `bless`.

Example:

```
@delegate epic-edit https://app.clickup.com/t/86ahahm8f bump task 5 to high priority and add an AC for telemetry on task 12
```

#### `work` — implement a single task and open a PR

```
@delegate work <task-id>
```

The agent fetches the ClickUp task, posts a scope-confirm message (`Reply: go / plan / focus <part> / split`), and stops. Reply `go` to implement: the agent clones the target repo, branches `delegate/<task-id>`, edits per the task's Implementation Details, runs the repo's tests, opens a PR, and posts the link. Repo target is parsed from the task body and gate-checked against `WRITE_REPOS` — currently `gp-api`, `gp-webapp`, `people-api`, `election-api`, `ops`. Tasks targeting other repos abort cleanly with no clone or branch.

Examples:

```
@delegate work 86ahahmac
@delegate work https://app.clickup.com/t/86ahahmac
```

### Continuation verbs (reply in-thread)

Continuation verbs route back to the agent that wrote the thread's most recent bot post (parsed from its `[phase=...]` header). Behavior depends on the phase:

| Verb                       | Where it applies               | What it does                                                                                                                                           |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bless`                    | tech-design / epic / epic-edit | Marks the draft committed (`status=blessed`). Tech-design: removes `[DRAFT]` prefix from doc name. Epic / epic-edit: tickets stay as-is.               |
| `edit "<feedback>"`        | tech-design only               | Iterate on the draft design with feedback. (For Epics, use `@delegate epic-edit ...` directly — `edit` in an `epic` thread will redirect you.)         |
| `investigate "<question>"` | tech-design                    | Dig deeper into a specific aspect of the design before blessing (e.g., a perf concern, a 3rd-party dep).                                               |
| `abandon`                  | any phase                      | Stop iterating. Drafts are preserved (not deleted) so you can resume later or just walk away.                                                          |
| `stage`                    | tech-design                    | Save the draft for later resumption without blessing.                                                                                                  |
| `resume`                   | any phase                      | Continue a previously-staged or interrupted run.                                                                                                       |
| `go`                       | task-execution scope-confirm   | Approve the scope and start implementing.                                                                                                              |
| `plan`                     | task-execution scope-confirm   | Write a detailed implementation plan to Slack + ClickUp comment; do not touch code. Useful when you want to iterate on the approach before committing. |
| `focus <part>`             | task-execution scope-confirm   | Implement only the named subset of AC items. PR description flags partial scope.                                                                       |
| `split`                    | task-execution scope-confirm   | Propose 3–5 smaller subtasks; on `bless` redirects you to `@delegate epic-edit` to commit them.                                                        |

Continuation verbs are routed by parsing the most recent bot post's `[phase=...]` header in the thread, so always reply in the same thread as the bot's post — not in a new mention.

### Authorization

- **No per-user gate.** Any user in any channel where `@delegate` is invited can invoke any verb. The trust boundary is the Slack workspace + which channels the App is added to. Limit the App's channel membership to control who can trigger workflow runs.
- **Repo write scope** for `task-execution-agent` is restricted to the `WRITE_REPOS` set in `delegate/framework/repos.ts`. The set is interpolated into the agent's system prompt at module-load time, so there's a single source of truth — the LLM sees the same list the code defines. Enforcement is currently prompt-level; see the comment in `repos.ts` for how to add a runtime `PreToolUse` hook if needed.

### Required preconditions for boot

- The `delegate` GitHub App must be installed on `thegoodparty/omni` (read access). The worker entrypoint does a partial + sparse clone of omni (just `packages/runbooks`) on every Fargate task boot for workflow agents; framework agents (`slack-responder`, `pr-reviewer`) skip the clone.
- The `delegate` GitHub App must be installed on every repo in `WRITE_REPOS` with `pull_requests:write` (for `task-execution-agent` to open PRs).
- The reviewer GitHub App must be installed on every repo in `REVIEW_REPOS` with `pull_requests:write` and `statuses:write`, and the worker task role must reach the `delegate-reviews` S3 bucket (`deploy/components/worker.ts`).

## PR reviewer

`pr-reviewer` reviews every push to a non-draft PR in a `REVIEW_REPOS` repo (opened, marked ready, or synchronized), and again on a `delegate review` comment. The agent reads the checkout and emits a structured review; `delegate/review/run.ts` does everything else.

### Before and after

```
Before                                              After

GitHub webhook                                      GitHub webhook
   │                                                   │
   ▼                                                   ▼
Lambda ── RunTask ──▶ Fargate worker                Lambda ── RunTask ──▶ Fargate worker
                        │ checkout PR @ head sha                            │ checkout PR @ head sha
                        ▼                                                   ▼
                      Agent (opus) + Bash + gh + App token              review/run.ts  (plain code, tested)
                        │  800-line prompt tells the model to:            │ S3 lock (pr, sha)
                        │  - dedup via statuses, debounce                 │ bundle: PR meta + local diff + own prior findings
                        │  - scout → deep-reviewers                       ▼
                        │  - reconcile prior threads, saturation        Agent (opus): Read/Grep/Glob + read-only git tool
                        │  - apply gates (self-review, TDD, perms)        │ no Bash, no network, allowlisted env,
                        │  - decide approve / comment                     │ file tools confined to the checkout
                        │  - gh api: post review, statuses, telemetry     │ scout → deep-reviewers
                        ▼                                                 ▼
                      GitHub review + status                            { findings[], summary } | { failed }
                      (whatever the model decided to run)                 │ Zod-validated
                                                                          ▼
                                                                        review/run.ts
                                                                          │ verdict = findings.length === 0
                                                                          │ never-approve author gate
                                                                          │ anchor findings to diff lines
                                                                          │ superseded if tip moved; dismiss stale approve
                                                                          │ resolve / un-resolve own threads
                                                                          ▼
                                                                        GitHub review + per-sha status + S3 record
```

Rules that hold regardless of what the model says:

- Approve means zero findings. A finding is a blocker. The bot never posts REQUEST_CHANGES.
- Authors in `NEVER_APPROVE_AUTHORS` (`delegate/review/gates.ts`) get a comment-only review whose body still says `Recommendation: approve`; a human approves.
- The review and the `pr-reviewer` status are pinned to the sha that was checked out. `pr-reviewer` is a required check on omni, so a new push is unmergeable until its own run finishes.
- One run per `(pr, sha)` from webhooks (S3 conditional-put lock). Runs on different shas of the same PR may overlap. If the tip has moved by the time a run is ready to post, it posts nothing: the status on its sha reads "Superseded", the record is kept with `action: skipped`, and the newer sha's run carries the findings. An approve that lands just before a push is dismissed. `delegate review` bypasses the lock with a new run id.
- Re-review compares against the bot's own last record in S3, not GitHub thread state. Still-present findings are not reposted; their threads are listed in the body and un-resolved if a human resolved them. Fixed findings get their threads resolved.
- A schema or subagent failure posts `Review failed: <reason>`, sets the status to `error`, and writes a record with `action: failed`.

Every run writes `s3://delegate-reviews/reviews/<repo>/<pr>/<sha>/<runId>.json` with the full input bundle, the agent output, the posted action, cost and `agentVersion` (the ops commit of the image).

## Operator: bot got stuck

### Symptom: agent never responds in Slack thread

1. Check the `:eyes:` reaction on the user's mention. If absent, Lambda didn't accept the event — check Lambda CloudWatch logs for the `/slack` route and confirm Slack signature verification passed.
2. If `:eyes:` is set but no callback came back, the Fargate task stalled or crashed. The Lambda logs the dispatched task ARN; find it and check ECS:

   ```sh
   aws ecs describe-tasks --cluster delegate-cluster --tasks <task-id> --region us-west-2
   ```

3. If the task exited 1 with no output, `setupGitHubAuth` or the boot-time omni clone failed. The worker now best-effort posts a boot-failure message to the originating Slack thread before exiting — check the thread first. If still ambiguous, re-mention the bot to retry; if the failure persists, check GitHub App installation health (the App must be installed on `thegoodparty/omni`) and worker network egress.

### Symptom: `Cannot write to <repo>` from `task-execution-agent`

Repo isn't in `WRITE_REPOS`. To extend the allowlist, edit only:

- `delegate/framework/repos.ts` — the agent prompt re-renders the list automatically.

Also confirm the GitHub App is installed on the new repo with `pull_requests:write`. (If you also want auto-PR-review on the new repo, separately add it to `REVIEW_REPOS` in `delegate/lambdas/github.ts`.)

### Symptom: agent loops or burns budget

Look for the `result` log line in the agent's CloudWatch stream and check `costUsd`. If a phase regularly exceeds its `maxBudgetUsd`, tune the value in the agent file (e.g., `delegate/agents/task-execution-agent.ts`) and redeploy. Per-phase cost is also charted in the `Delegate/Workflow:PhaseCostUsd` metric (dimensioned by `phase` and `outcome`, see `deploy/components/worker.ts`).

### Symptom: stale runbook command in production

The worker re-clones omni (sparse, just `packages/runbooks`) at every boot, so updates to `commands/*.md` propagate without an `ops` redeploy. Confirm the `runbooks=<sha>` value in the agent's message footer matches HEAD of `thegoodparty/omni`'s default branch (`main`). If it lags, re-mention the bot — the next task boot will re-clone from current `main`.

### Symptom: malformed header in Slack thread

If a user replies with a continuation verb and gets `No prior workflow state found in this thread`, but a prior bot post is clearly a workflow post, look for a `workflow_malformed_header` warning in the Lambda log — the agent emitted a header that didn't pass validation. Check the agent prompt and `delegate/framework/thread-state.ts:parseHeader` for the contract.
