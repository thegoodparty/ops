# Delegate

AI agent framework powered by the Claude Agent SDK. Lambda webhook receives Slack/GitHub events, dispatches an ECS Fargate task that runs the agent, callback returns the result to the original surface.

See `ops/CLAUDE.md` for the high-level architecture and `delegate/.env.example` for the full env contract.

## Workflow agents (PRD-to-code)

Four phase agents driven by Slack `@delegate <verb>` mentions:

- `tech-design-agent` — `@delegate tech-design <prd-url> [repos: name,name]`
- `epic-agent` — `@delegate epic <design-url>`
- `epic-edit-agent` — `@delegate epic-edit <epic-url> <feedback>`
- `task-execution-agent` — `@delegate work <task-id>`

Continuation verbs (`bless` / `edit` / `investigate` / `abandon` / `stage` / `resume` / `go` / `plan` / `focus` / `split`) reply in-thread and route back to the phase agent that wrote the most recent bot post (parsed from its `[phase=...]` header).

### Authorization

- **No per-user gate.** Any user in any channel where `@delegate` is invited can invoke any verb. The trust boundary is the Slack workspace + which channels the App is added to. Limit the App's channel membership to control who can trigger workflow runs.
- **Repo write scope** for `task-execution-agent` is restricted to the `WRITE_REPOS` set in `delegate/framework/repos.ts`. The set is interpolated into the agent's system prompt at module-load time, so there's a single source of truth — the LLM sees the same list the code defines. Enforcement is currently prompt-level; see the comment in `repos.ts` for how to add a runtime `PreToolUse` hook if needed.

### Required preconditions for boot

- The `delegate` GitHub App must be installed on `thegoodparty/runbooks` (read access). The worker entrypoint clones it on every Fargate task boot for workflow agents; framework agents (`slack-responder`, `pr-reviewer`) skip the clone.
- The `delegate` GitHub App must be installed on every repo in `WRITE_REPOS` with `pull_requests:write` (for `task-execution-agent` to open PRs).

## Operator: bot got stuck

### Symptom: agent never responds in Slack thread

1. Check the `:eyes:` reaction on the user's mention. If absent, Lambda didn't accept the event — check Lambda CloudWatch logs for the `/slack` route and confirm Slack signature verification passed.
2. If `:eyes:` is set but no callback came back, the Fargate task stalled or crashed. The Lambda logs the dispatched task ARN; find it and check ECS:

   ```sh
   aws ecs describe-tasks --cluster delegate-cluster --tasks <task-id> --region us-west-2
   ```

3. If the task exited 1 with no output, `setupGitHubAuth` or the boot-time runbooks clone failed. The worker now best-effort posts a boot-failure message to the originating Slack thread before exiting — check the thread first. If still ambiguous, re-mention the bot to retry; if the failure persists, check GitHub App installation health (the App must be installed on `thegoodparty/runbooks`) and worker network egress.

### Symptom: `Cannot write to <repo>` from `task-execution-agent`

Repo isn't in `WRITE_REPOS`. To extend the allowlist, edit only:

- `delegate/framework/repos.ts` — the agent prompt re-renders the list automatically.

Also confirm the GitHub App is installed on the new repo with `pull_requests:write`. (If you also want auto-PR-review on the new repo, separately add it to `REVIEW_REPOS` in `delegate/lambdas/github.ts`.)

### Symptom: agent loops or burns budget

Look for the `result` log line in the agent's CloudWatch stream and check `costUsd`. If a phase regularly exceeds its `maxBudgetUsd`, tune the value in the agent file (e.g., `delegate/agents/task-execution-agent.ts`) and redeploy. Per-phase cost is also charted in the `Delegate/Workflow:PhaseCostUsd` metric (dimensioned by `phase` and `outcome`, see `deploy/components/worker.ts`).

### Symptom: stale runbook command in production

The worker re-clones `thegoodparty/runbooks` at every boot, so updates to `commands/*.md` propagate without an `ops` redeploy. Confirm the `runbooks=<sha>` value in the agent's message footer matches HEAD of `thegoodparty/runbooks` master. If it lags, re-mention the bot — the next task boot will re-clone from current master.

### Symptom: malformed header in Slack thread

If a user replies with a continuation verb and gets `No prior workflow state found in this thread`, but a prior bot post is clearly a workflow post, look for a `workflow_malformed_header` warning in the Lambda log — the agent emitted a header that didn't pass validation. Check the agent prompt and `delegate/framework/thread-state.ts:parseHeader` for the contract.
