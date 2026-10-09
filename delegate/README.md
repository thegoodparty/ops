# Delegate

Runs `pr-reviewer` on GitHub webhooks. A Lambda receives the event and dispatches an ECS Fargate task that runs the agent through the Claude Agent SDK. The Delegate Slack bot is the self-hosted agent-swarm in `agent-swarm/`, not this.

See `ops/CLAUDE.md` for the high-level architecture and `delegate/.env.example` for the full env contract.

## Required preconditions

- The reviewer GitHub App must be installed on every repo in `REVIEW_REPOS` with `pull_requests:write` and `statuses:write`, and the worker task role must reach the `delegate-reviews` S3 bucket (`deploy/components/worker.ts`).

## PR reviewer

`pr-reviewer` reviews a PR in a `REVIEW_REPOS` repo when it is opened or marked ready, and reviews a later push only when someone comments `delegate review`. The agent reads the checkout and emits a structured review; `delegate/review/run.ts` does everything else.

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
                                                                          │ anchor every finding to a diff line (no body text)
                                                                          │ superseded if tip moved; dismiss stale approve
                                                                          │ resolve / un-resolve own threads
                                                                          ▼
                                                                        GitHub review + per-sha status + S3 record
```

Rules that hold regardless of what the model says:

- Approve means zero findings. A finding is a blocker. The bot never posts REQUEST_CHANGES.
- The review body is the recommendation line, the agent's reasoning for it (what the change does, what was checked and falsified, what a human should confirm), a count of new inline findings, the prior findings still open, and the run footer. Every finding is an inline comment; the body never carries one. A finding whose line is outside the diff hunks is moved to the nearest changed line in that file; a finding on a path not in the diff is not posted, still counts against approval, and is kept on the record. 
- Who may merge is not delegate's decision. Classic branch protection on `main` (omni and ops) restricts pushes, and therefore merges, to the `gp-contrib` team; bots open and review PRs but cannot merge them.
- The review and the `pr-reviewer` status are pinned to the sha that was checked out. `pr-reviewer` is a required check on omni, so a push nobody asked delegate to review is unmergeable until someone does.
- One run per `(pr, sha)`, whoever asked (S3 conditional-put lock). A `delegate review` comment on a sha that already has a run gets a one-line reply, the check restored to that run's outcome, and nothing else, failed runs included; push a new commit and comment again. A lock with no record behind it after an hour is a dead task and is reclaimed; a run that aborts before reviewing releases its lock. Runs on different shas of the same PR may overlap. If the tip has moved by the time a run is ready to post, it posts nothing: the status on its sha reads "Superseded", the record is kept with `action: skipped`, and the newer sha's run carries the findings. An approve that lands just before a push is dismissed.
- Re-review compares against the bot's own last record in S3, not GitHub thread state. Still-present findings are not reposted; their threads are listed in the body and un-resolved if a human resolved them. Fixed findings get their threads resolved.
- A schema or subagent failure posts `Review failed: <reason>`, sets the status to `error`, and writes a record with `action: failed`.

Every run writes `s3://delegate-reviews/reviews/<repo>/<pr>/<sha>/<runId>.json` with the full input bundle, the agent output, the posted action, cost and `agentVersion` (the ops commit of the image).
