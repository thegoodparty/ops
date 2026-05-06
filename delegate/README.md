# Delegate

AI agent framework powered by the Claude Agent SDK. Lambda webhook receives Slack/GitHub events, dispatches an ECS Fargate task that runs the agent, callback returns the result to the original surface.

See `ops/CLAUDE.md` for the high-level architecture and `delegate/.env.example` for the full env contract.

## Workflow agents (PRD-to-code)

Four phase agents driven by Slack `@delegate <verb>` mentions:

- `tech-design-agent` — `@delegate tech-design <prd-url>`
- `epic-agent` — `@delegate epic <design-url>`
- `epic-edit-agent` — `@delegate epic-edit <epic-url> <feedback>`
- `task-execution-agent` — `@delegate work <task-id>`

Continuation verbs (`bless` / `edit` / `investigate` / `abandon` / `stage` / `resume` / `go` / `plan` / `focus` / `split`) reply in-thread and route back to the phase agent that wrote the most recent bot post (parsed from its `[phase=...]` header).

Write verbs are gated on `WORKFLOW_USERS` (newline-separated Slack user IDs in the `DELEGATES` secret). Code-writing is gated on `WRITE_REPOS` in `delegate/framework/repos.ts`.

## Operator: bot got stuck

### Symptom: agent never responds in Slack thread

1. Check the `:eyes:` reaction on the user's mention. If absent, Lambda didn't accept the event — check Lambda CloudWatch logs for the `/slack` route and confirm Slack signature verification passed.
2. If `:eyes:` is set but no callback came back, the Fargate task stalled or crashed. The Lambda logs the dispatched task ARN; find it and check ECS:

   ```sh
   aws ecs describe-tasks --cluster delegate-cluster --tasks <task-id> --region us-west-2
   ```

3. If the task exited 1 with no output, `setupGitHubAuth` or the boot-time runbooks clone failed. Re-mention the bot to retry; if the failure persists, check GitHub App installation health and worker network egress.

### Symptom: `not authorized` ephemeral reply on a write verb

User isn't in `WORKFLOW_USERS`. Update the secret:

```sh
aws secretsmanager get-secret-value --secret-id DELEGATES --region us-west-2 \
  | jq -r .SecretString > /tmp/delegates.json
# Edit /tmp/delegates.json — append the user's Slack ID to WORKFLOW_USERS (newline-separated)
aws secretsmanager put-secret-value --secret-id DELEGATES --region us-west-2 \
  --secret-string file:///tmp/delegates.json
rm /tmp/delegates.json
```

The next dispatched task picks up the new value at boot.

### Symptom: `Cannot write to <repo>` from `task-execution-agent`

Repo isn't in `WRITE_REPOS`. To extend the allowlist, edit:

- `delegate/framework/repos.ts` (the runtime guard)
- `delegate/agents/task-execution-agent.ts` (the verbatim list in the system prompt — keep both in sync)

Also confirm the GitHub App is installed on the new repo with `pull_requests:write`.

### Symptom: agent loops or burns budget

Look for the `result` log line in the agent's CloudWatch stream and check `costUsd`. If a phase regularly exceeds its `maxBudgetUsd`, tune the value in the agent file (e.g., `delegate/agents/task-execution-agent.ts`) and redeploy. Per-phase cost is also charted in `Delegate/Workflow:PhaseCostUsd` (see `deploy/components/worker.ts`).

### Symptom: stale runbook command in production

The worker re-clones `thegoodparty/runbooks` at every boot, so updates to `commands/*.md` propagate without an `ops` redeploy. Confirm `RUNBOOKS_SHA` in the agent's final post matches HEAD of `thegoodparty/runbooks` master. If it lags, re-mention the bot — the next task boot will re-clone from current master.
