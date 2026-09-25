# BugBoss architecture

Why it is built this way, and where each piece lives. For what it is *for*,
read [`purpose.md`](./purpose.md) first.

## One container

BugBoss is a single ECS Fargate task. Incident agents are **child processes
of that task**, not separate tasks.

That one decision removes a lot: no `RunTask`, no client tokens, no
`ListTasks` eventual-consistency window, no leases, no SQS, no Service
Connect. The cost is that a deploy takes everything down together, which is
why `deploymentMinimumHealthyPercent` is `0` — two tasks would put two
processes on the same SQLite file and the same agent sessions, and that is a
correctness bug rather than a tuning choice.

```
Grafana ─┐
         ├─► ALB ─► container ──┬─► triage ─► assign ─► dispatcher
Slack  ──┘                      │                          │
                                │                          ├─► agent (child)
                                └─► SQLite ──► S3          ├─► agent (child)
                                    (every write)          └─► … up to 15
```

## The data model

Two tables carry everything.

**`signal`** — an immutable fact. Something told us something is wrong.
Identified by `(source, sourceId)`, unique **among open signals only**. That
scoping matters: a Grafana fingerprint is stable for the life of the alert
rule, so an all-time unique key would mean the second time an alert ever
fires it is discarded as a duplicate, and recurrence becomes unreachable.

**`incident`** — a mutable unit of work. Signals attach to it; it moves
through a lifecycle; it ends with a post-mortem.

```
INVESTIGATING ──► FIXING ──► RESOLVED ──► CLOSED
       │             │
       └──► MERGED ◄─┘        (absorbed into another incident)
```

`status` is **where the work is**. `owner` (`agent` | `human`) is **who has
it**, and the two are orthogonal. A PR is not a phase: resolving may take
zero pull requests or four.

`RESOLVED` means no users are affected any more and no further alerts should
occur, confirmed by evidence rather than asserted. That bar is what makes a
post-resolution signal unambiguous evidence of a premature close.

Cross-field `CHECK` constraints make the illegal states unrepresentable — a
`MERGED` row must have `mergedInto`, a `CLOSED` one must have a post-mortem.
They are in the schema rather than a migration because SQLite cannot add a
`CHECK` to an existing table and there is no migration runner here.

## One primitive: `assign`

Create, attach, merge and split are all the same operation — re-partition
signals across incidents.

| Operation | Call |
| --- | --- |
| Create | one signal → `NEW` |
| Attach | one signal → existing incident |
| Merge | all of B's signals → A |
| Split | a subset of A's signals → `NEW` |

`toolapi/assign.ts` is the single writer that holds the invariants: never
attach across `RESOLVED`, never to a `CLOSED` or `MERGED` target, never to
one a human owns.

## The path an alert takes

**1. Ingress** (`ingress/`) verifies and parses. Grafana's HMAC is over
`timestamp:body` with a replay window; Slack's is its own `v0=` scheme. Both
fail closed — a missing secret rejects every delivery rather than accepting
any.

The webhook **acknowledges before it works**: it verifies and inserts the
signal rows synchronously, returns 200, then runs prefetch and triage off
the request. A burst of fifteen alerts at ~55s of triage each would
otherwise outlast Grafana's timeout and the ALB's, and the retry would
arrive while the first delivery was still working.

Resolve notifications are **discarded**. An alert that stopped firing on its
own has not stopped mattering — the symptom went away, which is not the same
as the cause being handled.

**2. Evidence prefetch** runs the alert's own `known_causes` LogQL before any
model sees it. This is deterministic, costs no agent turns, and is where
triage quality comes from. A query that fails returns `EVIDENCE UNAVAILABLE`
rather than an empty result, so "we did not check" never reads as "we
checked and found nothing".

**3. Triage** (`triage/`) decides: attach, new incident, or suppress. The
model is advisory about the match; `applyRules` holds the invariants. It
cannot suppress a cause the alert did not declare as suppressible, and it
cannot attach across `RESOLVED`.

**4. Dispatch** (`dispatcher/`) launches one agent per incident, up to 15.
That cap is a circuit breaker, not a scheduler — hitting it means something
is wrong. Ticks are serialized against each other: a tick awaits an S3 put
and an STS call before recording a launch, so overlapping ticks would start
two children on one incident, and both would write the same session file.

**5. The agent** (`agent/`) runs Pi against Bedrock in the same container.
It gets a fresh `git clone --filter=blob:none` of omni, the Grafana MCP
toolset, and a scoped token for the Boss's loopback API. It investigates,
fixes, opens a PR, waits for a merge and a deploy, and writes a post-mortem.

## What bounds an agent

An agent is a child process of the Boss, running as the same user. It
resolves the task role through the container credential provider, exactly as
its parent does, so whatever the Boss can reach in AWS an agent can reach
too. There is no privilege boundary inside the container — a child can read
the parent's own environment — so anything claimed at that line would be a
claim rather than a control.

The boundary that is real is the task. This container holds no database
credentials, no deploy role and no merge rights. Its AWS identity reads logs,
metrics and ECS state, calls Bedrock, and writes its own bucket; it cannot
reach RDS, the release path, or any secret but its own. The GitHub App opens
pull requests and cannot merge one, enforced by branch protection on `main`
rather than by the prompt. So every effect an agent can have on the platform
arrives as a pull request a human approves.

The loopback API is the **interface** to incident state, not a fence around
it. Every transition is one HTTP call on `127.0.0.1` carrying a bearer token
minted per launch; the incident is derived from the token and then checked
against the path, so a valid token for incident A cannot be aimed at B. That
check is what keeps fifteen concurrent agents out of each other's incidents.

Five state-changing tools, each a transition:

| Tool | Transition |
| --- | --- |
| `report_root_cause` | `INVESTIGATING → FIXING`. Triggers correlation, splits the unexplained |
| `report_impact` | Repeatable; impact grows during an incident |
| `report_resolved` | `FIXING → RESOLVED`, with evidence |
| `report_analysis` | `RESOLVED → CLOSED`, terminal |
| `hand_off` | Sets `owner: human`, posts the brief |

Plus two blocking tools that live in the harness, each costing one turn no
matter how long it waits — which is what keeps a multi-day incident from
saturating context on polling:

- `monitor(command, interval, timeout)` — block until a read-only check
  passes. The general primitive: PR merged, deploy shipped, alert quiet
- `contact_human(message, timeout)` — post to the thread and block for a
  reply. Re-entrant: the marker is written before the post, so a resumed
  agent resumes waiting rather than asking twice

### How an agent learns things changed

There is no push channel and an agent is never addressable. Directives ride
back on responses to calls the agent was already making — `stop`, `merged`,
`handoff`, `new_signals`, `human_message`, `resumed_after`.

## Durability

**SQLite, mirrored to S3 synchronously.** Every write goes through
`withWrite`, which serializes writes, runs the transaction, `VACUUM INTO` a
snapshot, and does not resolve until S3 has it. When an agent's
`report_root_cause` returns, the transition is durable.

A failed PUT **halts writes** rather than continuing. A process that keeps
committing locally while S3 falls behind is worse than one that stops,
because the divergence stays invisible until a restart loses it.

**Agent sessions are JSONL on local disk, mirrored to S3 per turn.** A
restart restores the file and Pi resumes, replaying thinking blocks. This
works because a thinking block's signature is bound to the prefix — the
system prompt, the tools array and every earlier message — and does not
expire.

Every merge to ops `main` restarts this container, so resume is the normal
path, not the exceptional one.

## Layout

| Directory | What |
| --- | --- |
| `ingress/` | Verify and parse per source. Adding a source is one adapter |
| `triage/` | The decision, and the rules that bound it |
| `toolapi/` | `assign`, the transitions, correlation |
| `dispatcher/` | Launch, deadlines, escalation, the circuit breaker |
| `agent/` | The incident agent: Pi session, tools, prompt, resume |
| `bedrock/` | A Pi provider over Bedrock `InvokeModel` |
| `slack/` | Outbound relay and the read-only Slack agent |
| `http/` | Public routes and the loopback tool API |
| `db/` | SQLite, and the S3 mirror |
| `index.ts` | The composition root. The only place real services are named |

`types.ts` is the contract every module is built against. `logging.ts` is
the one place `alarm` and `log` are defined.

## Choices worth knowing

**Bedrock via `InvokeModel`, not `Converse`.** Converse drops thinking
blocks that have empty text but live signatures, which is exactly the shape
Opus 5 produces. Resume depends on those surviving.

**Wall-clock timeout, not budget caps.** A deadline is external, so it costs
nothing in harness capability. Two layers: the child steers itself to write
a brief at the soft deadline, and the parent SIGKILLs strictly later.

**Compaction at 95% of the context window**, made safe by bounded tool
results.

**Tokens, not dollars.** Pricing moves; a stored dollar figure would be a
guess frozen at write time, while tokens plus `modelId` multiply out
correctly whenever asked.
