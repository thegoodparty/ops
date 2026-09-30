# What it costs, and what it gives up

The claim under test: an off-the-shelf agent operating system plus a thin layer
can replace most of BugBoss. This document makes that claim concrete. It measures
what BugBoss is made of, what agent-swarm gives us for nothing, what we wrote on
top of it, and what the whole exercise gives up. The last section is the honest
one and it is the one to read.

Source of truth: [`../README.md`](../README.md) for what this is,
[`../../bugboss/docs/architecture.md`](../../bugboss/docs/architecture.md) for what
BugBoss is.

## The measurement

Line counts are non-test TypeScript under each BugBoss module, plus the four root
files named in the table, measured with `wc -l` on 2026-09-29 against commit
`747fe21` of this worktree. Tests are excluded; they are 29,349 lines on their own.

| Module | Lines | What it does | agent-swarm equivalent |
| --- | ---: | --- | --- |
| `agent/` | 6,019 | The incident agent: a Pi session, its tools, its prompt, its resume | **Yes.** agent-swarm runs harnesses (pi among them) in workers, with task lifecycle and a context-preamble resume. |
| `bedrock/` | 1,790 | The Pi provider over Bedrock `InvokeModel`, plus the Boss's bounded-call client | **Partial.** agent-swarm runs Bedrock through pi (alpha), but this build uses Anthropic directly and has no equivalent of the Boss's bounded structured calls. |
| `board/` | 377 | When the status board says anything: the thread header, the 07:00 post, the all-clear | **No.** A scheduled task plus the prompt replaces it. |
| `db/` | 500 | SQLite, and the synchronous S3 mirror | **Yes.** SQLite with Litestream. |
| `dispatcher/` | 1,317 | Launch, deadlines, escalation, parking, the stale sweep, the circuit breaker | **Partial.** agent-swarm has a task queue and worker pool; deadlines, parking and an in-loop stale detector are ours or absent. |
| `http/` | 1,029 | Public routes and the loopback tool API | **Yes.** agent-swarm serves an HTTP API and an MCP surface. |
| `ingress/` | 1,320 | Verify and parse per source, acknowledge before working | **Partial.** agent-swarm has webhooks for many sources but no Grafana alert ingest; the bridge replaces it. |
| `report/` | 1,137 | The closing report: assemble, render, publish once | **Partial.** File upload exists; assembly and rendering are prompt-driven. |
| `slack/` | 3,734 | Outbound relay, inbound intent read, a read-only Slack agent, and text rendering | **Yes.** The Slack app, threads, live steering and rendering ship with agent-swarm. |
| `toolapi/` | 1,867 | `assign` (create, attach, merge, split), the transitions, correlation | **Partial.** agent-swarm has a task lifecycle, but no incident object, no `assign`, and no guarded transitions. |
| `triage/` | 1,851 | The placement decision and the rules that bound it | **No.** Triage is prompt work here. |
| `index.ts` | 2,820 | The composition root. The only place real services are named | n/a. Configuration, not code. |
| `types.ts` | 646 | The contract every module is built against | n/a. |
| `model.ts` | 159 | The seam the Boss's bounded calls are written against | n/a. |
| `logging.ts` | 28 | The one home for `alarm` and `log` | **Partial.** API logging exists; the alarm split does not. |
| **Total** | **24,594** | | |

The count covers every non-test `.ts` file in the eleven modules plus the four
root files, at the commit this was written against. BugBoss's tests are a
further 29,349 lines and are excluded, as are three small files outside those
modules. The absolute figure matters less than the ratio, and the ratio holds
whichever way it is cut: three modules that agent-swarm replaces outright
(`agent/`, `slack/`, `db/`) are 10,253 lines on their own.

## What we get from agent-swarm for free

Everything here is machinery BugBoss had to build because nothing off the shelf
did it:

- **The Slack app, threads and live steering.** A bot identity, thread management,
  live input to a running session, and message rendering.
- **The task lifecycle.** Create, dispatch, steer, complete, retry, with a schema
  for structured results and deferred tasks that wake on an outcome.
- **A dispatcher and worker pools.** A queue, a concurrency cap, and workers in
  isolated containers.
- **Persistent memory.** Vector and full-text search over what agents have written
  down, with citation ratings.
- **KV.** A shared key-value store, which is where this build keeps incident state.
- **Schedules.** Recurring tasks that survive a restart, which is the exact thing
  BugBoss could not have and had to route around.
- **Pages.** Shareable host-rendered pages, unused here.
- **Skills.** Reusable instruction bundles.
- **GitHub integration.** Webhooks and App reactions, plus a token for `gh` and
  `git`.
- **SQLite with Litestream.** The database and its S3 mirror, out of the box.

## What we had to build

The thin layer. Counts are lines in the hand-written files under this directory,
measured on the same date, excluding the docs written for this PR.

| Piece | Lines | What it is |
| --- | ---: | --- |
| `bridge/index.mjs` | 469 | The Grafana bridge: verify the signature, drop resolved alerts, deduplicate on the fingerprint, number incidents, create the task, steer a repeat into the existing task. |
| `bridge/Dockerfile` | 21 | The bridge image. |
| `bridge/package.json` | 14 | No dependencies: the bridge is Node built-ins only. |
| `bridge/README.md` | 40 | The bridge's contract and its limits. |
| `incident-commander.md` | 534 | The lead agent's prompt: the state machine, the KV schema, the three Slack report shapes, the board, evidence rules, and the scheduled jobs. |
| `seed.sh` | 219 | Creates the three recurring jobs through the API. |
| `docker-compose.yml` | 268 | The six-service stack. |
| `deploy.sh` | 762 | All the AWS: security groups, IAM, bucket, load balancer, DNS, instance, and the SSM push. |
| `bootstrap.sh` | 158 | Renders `.env` from the secret, pulls, starts. |
| `user-data.sh` | 104 | First-boot cloud-init: Docker, directories, log rotation, Session Manager. |
| `teardown.sh` | 291 | Removes everything `deploy.sh` created, retaining the bucket by default. |
| `litestream.yml` | 28 | The replication config. |
| `.env.example` | 90 | Every setting, documented. |
| `README.md` | 161 | The front door. |
| `grafana/ADD-INTEGRATION.md` | 101 | The clickops to add the second webhook. |
| `grafana/send-test-alert.sh` | 93 | A signed synthetic alert, to prove the path without a real rule. |
| `slack/INSTALL.md` | 84 | The clickops to install the Slack app. |
| `slack/manifest.json` | 91 | The app manifest. |
| **Total** | **3,528** | |

The three pieces that make it behave like an incident system rather than a general
agent fleet are the bridge (469), the prompt (534) and the schedules (219): 1,222
lines. The rest is deployment scaffolding, most of it in `deploy.sh`.

## What we gave up

This is the section that matters. BugBoss's rigor is structural, and agent-swarm
has none of it. The same discipline exists here, but it is enforced by a prompt,
and a prompt is weaker than code in three ways at once: it can be ignored silently,
it is followed probabilistically rather than exactly, and there is no second reader
to refuse a wrong answer. Concretely:

**No schema, so illegal states are representable.** BugBoss's SQLite has cross-field
`CHECK` constraints: a `MERGED` row must have `mergedInto`, a `CLOSED` one must have
a post-mortem. Those states cannot exist. Here the incident is a JSON blob in a KV
store, and `CLOSED` with a null `postmortem` is one careless `kv-set` away. Nothing
catches it.

**No guarded writes, so a transition can race.** In BugBoss every transition is a
single statement with its precondition inside the `UPDATE`, and the writer rejects
on `changes === 0`. Here `kv-set` is unconditional and replaces the whole value. The
agent is the precondition. The prompt says two of them never run at once in
practice; that is an assumption, not a guarantee.

**No "the model proposes, the rules decide" split, so a wrong answer is stored as
fact.** In BugBoss every place a model touches state is an answer schema plus code
that decides what happens to the answer. Here the agent is both the model and the
rules. Triage, correlation, the merge decision and every status transition are the
agent's to get right, and a confident wrong answer has no second reader.

**No structural separation from the code being fixed.** BugBoss runs with an
identity that reaches no database, no deploy role and no merge rights, and branch
protection, not its prompt, stops its GitHub App from merging. Here the bound is the
same branch protection plus the prompt's instruction not to merge or to edit this
system. The identity that opens the pull request is the identity the prompt is
trusted to restrain.

**No stale detector in the run loop.** BugBoss's dispatcher notices an incident
nobody has worked as part of the loop that launches agents. Here that check is a
job that runs every four hours, so an incident can sit untouched for most of a day
before anyone is told.

What this means in practice: the state machine, the evidence rules and the reporting
shapes in `incident-commander.md` are the only thing holding this build to the same
standard as BugBoss, and they hold by compliance, not by construction. Every rule in
that prompt is one the model can break without anything catching it.

### What it would take to restore it

Each of these is a real change, not a config line:

- **Put the state back under constraints.** Either a small table with the cross-field
  `CHECK`s, or a write API that validates a transition and refuses an illegal one,
  with the precondition inside the write.
- **Split every model decision from its effect.** An answer schema per decision, and
  code that decides what happens to the answer, the way BugBoss's Boss modules do.
- **Give the agent an identity that cannot merge or edit this repo.** Branch
  protection covers merging. `CODEOWNERS` on this directory plus a token that cannot
  push to it covers the rest.
- **Move the stale check into the task loop**, so an unworked incident is noticed by
  the machinery that runs incidents, not by a schedule.

## Verdict

Left open on purpose. This is being measured by observation, not argued, and the
measurements are the ones in
[`../../bugboss/docs/purpose.md`](../../bugboss/docs/purpose.md):

| Measure | What it means here |
| --- | --- |
| Alerts that reached nobody | The number that has to be zero. Both systems see every alert. |
| Time to detect | Unchanged by either system; it measures the alert rules. |
| Time to resolve | Percentiles, not a mean. Compare the two systems on the same alerts. |
| Human minutes per incident | The actual target, and still not instrumented. |
| Outcome | Auto-resolved, human-assisted, unresolved. Auto-resolved must mean no human input beyond the merge. |

The comparison to run: point both systems at the same alert stream, work the same
incidents in each, and compare the five numbers. The interesting result is not which
one is smaller. It is whether the thin layer keeps the rigor that the 24,594 lines
bought, or whether the structure was the thing doing the work all along.
