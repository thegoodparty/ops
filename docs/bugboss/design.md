# BugBoss: agentic alert and incident management

**Date:** 2026-09-23
**Status:** Design in progress, not approved
**Codename:** BugBoss

## Problem

Our API is wired to Grafana. Alerts are configured there and surface in
`#dev-alerts`. That system was built to work alongside a human on-call
rotation, and some alerts still notify the old rotation groups such as
`@serve-bugs`. Those groups are defunct; some weeks they point at nobody.

So today:

- Alerts frequently go unaddressed.
- Alerts frequently *do* represent real user-facing errors.
- Every alert needs a human to confirm, investigate, and triage it.

We are running a pre-AI incident management system: automated alerts arrive,
and a human asks Claude what is going on.

## Goal

An agentic layer between the raw alerts and human intervention. The impossible
goal is that humans spend **zero time** handling alerts or responding to
incidents. The realistic near-term goal is that every page a human does get
arrives with the diagnosis already done and a fix already proposed.

This is paired with a second change outside this document's scope: replacing
the defunct group mentions with a **single rotation covering the whole product
eng team**, whose job is to support BugBoss rather than to investigate alerts.

## Terms

**Incident.** Any active user-impacting problem in the deployed system, even
one affecting a single user. The system is deviating from our expectations and
causing wrong behavior for someone. By definition every incident needs a
response.

**Signal.** Anything telling us something is wrong. In a perfect world every
signal indicates an incident. Signals are not one-to-one with incidents. Two
sources at launch, Grafana alerts and **reports from employees**; Sentry issues
and others later.

## Non-goals

- **Grafana Assistant.** It ships alert-triggered agentic investigation
  already, with dedup, a 6-hour continuation window and rate limits. It is
  read-only, and remediation is the point of this project.
- **Regrouping alerts in Grafana.** The available label axes are product
  ownership (`[Win]`, `[Serve]`), not failure domain. Grouping on the wrong
  axis is worse than not grouping.
- **Inventing an on-call rotation inside this system.** Escalation targets
  whatever rotation exists.
- **Merging anything.** Merge is the one human gate and it stays human.
- **A weekly analyst pass over incident history.** Descoped for v1.

---

# Layer 1: Data model and storage

Two tables in SQLite, plus S3 for anything bulky.

```sql
incident (
  id TEXT PRIMARY KEY, status TEXT, owner TEXT, slackThreadTs TEXT,
  rootCause TEXT, prUrls TEXT, postmortem TEXT,
  usersImpacted INTEGER, impactQuery TEXT,
  firstBadEventAt, firstSignalAt, fixingAt, resolvedAt, closedAt,
  mergedInto TEXT, recurrenceOf TEXT, sessionRef TEXT, attempts INTEGER,
  modelId TEXT, costUsd REAL,
  tokensIn INTEGER, tokensOut INTEGER, cacheRead INTEGER, cacheWrite INTEGER
)

signal (
  id TEXT PRIMARY KEY, source TEXT, sourceId TEXT, kind TEXT,
  title TEXT, body TEXT, labels TEXT, reportedBy TEXT,
  openedAt, closedAt,
  incidentId TEXT REFERENCES incident(id),
  explained INTEGER
)
```

### Status

```
INVESTIGATING → FIXING → RESOLVED → CLOSED
      ↑           ↓
      └───────────┘        (cause was wrong)

INVESTIGATING or FIXING → MERGED
```

**`RESOLVED` means no users will be impacted any more and no further alerts
should occur**, confirmed by evidence rather than asserted. That is a high
bar on purpose: it is what makes a post-resolution signal meaningful instead
of ambiguous.

`CLOSED` means the post-mortem exists and the metrics are populated.
Separating the two makes the analysis a required step rather than an optional
one.

Everything else is an orthogonal field, because it varies independently of
where the work is:

| Field | Values | Note |
| --- | --- | --- |
| `status` | `INVESTIGATING` `FIXING` `RESOLVED` `CLOSED` `MERGED` | Where the work is |
| `owner` | `agent` or `human` | Set on hand-off; a human can own something mid-`FIXING` |
| `mergedInto` | incident id or null | Set when correlation absorbs this one |
| `recurrenceOf` | incident id or null | Set when this reopens ground a resolved incident claimed |

A pull request is **not** a phase. Resolving may take zero PRs or four, plus
migrations and config changes. The status enum tracks whether we know the
cause, not what artifact is in flight.

### Why SQLite rather than JSON objects

The control plane's own access patterns are trivial, get-by-id and list-open,
and a map in memory would serve them. **The queries that justify a database
come from the agents.** The Slack agent and the MCP server give people an
open-ended question box, and "how many incidents last month had this root
cause", "what is our median time to resolve for Serve incidents", "which
alert slugs have never produced a real incident" are all natural asks. A
fixed set of query functions is a much worse tool surface for an agent than
SQL.

It also buys transactional writes. A merge touches two incidents, and with
one JSON object per incident a crash between the two writes leaves one side
claiming a merge the other does not know about. A transaction removes that
case rather than working around it.

Signals get their own table because joins are free once there is SQL, and
questions like "how many signals attached to incidents that turned out to be
one cause" are the point.

### Durability: every committed write is in S3 before it returns

Every write goes through one helper. Nothing touches the database directly.

```
withWrite(fn):
    acquire the write lock            one writer at a time, always
    fn()                              inside a transaction
    commit
    VACUUM INTO '/tmp/snapshot.db'    consistent snapshot of a live DB
    PUT s3://bugboss-{env}/state/db
    release
    return
```

Two properties, both from the same place. **Writes are serialized**, so two
concurrent handlers cannot clobber each other even though they share a
process. And **the write does not return until S3 has it**, so when an
agent's `report_root_cause` returns, the transition is durable and there is no
window where the process believes something S3 does not.

Affordable because writes are not a hot path: a handful a minute, 200-500ms
each on a database of a few megabytes. At roughly 20 incidents a week the file
stays in single-digit megabytes for years.

**A failed PUT must not be silent.** Retry, and if it keeps failing, stop
accepting writes and alert. A process that keeps committing locally while S3
falls behind is worse than one that halts, because the divergence stays
invisible until a restart loses it.

On boot the container fetches the object and opens it, creating the schema if
absent.

### Who can query it

Read-only SQL goes to the **control plane's own agents**, not to incident
agents:

- **Triage**, so it can ask arbitrary questions while deciding attach, open or
  suppress.
- **The Slack agent and the MCP server**, so a person can ask "what have been
  the most impactful incidents in the last 90 days" without anyone having
  written that query in advance.

Incident agents get the five typed tools and nothing else. If they later need
history, `search_past_incidents` is a typed tool over the same data rather
than raw SQL.

Queries run on a connection opened read-only. Every state change has a typed
tool, so writes stay on those until there is a concrete reason otherwise.

### What stays in S3

```
s3://bugboss-{env}/state/db                              the snapshot
s3://bugboss-{env}/sessions/incident/<incidentId>/
s3://bugboss-{env}/sessions/slack/<channel>/<threadTs>/
s3://bugboss-{env}/evidence/<incidentId>/<evidenceId>.json
```

Post-mortems are markdown on the incident row, since they are small and people
will want to query across them.

### Session persistence

Two requirements that look like one:

- **Resumability.** A fresh container continues a dead agent's work. Needs
  durable writes and a single read at startup. Latency is irrelevant.
- **Shared near-realtime read.** The Boss derives cost from a session and
  answers "what is this agent doing" from it. Needs seconds, not
  milliseconds, and mostly needs recent activity rather than full history.

Treating these as one requirement leads to hunting for a shared, live-updating
filesystem. They are not one requirement, and the split removes the need for
one:

```
local disk    the harness writes its session normally, at full speed
   |  per turn
   v
S3            whole-file PUT from a wrapper
   ^
   |  at container start
restore       entrypoint fetches the object, then launches the harness
              pointed at the restored path
```

No mount, no NFS, no VPC, no shared filesystem. Four reasons it holds:

- **Whole-file PUT is cheap and simple.** Sessions run from hundreds of KB to
  a few MB, so fifty turns is fifty PUTs. It also sidesteps mid-session file
  rewrites entirely, because nothing ever tries to append to an object.
- **"Transparent to the agent" means the model calls no tool.** A harness hook
  or a container-level wrapper is invisible to it.
- **S3 read latency is fine for the real use case.** A person asks what an
  agent is doing; the Boss does a GET; that is about 100ms.
- **Restore is an entrypoint script, not a harness feature.** Fetch the object,
  write it to local disk, start the process. Nothing is required of the
  harness beyond being able to open a session from a path.

Worst case on a SIGKILL is losing the turn in progress.

The same pattern serves the Slack agent, keyed by `<channel>/<threadTs>` and
expired after 7 days idle rather than living as long as an incident.

Agent tasks need ephemeral local scratch for the live file and the omni
checkout. Nothing durable lives there.

---

# Layer 2: The Boss

One long-running control plane. It routes, records, enforces and relays. It
does **not** investigate, form hypotheses, decide root cause, or write fixes.
That boundary matters, because every future feature request will want to put
intelligence here and that is how it becomes the bottleneck during a burst.

## Job 1: Ingest signals

One adapter per source, each implementing four functions: verify and parse,
compute the dedup key, pre-fetch evidence, detect resolution. Two adapters at
launch.

### Human reports

An employee reports a signal the same way they do anything else: `@bugboss` in
Slack, or a `report_signal` tool over MCP. Both produce
`source: "human"`, `kind: "bug_report"`, with the reporter recorded.

Four things differ from an alert, and they are the reason this needs its own
adapter rather than a flag:

- **No evidence to pre-fetch.** The reporter's description *is* the evidence,
  and the agent gathers the rest.
- **No auto-resolution.** An alert resolves when it stops firing. A human
  report resolves when the agent verifies the reported behavior is fixed, or
  the reporter confirms it. This is the `resolutionPolicy` distinction the
  signal model exists for.
- **Never suppressed.** `KnownCause` suppression is alert-specific. If a person
  took the trouble to report something, it gets an agent at minimum.
- **There is a stakeholder.** Alerts have no reporter; reports do. They are
  added to the incident thread and told when it resolves.

The high-value case is attachment rather than creation. Someone reports "Pro
upgrades look broken" while an agent is already three minutes into exactly that
incident, and triage attaches it. The reporter gets the thread and the work in
progress instead of starting a parallel investigation.

**There is no priority and no queue.** Every incident gets an agent
immediately, in parallel. Real-world severity is `usersImpacted`, which is
measured during the incident rather than guessed at ingest.

A ceiling of **15 concurrent incident agents** exists as a circuit breaker,
not a scheduler. Hitting it means something has gone wrong, so the Boss stops
dispatching and says so rather than queueing. Live-tunable in SSM, like the
existing agent concurrency cap.

For Grafana specifically:

- HMAC-verify `X-Grafana-Alerting-Signature`, plus basic auth. Fail closed if
  the secret is absent.
- Dedup on `(grafana, fingerprint)`.
- **Pre-fetch evidence deterministically** by running the alert's own
  `known_causes` LogQL queries. These already exist as annotations on our
  rules (`packages/gp-api/deploy/components/alerting/alerts.types.ts`), and
  `alert_filter` already knows how to run them with caps (6 queries, 50 lines,
  2KB per line). This is where triage quality comes from, and it costs no agent
  turns.
- Set the contact point's **resolve messages on** and `Max Alerts` uncapped, so
  bursts arrive whole and resolution is observable. The existing
  `gpbot-alert-filter` contact point has `disableResolveMessage: true`, which
  would hide resolution.

## Job 2: Triage

A bounded agentic run, in-process, one per inbound batch, concurrent across
batches. Not an investigator; it never loops on evidence. Target under 60
seconds.

**Input is mostly static:** the signal, the pre-fetched known-cause evidence,
and a digest of every open incident. It also has **read-only SQL** over the
incident database, for the cases where the digest is not enough: has this
alert slug produced a real incident before, how did the last one resolve, is
how did the last one resolve.

**Output** is one of `attach(incidentId)`, `new_incident(reason)`, or
`suppress(knownCauseId)`.

**It is advisory.** The Boss applies the decision through `assign`. On timeout,
error or invalid output the fallback is `new_incident`, which is the
conservative direction. A broken triage agent degrades to opening too many
incidents, not to chaos.

**Triage stays conservative on purpose.** Association usually requires
evidence, so triage attaches only on a confident match. The asymmetry justifies
the bias: a wrong split wastes duplicated tokens and is recoverable; a wrong
merge produces a **silent miss** where one agent chases two causes, finds one,
and the other has nobody on it.

**Attach across `FIXING`, never across `RESOLVED`.** While a fix awaits
review the alert keeps firing, so triage attaches those signals to the open
incident rather than spawning a new one every few minutes.

A signal that fires *after* an incident resolved is a different matter and
gets its own incident. Given what `RESOLVED` means, a new signal is evidence
the resolution was wrong, and collapsing it into the old incident would hide
exactly the thing worth seeing. The new incident carries a `recurrenceOf`
pointer, so its agent starts knowing we thought this was fixed.

## Job 2b: Correlate on root cause

Incident agents do not know about each other, so they cannot notice that two
incidents share a cause. **The Boss owns correlation, because it is the only
thing that sees every incident.**

The trigger is `report_root_cause`. When any agent reports one, the Boss runs a
comparison pass: does this root cause explain any other open incident? Same
machinery as triage, different question. Confident matches are merged and the
losing agent receives a `merged` directive and exits.

The same call carries `explainedSignalIds`. Anything attached to the incident
that the root cause does **not** explain is split back out into its own
incident, which then gets its own agent. That is invariant 1, enforced at the
one moment the system actually knows enough to enforce it.

So correlation happens exactly twice: cheaply and conservatively at ingest, and
properly the first time anyone understands the problem.

## Job 3: Dispatch

Agents run **in the same process**, not as separate ECS tasks. The dispatcher
is a 30-second tick asking one question: does every incident that should have
an agent have a live one?

```
every 30s, for each incident where status in (INVESTIGATING, FIXING)
                                and owner = agent:

    no live agent for this incident  -> start one
    otherwise                        -> nothing
```

That is the whole thing. Because both sides of the comparison are in memory,
there is no consistency problem to design around: no task ARNs, no
`clientToken`, no `ListTasks` that cannot see a finished task, no orphan
sweep, no expectations counter, no lease.

A deploy kills every agent at once, and that is acceptable by construction.
Each loses at most its turn in progress, the sessions are in S3 as of the last
completed turn, and the next tick after boot restarts all of them.

One cost to plan for: fifteen agents resuming simultaneously each pay a
cold-cache re-read of their full history. Deploys are therefore not free, and
deploying during a burst is worth avoiding.

**Deploy configuration matters here.** ECS must stop the old task before
starting the new one (`minimumHealthyPercent: 0`, `maximumPercent: 100`).
Overlapping tasks would put two processes on the same sessions and the same
S3 objects, which is the one invariant this design depends on.

## Job 4: Serve the agent tool API

The agent's only path to state. Small enough that tool selection stays
reliable.

| Tool | Effect |
| --- | --- |
| `report_root_cause(cause, explainedSignalIds[], impact)` | `INVESTIGATING` → `FIXING`. Triggers the Boss's correlation pass and the split of unexplained signals. |
| `report_impact(usersImpacted, query)` | Updates impact at any time, callable repeatedly. Impact grows during an incident, and a human deciding whether to step in needs the current number rather than the final one. The Boss posts changes to the thread. |
| `report_resolved(prUrls[], evidence)` | `FIXING` → `RESOLVED`. Evidence is what the agent observed stop happening. |
| `report_analysis(postmortem, usersImpacted, impactQuery)` | `RESOLVED` → `CLOSED`. Terminal; the agent exits after this. |
| `hand_off(reason, brief)` | Terminal. Sets `owner: human`, posts the brief to the thread, and exits. Called either because the agent gave up or because a human claimed the incident. |
| `get_incident()` | Rehydration after resume, plus any directives. |

Five tools, four of which are state transitions. Asking a human is **not** one
of them; it is a tool in the agent's own harness (Layer 3), because it involves
Slack and not the Boss. **There is no
`record_hypothesis` and no progress reporting.** Hypotheses, evidence and
intermediate reasoning live in the agent's session and, where a human should
see them, in the Slack thread the agent posts to directly. The Boss only needs
to know when something crosses a boundary.

Every response carries a `directives` array. This is how an agent learns that
a human took over or that its incident was merged away, as a side effect of
work it was already doing. No push channel is needed and an agent never has to
be addressable.

```
→ report_root_cause({ cause, explainedSignalIds })
← { ok: true, directives: [ { type: "merged", into: 42 } ] }
```

Agents never talk to each other. Correlation is the Boss's job, and the losing
agent in a merge learns about it through a directive on its next call.

## Job 5: Relay Slack

The Boss posts incident **status transitions** to the thread: opened, merged,
escalated, resolved. The agent posts its own work directly, so hypotheses,
questions and PR links do not pass through here.

Inbound, the Boss receives Slack events, classifies them, and acts:

- A reply to an agent's question → write it where the agent's `get_incident`
  poll will find it.
- A takeover claim → the agent sees it on its next poll and hands off.
- An `@bugboss` mention → spawn the Slack agent (Job 6).

## Job 6: The Slack agent

An `@bugboss` mention spawns a short, bounded agent run, in-process. It is the
**fallback and cross-incident** interface, not the primary conversational
surface: inside a live incident thread people talk to the incident agent
directly (see Layer 4). This one handles channel-level questions and threads
where no agent is running.

Its tools:

- Read any incident, **run read-only SQL** against the incident database,
  and **read any agent's session**, live or archived.

**V1 is read-only.** The write actions (merge, split, close, stop, restart,
take ownership) are deliberately out of the first build. What the Slack agent
uniquely gives you on day one is "what is open right now" and "what did the
agent on 42 rule out", which is how the system gets supervised in its first
week. Ownership still changes the way it already does, by replying in the
incident thread.

This keeps the Boss a deterministic service. The conversational part is just
another consumer of its API that happens to reason.

### It persists per thread

The Slack agent is not re-instantiated from scratch on every mention. Delegate's
pattern is to re-read the visible Slack thread and feed it back as context,
which loses the agent's own reasoning and tool results. Here the agent keeps a
real session, so it remembers what it already looked up and what it concluded.

This is the same mechanism as the incident agent, keyed differently:

```
s3://bugboss-{env}/sessions/incident/<incidentId>/
s3://bugboss-{env}/sessions/slack/<channel>/<threadTs>/   expires after 7d idle
```

The key is the **thread**, not the incident, because not every thread is an
incident thread; someone may mention `@bugboss` anywhere to ask a question.

**On resume it does both things.** It loads its own session for its reasoning
and tool results, then fetches the thread messages that arrived since the last
one it saw, which covers human chatter and anything the incident agent posted
while it was away. Session for its own head, thread fetch for the world.

Two constraints carry over from Layer 3:

- **Prefix binding applies identically.** The Slack agent's `system` prompt and
  `tools` array must be serialized into its session and replayed verbatim.
- **Compaction** applies identically, and is likewise the harness's job.

One new constraint: **serialize per thread.** Two mentions in the same thread
arriving together would have two runs resuming and appending to one session,
corrupting it. A short conditional-write lock keyed by `threadTs` is enough;
the second mention either waits or replies that it is still working on the
previous question.

**Authorization is flat.** Anyone in the workspace can ask the Boss to close an
incident or stop an agent. For a small eng team that is an acceptable starting
point, but it is a choice, not an oversight: every action logs the Slack user
id, and destructive actions should be gated on a Slack user group before this
grows.

## What the Boss never does

Nothing auto-closes. An incident closes when an agent calls `finish` or a human
closes it. A signal going quiet on its own is **evidence the agent uses**,
never a transition the Boss makes.

**Every incident terminates in a human-visible outcome**: a fix shipped, an
alert rule changed, or a merge into another incident. If an alert fired and
nothing was wrong, the alert is the bug and changing it is the deliverable. The
system must not tolerate false-positive alerts.

---

# Layer 3: The incident agent

One agent per incident. Its job is to resolve the incident, not to produce a
pull request. It investigates, writes the fix, gets it reviewed, waits for a
human to merge, watches the deploy, confirms the problem stopped, writes the
post-mortem, and only then exits.

Launched from an image with omni already checked out, because investigation
needs to read code as much as patching needs to write it.

## Harness: Pi

`@earendil-works/pi-coding-agent` (the `@mariozechner/*` packages are
deprecated). MIT, TypeScript.

Chosen over the Claude Agent SDK for one reason that outweighed the rest: **it
is not Anthropic-only.** 41 providers across 10 wire dialects, with Bedrock
non-Claude genuinely supported rather than a Claude wrapper, and Ollama, vLLM
and SGLang first-class and actually tested. The SDK ships more of what we need
today; Pi keeps the door open.

### What Pi gives us

- **Sessions as JSONL, appended synchronously** per entry, so a crashed
  process leaves a usable file. One edge: nothing is written until the first
  assistant message, so a run that dies during the first model call leaves no
  file.
- **Per-turn usage with cost already computed.** `usage` is required on every
  assistant message and carries `input`, `output`, `cacheRead`, `cacheWrite`,
  `cacheWrite1h`, `totalTokens` and a `cost` breakdown including the Anthropic
  2x rule for 1-hour cache writes. `provider`, `model` and `api` are on every
  message. This is what makes deriving cost from the session work.
- **Adaptive thinking**, with a model gate that matches Opus 5 and Sonnet 5.
- **Bedrock via the AWS default credential chain**, so the task role works
  with no static credentials.
- **Compaction**, and `--session-dir` for relocatable storage.
- **`turn_end`, `message_end` and `tool_execution_end`** as public extension
  points.

### What we build

| Gap | Work |
| --- | --- |
| Bedrock is ConverseStream-only | An InvokeModel provider registered under a **new** api id, `bedrock-invoke-model`. **No fork.** Overriding `bedrock-converse-stream` does not work: `provider-composer.js:339` prefers the builtin's `stream()` whenever the builtin declares any model with that id, so the registry override is bypassed for stock catalog models. A new id is also correct on its merits, since the native Anthropic body is invalid for the 165 non-Claude Bedrock models under the old id. |
| Subagents are an example, not a built-in | Adopt the ~1,200 LOC example extension. Two fixes it needs: give children their own session directory instead of `--no-session`, and set `usage` on the returned tool result so child cost rolls up. The mechanism for both exists; the example just does not use it. |
| Session sync to S3 | The wrapper described in Layer 1. Roughly 100 lines off `turn_end`. |
| No reasoning-token split on Bedrock | Possibly a non-issue. Converse does not deliver it, but the native body may populate `output_tokens_details.thinking_tokens`. Wired; confirm on the first live call. |
| Pricing from a gitignored hydrated catalog | Resolved: the catalog **does** ship in the published package at `dist/providers/data/amazon-bedrock.json`, gitignored in Pi's repo but copied in at publish, with real rates for Opus 5 and Sonnet 5. Explicit rates are needed only for an *application* inference profile ARN, whose opaque suffix has no catalog entry. |

Roughly a week of work, against permanent Anthropic lock-in. The harness sits
behind our tool API, so the decision stays reversible at the cost of a
container image.

### Why InvokeModel is not optional

Pi's Converse path drops a thinking block whose text is empty, signature and
all:

```ts
// bedrock-converse-stream.ts:1022
const thinking = sanitizeSurrogates(c.thinking);
if (thinking.trim().length === 0) continue;
```

That is exactly the Opus 5 and Sonnet 5 shape, where `reasoningText.text`
comes back empty while the signature travels. On that path signature
continuity is lost across turns, which breaks the thing the resume design
rests on. Reproduce it before building, but it is a concrete code path.

Converse also has a schema seam InvokeModel avoids: `reasoningText.text` is
marked Required but arrives empty. InvokeModel passes the native Anthropic
body straight through, giving one serialization format across providers.

### Session storage is not a harness concern

See *Session persistence* in Layer 1. Sessions go to S3 through a wrapper
around the harness, so Pi's CLI hardcoding local `fs` is a hundred lines
rather than a blocker.

**One guarantee nothing below us provides:** no store arbitrates a single
writer per session. Pi's own docs are explicit that there is no cross-process
lease, lock, fence or takeover, and that the host lifecycle must guarantee one
writable owner. In a single container that is a process-level check before
starting an agent for an incident that already has one.

### Subagents

Used for parallel investigation across independent data domains: logs, traces
and metrics, recent deploys. Split by data source, never by workflow stage,
since splitting investigate from fix loses more to handoff than it gains.

Bound query cost rather than turns. Fan-out multiplies Loki reads, which is
the line item that already bit us once.

## What it can reach

Six Boss tools (Job 4) are the state interface. Everything else is how it
actually works.

| Surface | Access | Notes |
| --- | --- | --- |
| **Grafana MCP** | Loki, Tempo, Prometheus, read | The primary investigation tool. Needs `GRAFANA_SERVICE_ACCOUNT_TOKEN`, which the autopilot task definition notably does **not** inject today. |
| **Sentry MCP** | Read | Frontend errors, the one surface Loki cannot see |
| **AWS** | Read-only: ECS task state, CloudWatch logs, RDS and ALB metrics | No writes. Not the deploy role. |
| **The omni checkout** | `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep` | A shared read-only tree baked into the image while investigating; a private writable worktree once fixing |
| **git / `gh`** | Branch, push, open and update PRs, read review state | Cannot merge; the ruleset blocks it |
| **Slack** | `chat.postMessage` into its own thread | Write only. It never reads Slack. |
| **Bedrock** | Its own model calls | Via the task role |

Deliberately withheld: any AWS write, anything that reaches the release path,
and Databricks. `WebFetch` on a URL that appeared in a log line is the exact
LogJack shape and should be off; `WebSearch` is fine.

## System prompt and injected context

The agent gets a system prompt describing its role, the contract, and what it
must not do. It also gets **directly injected context about our logging and
alerting**, which already exists in omni and should not be rediscovered on
every incident:

- `docs/observability.md` — datasource UIDs, label reference, the incident
  playbook, and the log-redaction rule.
- `packages/gp-api/docs/observability.md` — how alerts are generated, why route
  alerts are per-controller, the excluded status codes, and Loki query cost.
- `packages/gp-api/deploy/components/alerting/` — the alert definitions
  themselves, including `KnownCause` entries.
- **The `ship-pr` skill.** The agent never hands a human a raw PR. It uses the
  repo's existing skill, which opens the PR to convention, drives
  `delegate-reviewer[bot]` to `Approved.`, and confirms every non-skipped
  check is green at the same HEAD SHA. Only then does it `contact_human` for
  the merge. That is the difference between a five-minute merge and a real
  review.

Because the agent operates in the checkout, questions about our own code answer
themselves. It does not need to be told what a log line contains; it can look.

**One interaction to get right:** prefix binding means the system prompt must be
byte-identical across a resume. So the prompt is composed once at launch and
**stored in the session**, then replayed verbatim. Docs changing between
incidents is fine. Docs changing mid-incident would otherwise invalidate every
thinking block after the change.

## Phases and budget

A cheap first pass with a small turn budget to form an initial hypothesis,
exiting early if it turns out to be a duplicate. Full budget only for incidents
that survive that gate.

**Bounded by a wall-clock timeout, not by a token or dollar cap.** A deadline
is a loose proxy for spend, since cost per minute varies by an order of
magnitude with fan-out, but it is good enough: a typical investigation runs a
couple of dollars, so a 30-minute ceiling caps the pathological case in the
tens of dollars. Cost is derived from sessions, so a bad trend is visible
rather than silent.

The reason to prefer it is that **a timeout is external, so it costs nothing in
harness capability.** Enforcing spend never becomes a reason to pick one agent
runtime over another.

Two layers, because one is not enough:

- **An in-container deadline**, so the agent notices, writes a handoff brief
  and exits cleanly.
- **The parent kills the child process** as the backstop, since an
  in-process deadline cannot fire inside a wedged agent. Same lesson as the
  delegate-cluster zombies, and much cheaper now that it is `SIGKILL` on a
  child rather than an ECS API call.

Hitting the deadline is an escalation, not a silent stop.

## Resume

The session is persisted continuously and a restart replays it. The agent never
checkpoints its own reasoning for its own benefit. Its context **is** its
memory; the database is the index other things read.

**The binding constraint is not time, it is the prefix.** Thinking signatures
do not expire (verified: a 38-day-old block replays fine, and signatures are
portable between the Anthropic API and Bedrock). But from Fable 5.1 and Opus
5.5 onward a thinking block is cryptographically bound to the `system` prompt,
the `tools` array, and every earlier message. Change any of them and that block
and all later ones are rejected.

That is exactly the resume case, because a restarted agent rebuilds its
prompt and tool list. So:

- **The session file carries `system` and `tools` verbatim and resume replays
  them** rather than regenerating. Anything nondeterministic in either one is a
  landmine: a timestamp, a cwd, a git branch, a tool array built from a `Set`,
  an MCP server registering tools in varying order.
- Set `prefix_mismatch_behavior: "drop_block"` and monitor
  `input_transformations`, so drift costs reasoning instead of throwing a 400.
- **Pin the model id in the session file.** Bedrock does not restore it on
  resume because of provider-specific deployment ids.
- Enforcement is account-scoped and default-on for accounts created after
  2026-08-31, so it may not bite today and would bite a new account silently.

**Refresh before continuing.** Resume replays recorded tool results, it does not
re-run them, so the agent wakes with a stale picture. First act after resume is
always to re-read the incident and its directives.

### Compaction

An agent's memory is its whole conversation and we replay all of it on resume,
so a long incident eventually exceeds the context window. We compact.

**Pi does the compacting**, inserting a summary entry into the session tree
with the active branch pointing past it. Because the wrapper only copies the
session file, that state travels with it and the wrapper stays dumb.

**Keep-tail is not an option.** Dropping old turns client-side breaks prefix
binding by construction, since every thinking block is bound to the messages
before it.

**Compact at 95% of the context window.** One threshold, no phase logic.

That leaves little headroom, so the constraint that makes it safe is
**bounded tool results**. The failure mode is not creeping gradually over the
line, it is sitting at 93% when one wide Loki result or large file read
arrives and blows straight through. Our evidence tooling already caps at 50
lines and 2KB per line; every tool the agent has needs a similar ceiling.

The failure mode if we get it wrong is not data loss. The API rejects the
oversized request, the agent dies, the dispatcher relaunches it, the replay
fails identically, and after N attempts it escalates to a human. Survivable,
but it burns a long incident and looks like a crash loop.

**A possible refinement, since we are writing the Bedrock adapter anyway:**
`clear_thinking_20251015` context editing strips reasoning tokens (the bulk of
the growth) while keeping every message, which is finer-grained than
summarizing. It has to be server-side, and whether it can be passed through
our InvokeModel adapter is worth checking while that code is being written.

**Cold cache on resume is guaranteed.** Default cache TTL is 5 minutes, so a
resumed container pays a full re-read of history on its first request. Consider
the 1-hour TTL and price it in.

## Model and provider

**Bedrock, via InvokeModel, not Converse.** Converse reshapes thinking into
`reasoningContent → reasoningText { text, signature }` where `text` is
schema-Required but arrives empty on Opus 5 and Sonnet 5. InvokeModel passes
the native Anthropic body straight through, giving one serialization format
across providers.

**Pi is ESM-only; this repo is CommonJS.** Its `exports` map declares no
`require` condition, so a static import typechecks and then fails at runtime
with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Every runtime value from Pi must come
through a dynamic `import()`; `import type` is free. Load once in an async
initializer and close over it so functions that must stay synchronous can.

**Adaptive thinking, not `budget_tokens`.** Extended thinking with
`budget_tokens` is deprecated on 4.6 and rejected with a 400 on 4.7+. Frontier
models use `thinking: {type: "adaptive"}` plus `output_config.effort`.

**One resolve point.** A single `resolveModel(phase, incident)` function, with
the mapping in SSM so it retunes without a deploy. Per-incident override for
replaying an incident against a different model during evals.

**The multi-model trap:** non-Claude models on Bedrock have no prompt caching.
Since cache reads are the overwhelming majority of our token volume, swapping
to a cheaper non-Claude model can raise the bill. Compare on total cost per
resolved incident, never on per-token list price.

AWS's Bedrock docs still describe the old strip-previous-turns behavior, which
is wrong for Opus 5.5 and Fable 5.1. Trust platform.claude.com over
docs.aws.amazon.com on thinking semantics.

## External access

The agent talks to Slack and GitHub **directly**, with its own scoped tokens,
rather than through the Boss.

**Slack.** Posts questions, hypotheses and PR links into the incident thread
itself.

`contact_human(message)` is one tool in the agent's harness:

```
post the message to the thread         (the agent's own Slack token)
poll get_incident() every 30 seconds   (the Boss, not Slack)
return the first reply newer than it
```

**Not named `ask_human`**, because the agent may be asking a question or
asking someone to *do* something it cannot do itself: run a command, check
Stripe, restart a worker. One mechanism either way, send text and wait, and
the human reads English.

Posting without waiting needs no tool at all. The agent has its own Slack
token and can just post. **`contact_human` is telling *and* waiting.**

Thirty seconds because this is incident response. Total wait can run to 24
hours before the agent proceeds on a stated assumption or hands off.

**The read path goes through the Boss.** The Slack Events handler already
receives every thread reply, so the Boss records them on the incident at no
extra cost and the agent reads from an API we own.
`conversations.replies` is throttled to roughly one request a minute for newer
non-Marketplace apps, and per-agent Socket Mode is not a workaround: Slack
load-balances events across an app's connections rather than broadcasting, so
one agent's answer can arrive on another's socket.

### Blocking tools

Two, and only one of them is specific.

| Tool | Returns when |
| --- | --- |
| `monitor(command, interval, timeout)` | The command exits 0. Returns its output. |
| `contact_human(message)` | A human replies in the thread |

**`monitor` is the general primitive**, deliberately not a set of
`await_pr` / `await_deploy` / `await_signal_quiet` tools. Predicting what an
agent will need to wait for is a losing game, and a shell condition covers
everything:

```
monitor("gh pr view $URL --json state -q .state | grep -qE 'MERGED|CLOSED'")
monitor("gh run list --commit $SHA --json conclusion -q '.[0].conclusion' | grep -q success")
monitor("curl -s $BOSS/incident/$ID/signals-quiet-for/10 | grep -q true")
```

The specific patterns belong in the agent's instructions, not in the tool
surface. That way a new kind of wait is a prompt change, not a deploy.

**The loop is ours, the probe is theirs.** Each invocation of the command is
a short exec with a normal timeout; the waiting happens in our tool. That is
what sidesteps Pi's per-call bash timeout, and it is why this cannot just be
`bash`.

**One turn regardless of duration.** A two-day wait adds one tool call, not
thousands. This is the property that keeps a long incident from saturating
context on polling alone, and it is the reason these are tools rather than a
loop the model drives.

**Time passes while an agent is down.** A deploy is seconds, but a rollback or
a deliberate pause can be an hour, and the world moves: PRs merge, alerts
stop, a human fixes something by hand. So a resumed agent's first directive
carries how long it was gone, and when that is material the instruction reads
*"X has passed, re-check quickly, then continue."* **The agent does this, not
the Boss**, because it already knows what it was in the middle of and what is
worth re-checking. The Boss knows neither.

**The command must be a read-only check.** On a container restart the session
holds a tool call with no result, so the tool runs again. A check re-runs
harmlessly; an action would be performed twice. `monitor("gh pr merge ...")`
is a bug, and the instructions should say so.

`contact_human` is `monitor` underneath, but stays its own tool because
posting and waiting must be atomic to be re-entrant: it records its message
timestamp on the incident *before* posting, so a resumed agent resumes waiting
on that message instead of asking the human twice.

Plain-text replies, not Block Kit buttons. Button clicks are deliverable only
by webhook and cannot be polled at all.

**GitHub.** Opens and updates pull requests, and polls for review and merge
state. No webhooks needed.

## PR yes, merge never

A GitHub App installation scoped to omni alone, with `contents: write` and
`pull_requests: write`.

**Permissions do not separate opening from merging**, because the merge
endpoint needs the same scopes as pushing a branch. The block is a **ruleset on
`main`**: require a pull request, require one approving review, and leave the
App out of the push allowlist. Merging pushes to `main`, so the push
restriction stops it server-side.

That distinction matters for the threat model. The agent reads
attacker-writable log lines, so the guarantee has to survive its token leaking.
A ruleset does; a scope would not.

## Prompt injection

Telemetry is attacker-writable by construction. Log lines contain user input;
error payloads echo the input that caused them.

- The LogJack study measured Azure Prompt Shield catching 1 of 32 log-embedded
  payloads and GCP Model Armor catching 0, despite both catching the same
  payloads in isolation. **Do not rely on a guardrail product.**
- The Clinejection supply-chain attack began in an AI triage agent whose
  GitHub issue title was interpolated into its prompt, with overpermissioned
  tools and a shared Actions cache reaching a higher-privilege release
  workflow.

Consequences: treat the whole signal payload and all telemetry as data, never
as instructions. Keep the write toolset small and enumerated. The agent's
credentials must not reach anything the release path uses.

---

# Layer 4: The human interface

Two surfaces: Slack, and an MCP server so engineers can query BugBoss from
their own Claude Code session. No dashboard in v1.

**One thread per incident.** The Boss opens it and posts lifecycle transitions;
the agent posts its own work into it. Scrolling the thread is the whole story,
chronologically. That is the transparency mechanism and it needs no separate
build.

## Who you are talking to

A thread is a room people talk in, and most of what is said in it is not for
the agent. The rule that falls out of that is simple:

**An agent reads its thread only while it is waiting for an answer it asked
for.** The rest of the time it is not listening, so people can discuss an
incident freely without waking anything or burning tokens. That is a property
of `ask_human` (Layer 3) rather than a routing policy anyone has to maintain.

**To interrupt an agent mid-work, mention `@bugboss`.** The Boss's Slack
handler turns that into a directive, which the agent picks up on its next
`get_incident()`. This is the directive channel that already exists; it needs
no new mechanism.

| Where you are | Who answers | Tag |
| --- | --- | --- |
| Incident thread, agent waiting on your answer | The incident agent, directly | No |
| Incident thread, agent working | The incident agent, via a directive | Yes |
| Incident thread, no agent running | The Slack agent | Yes |
| A channel, not a thread | The Slack agent | Yes |

The incident agent is your conversational partner for its own incident, which
is right because it holds the full context. The Slack agent is the fallback and
the cross-incident interface, not the primary surface.

## What the rotation owes

One rotation across the whole product eng team. The person on it is **not** a
first responder and does **not** watch alerts. Their job is to unblock BugBoss.

**In scope**

| Duty | Target |
| --- | --- |
| Review and merge PRs BugBoss opens | Within 1 working hour |
| Answer a question an agent asks in a thread | Within 1 working hour |
| Accept or decline an escalation | Within 2 working hours |
| Close incidents you took over | Before your shift ends |

**Explicitly out of scope**

- Watching `#dev-alerts`.
- Triaging or investigating an alert that has not been escalated to you.
- Anything outside working hours, with one exception: a signal on the
  prod-critical allowlist pages immediately, and that path is unchanged from
  today.

**Shift length and the allowlist contents are team decisions**, not design
decisions. This document assumes they exist.

**When nobody answers.** An agent waits up to 24 hours for a question, then
escalates. Escalated-and-unclaimed incidents accumulate as visible debt, so the
Boss posts a daily digest of them. Nothing auto-closes, ever.

## The merge gate is the one thing that must not be rubber-stamped

Merging is the only action in this system that a human alone can take, which
makes it the only place human judgment is load-bearing. Bainbridge's ironies
apply directly: if the reviewer degrades into clicking approve, the system has
a gate in name only and nobody notices until a bad fix ships.

Before merging, check four things:

1. Does the root cause analysis actually explain the signals attached to the
   incident?
2. Does the diff match the stated cause, or does it do more?
3. Is the blast radius what the analysis implies?
4. Is there a test that would have caught this?

A no on any of them is a request-for-changes, not a merge. The agent reads the
review and iterates.

## Every action a human can take

| Action | Where | Example |
| --- | --- | --- |
| **Merge a PR** | GitHub | The agent traced Pro upgrades failing to a bad update condition, and shipped a fix plus a backfill migration. The RCA matches the diff; merge. |
| **Request changes** | GitHub | The fix patches the symptom in the controller instead of the service. Comment; the agent revises. |
| **Answer a question** | Slack thread | "Is it expected that org X bypasses the Stripe webhook?" Reply in thread; the agent picks it up within 30 seconds. |
| **Take over** | Slack thread | An agent escalated because the fix touches auth. Reply `mine`. Ownership flips, the agent writes down what it ruled out and exits. |
| **Hand back** | Slack thread | You confirmed the approach is safe. Reply `back to you`; the dispatcher starts a fresh agent from the existing session. |
| **Close an incident** | `@bugboss` | You hotfixed it by hand. `@bugboss close 42, fixed manually in #1531`. Requires a reason; it goes in the post-mortem. |
| **Merge incidents** | `@bugboss` | You can see 47 and 42 are one pool exhaustion and the Boss has not connected them. `@bugboss merge 47 into 42`. |
| **Split an incident** | `@bugboss` | Incident 42 has a signal that has nothing to do with its root cause. `@bugboss split signal <id> out of 42`. |
| **Stop an agent** | `@bugboss` | It is looping on a hypothesis you know is wrong, or burning budget. `@bugboss stop 42`. The incident stays open and unowned. |
| **Restart an agent** | `@bugboss` | You cleared whatever blocked it. `@bugboss restart 42`. |
| **Ask anything** | `@bugboss` | `what is open right now?` · `what has the agent on 42 ruled out?` · `what did we spend on incidents this week?` |
| **Query from your own session** | MCP | The same reads and actions from Claude Code, authenticated as you. Useful when you are already in the code rather than in Slack. |
| **Report a signal** | `@bugboss` or MCP | `@bugboss pro upgrades look broken for org acme, user says they paid but has no access`. Triage attaches it to an open incident or opens a new one; either way you get the thread. |

Two things that look like actions but are not:

- **Suppressing a class of alert** is a code change. It adds a `KnownCause` to
  `packages/gp-api/deploy/components/alerting/`, goes through review, and
  deploys. Deliberately not an in-chat action, because silencing an alert
  should be as reviewable as changing one.
- **Changing an alert rule** is the same, and is often the correct outcome of
  an incident where nothing was actually broken.

Every action logs the Slack user id. Merge, close, stop and split are recorded
on the incident and appear in its post-mortem's "humans involved" section.

## Escalation

**Escalation and takeover are the same thing**, and they use the same tool.
`hand_off` is terminal: it sets `owner: human`, posts a handoff brief to the
thread, and the agent exits. The dispatcher's desired-state query excludes
human-owned incidents, so nothing relaunches.

The trigger differs, the mechanism does not. The agent calls it because it gave
up, or because it saw a human claim the incident on its poll.

### The handoff brief

Whatever the trigger, the agent's last act is to post a structured brief, so a
person picking this up gets the state of the investigation rather than a
scrollback:

```
What I believe now      current best understanding, with confidence
What I ruled out        each one, and the evidence that killed it
What I was about to do  the next step, so you can continue or discard it
Side effects            PRs opened, migrations run, commands with consequences
Full transcript         a key, for when the brief is not enough
```

The brief is the default because a transcript is not a handoff. If you want
more, ask `@bugboss` in the thread and the Slack agent reads the session for
you.

The incident stays open until a person closes it. Nothing auto-closes, so an
escalated incident nobody picks up is visible debt rather than a silent drop.

**"I don't know" is not a terminal state.** Before handing off, an agent that
cannot find a cause must propose one of two concrete things: a change to the
alert rule itself, shipped as a PR, or a named piece of missing
instrumentation. An alert that fired with nothing behind it means the alert is
the bug, and saying so with a diff turns a dead end into alert-hygiene work
rather than human backlog.

Escalates when:

- The wall-clock deadline expires without a root cause. If the agent did not
  hand off first, the dispatcher escalates on its behalf.
- A root cause is reached but confidence is low.
- The agent asked a question and got no answer inside its wait budget.

### When a human gets pinged

A thread opens for every incident and the Boss posts into it from minute one,
so anyone curious can watch. **The `@` mention is reserved**, because at
roughly 20 incidents a week, pinging the rotation for things that resolve
themselves is how a rotation gets muted.

Three things earn a mention: an escalation, a signal on the prod-critical
allowlist, and a PR that needs merging.

This is a deliberate departure from the original story, where the on-call
engineer is notified at incident open before anything is known.

**Notification is a separate thing and does not change state.** A signal on
the prod-critical allowlist makes the Boss ping the channel while the agent
keeps working. Conflating the two was a mistake in earlier drafts:
one means "a human should look", the other means "a human now owns this".

A human can hand back by replying in the thread, which flips `owner` to `agent`
and lets the dispatcher start a fresh agent from the existing session.

## The post-mortem

`report_analysis` is the agent's last act and it is mandatory. The post-mortem
is markdown against a fixed template, stored as a string field on the incident
record:

```
# <incident title>

## Summary
## Timeline              (detection → root cause → fix → verification)
## Humans involved       (who, and what they did)
## Impact                (users affected, duration, surface)
## Root cause analysis
### Five whys
## Prevention            (concrete, actionable, owned)
```

The same call populates the metrics that cannot be computed from timestamps:
`usersImpacted` and the `impactQuery` that produced it. The Boss derives
everything else it owns (`timeToDetect`, `timeToResolve`, cost) rather than
trusting a reported number.

A post-mortem that says "prevention: be more careful" is a failed post-mortem.
The prevention section should name a change: a test, an alert threshold, a type,
a guard. Whether those become tickets automatically is deliberately out of scope
for v1.

## Measurement

| Metric | Computed from | Caveat |
| --- | --- | --- |
| Impact | `usersImpacted`, reported by the agent at `report_analysis` with the `impactQuery` that produced it | The query is stored so the number is checkable. Distinct users only if the log line carries an identifier that survives `redactLine`. |
| Time to detect | `signal.openedAt − firstBadEventAt` | Measures our alerting, not our agents. Rules with a 10m window and `for: 1m` have a structural floor of several minutes. |
| Time to resolve | `resolvedAt − firstSignalAt` | Heavily right-skewed and uncorrelated with severity. Report percentiles, never a mean. |
| Cost and model | The Boss sums per-turn usage out of the session file and prices it from a `(provider, modelId)` table | Derived, never reported. Survives a killed process, because the session file is on disk either way. |
| Outcome | `auto_resolved`, `human_assisted`, `human_owned`, `unresolved` | `auto_resolved` must mean no human input beyond the merge, or the metric flatters itself. |

Nearly free to add: escalation precision and recall, suppression accuracy,
harm rate, turns per incident.

### The outcomes the project is actually judged on

Per-incident metrics are not the goal. Three numbers are:

| Outcome | Measured as |
| --- | --- |
| **Zero alerts go unaddressed in a week** | Signals that reached no incident and no `KnownCause` suppression |
| **Humans spend under an hour a week on rotation** | Time between a `@` mention and the human action that followed, summed |
| **The rotation exists and works** | The `@` tag resolves to a real person, and escalations reach them |

The first two are computable from the database. Track them weekly from day
one, because they are the reason this exists.

**Calibration.** On ITBench-AA, the only independent benchmark for this task,
frontier models identify root causes correctly in roughly half of cases (best
observed 56.2%). Judge v1 on arriving with the diagnosis done and handing off
cleanly, not on closing everything.

---

# Infrastructure

### Where the code lives: `ops`, alongside Delegate

BugBoss lives in the `ops` repo (`thegoodparty/serve-ops`), in the existing
`deploy/` Pulumi project alongside Delegate.

**The reason is deploy cadence.** omni's release train is deliberately not
path-filtered ("None is path-filtered, so each has a run for THIS SHA"), so
every merge to `main` redeploys every service. `origin/main` took 499 commits
in the last seven days, roughly one every eight minutes during working hours.
Our deploy is stop-then-start, because overlapping containers would put two
processes on the same sessions. So in omni, **every merge would kill every
running incident agent** — a 30-minute investigation interrupted three or four
times, each restart paying a cold-cache re-read of its full history.

`ops` also fits on its own terms: it is the operational tooling repo, Delegate
is already agent infrastructure on ECS and Lambda there, and a prod-only
service sits awkwardly inside omni's dev-then-promote train.

**`ops` does redeploy on every merge**, same as omni: `deploy.yml` has no path
filter, and because the image tag is the commit SHA, even a docs-only merge
produces a new task definition revision (verified against PR #83). The
difference is rate. omni takes ~71 commits a day; `ops` runs 1-2 on a normal
week, with the recent IaC restructure being an outlier. At that rate an
investigation is rarely interrupted, and resume handles it when it is.

Worth revisiting only if `ops` starts moving at omni's pace. The escape hatch
exists and is already the house pattern there (`deploy-org/` and
`deploy-workbench/` are separate path-filtered projects), so it is a change
of address rather than a redesign.

**BugBoss deploys to production only.** There is no dev environment for it.
Note `ops` has no `prod` tag value at all: prod-only here means
`Environment: infra`.

### `Environment: infra` is a protection tag, not a label

This one is easy to get backwards. The `EngineerAccess` SSO permission set
grants every engineer `Action: ["*"]` on anything tagged `Environment: dev`,
and explicitly denies `ssm:GetParameter*` on anything tagged `prod` or
`infra`. So `infra` is what keeps BugBoss **outside** the blanket engineer
mutate grant. Tagging it `dev` would hand every engineer full control of the
incident system.

Two traps. `aws:defaultTags` reaches only the default provider, so a project
with an explicit provider must set tags in code. And default tags **do not
reach resources created at runtime** — Delegate re-applies both by hand when
it calls `RunTask`, with a test asserting it. Anything BugBoss creates while
running needs the same treatment.

### What does not exist in `ops` yet

BugBoss would be the first of several things there, so there is no local
pattern to copy:

- **No `aws.ecs.Service` anywhere.** Delegate is a task definition invoked by
  `RunTask`; it has no service. Ours is the first long-running one.
- **No ALB, no target group, no listener.** The account has 25+ ALBs from
  other repos, so there is precedent in AWS, just not in this repo.
- **No `ephemeralStorage` set anywhere**, so tasks get the Fargate default of
  20 GiB. We need it explicit, sized for SQLite plus per-agent clones.
- **A dedicated security group.** The SG hardcoded in `deploy/index.ts` is the
  VPC default, ingress from `10.0.0.0/16` only. Fine for outbound-only
  agents, wrong for a service behind an ALB.
- **Its own Secrets Manager secret.** `ops` has exactly one, `DELEGATES`, a
  flat JSON object whose every key becomes a container env var. Sharing it
  would hand every Delegate agent BugBoss's credentials and vice versa. Do
  not copy the `getSecretVersion` pattern from `deploy/index.ts` either; it
  reads the live secret value at preview time and is being removed.

### Two IAM grants to confirm before starting

BugBoss uses the existing `github-actions-pulumi-deploy` role, which should
already cover it. Two specific gaps the survey turned up are worth checking
rather than discovering mid-deploy: the role has `acm:DescribeCertificate`
and `acm:ListCertificates` but not `acm:RequestCertificate`, and it has the
eight ECR push/pull actions but not `ecr:CreateRepository`.

Both are resolved without a widening. **A wildcard `*.goodparty.org`
certificate already exists in `us-west-2`**, issued and valid to 2026-12-10,
already fronting three ALBs; looking it up needs only the two ACM actions the
role has. The **`bugboss` ECR repository is created by hand** rather than by
Pulumi.

If a future change does need a widening, `ops` requires it to land **and
finish applying** before the PR that depends on it. Grants and consumers are
applied by different workflows triggered by the same push, with nothing
sequencing them, so a same-PR grant races its own consumer.

### The omni checkout: fresh per agent, no baked image

Nothing is baked in. Each agent clones omni when it starts.

```
agent starts    git clone --filter=blob:none        seconds
                → investigate
enters FIXING   npm ci, in the background           minutes, hidden
                → build, test, open the PR
```

This works because **investigation does not need `node_modules`.** Reading
code is `grep`, `cat`, `git log`, `git show`, all of which run on bare source.
`node_modules` is only needed to build or run tests, which is a `FIXING`
activity, by which point the agent has already spent minutes investigating and
the install cost is hidden.

`--filter=blob:none` rather than `--depth 1`: a partial clone gives complete
history so `git log` can find the suspect commit, with file contents fetched
on demand. A shallow clone is faster and blind to history, which is half of
investigation.

The `npm ci` at the `FIXING` transition composes with `monitor`: start it in
the background, keep drafting, wait for it when the build is actually needed.

**Every agent gets `origin/main` as of the moment it started.** No baked
image, no nightly rebuild, no staleness, and no shared read-only tree to
manage. The measured 4.79 GB working tree only materializes for agents that
reach `FIXING`; investigating agents carry source alone.

## Topology

One container. It receives webhooks, runs triage, holds the incident state,
dispatches and supervises agents in-process, serves MCP, and talks to Slack.

```
Grafana ─┐
Slack   ─┼─▶ ALB ─▶ [ BugBoss, one Fargate task ]
Claude  ─┘                    │
  Code                        ├─ in-memory incident state
  (MCP)                       ├─ triage        (bounded LLM call)
                              ├─ Slack agent   (bounded LLM call)
                              ├─ dispatcher    (30s tick)
                              └─ N incident agents, as child processes
                                        │
                                        ▼
                                  S3  (incidents, sessions, evidence)
```

No DynamoDB, no SQS, no Service Connect, no RunTask, no second compute tier.
One SQLite file on local disk, snapshotted to S3.

### Working trees

Measured against a real omni worktree on 2026-09-24:

| | |
| --- | --- |
| Working tree, total | **4.79 GB** |
| of which `node_modules` | 3.54 GB |
| File count | **348,797** |

Fifteen fully provisioned trees would be 72 GB and 5.2 million files. That
fits inside Fargate's 200 GB ephemeral storage, so capacity was never the
constraint. **Provisioning time was**: `npm ci` across 348k files takes
minutes, and an agent that cannot read code for five minutes is useless
during an incident.

That is why nothing is provisioned up front. Investigating agents clone source
only, which is fast and small. The 4.79 GB figure applies **only to agents
that reach `FIXING`**, and only after they get there. See *The omni checkout*
below.

Memory is not the binding constraint either: roughly a gigabyte per agent
against Fargate's 120 GB ceiling.

Scaling past one container means sharding incidents across several, which
breaks the single-writer property. A known exit, not a surprise.

## The MCP server

Engineers reach BugBoss read-write from their own Claude Code session. It runs
in the same Lambda as everything else, which the current spec makes easy.

### The spec removed the hard part

MCP revision **2026-07-28** deleted protocol sessions, the `initialize`
handshake, the GET SSE endpoint and SSE resumability. Stateless is no longer a
workaround, it is the only legal mode, which makes Lambda the natural host
rather than an awkward one. Claude Code speaks this revision natively.

Build on **`@modelcontextprotocol/server@2.1.0`** (the v2 package; v1 maxes out
at the 2025-11-25 revision). Its `createMcpHandler(factory, { legacy: 'stateless' })`
returns a web-standard `fetch(Request) => Response`, which maps 1:1 onto a
Lambda invocation, and the `legacy` mode serves older clients on the same
endpoint with no session store.

Skip `subscriptions/listen`. A held-open stream bills for the full function
duration even after the client disconnects, and Claude Code degrades
gracefully without it.

### Google cannot be the authorization server

Not because it lacks Dynamic Client Registration (DCR is now deprecated in the
spec anyway, behind pre-registration and Client ID Metadata Documents). The
real blocker is audience: Google has no RFC 8707 support, so it cannot mint a
token bound to our MCP server, and Claude Code sends the **access** token,
which from Google is opaque and carries no `hd`. Accepting it is the
confused-deputy pattern the spec explicitly forbids. Google's own MCP servers
are broken in exactly this way.

Every remote MCP server we already use (Sentry, ClickUp, Amplitude) runs its
own authorization server colocated with the resource server. That is the
pattern to copy.

### The shape

One Lambda, four paths:

```
POST /mcp                                       → createMcpHandler().fetch()
GET  /.well-known/oauth-protected-resource/mcp  → RFC 9728 metadata
GET  /.well-known/oauth-authorization-server    → our AS metadata
     /authorize /callback /token                → the AS leg
```

`/authorize` redirects to Google with our pre-registered client. `/callback`
verifies the ID token and mints our own. `/token` issues an HS256 JWT with
`aud` set to the MCP URL. Since the AS and the resource server are the same
function, one shared secret does it: no JWKS, no KMS.

State is nearly nil. Authorization codes are 60-second signed JWTs binding the
PKCE challenge, redirect URI and resource. The only durable thing worth having
is a short-lived record for code-replay prevention, which is an in-memory map
with a TTL in a single process, and even that is skippable if we accept only
CIMD and pre-registered clients.

Accept **CIMD** (Claude Code publishes a document, so engineers configure
nothing) and pre-registered client ids. Leave DCR off; it is deprecated and
exposes an unauthenticated write endpoint.

### Restricting to our Workspace

Check all three claims on the ID token at `/callback`, and fail closed:

```
hd === "goodparty.org"
  && email_verified === true
  && email.endsWith("@goodparty.org")
```

`email_verified` is not optional. A consumer Google account can carry an
`email` claim nobody verified, and omitting that check is a real bypass, not a
theoretical one. `hd` is the strictly stronger assertion (it says the account
is *managed by* that Workspace, not merely that an address was verified), and
it costs one comparison, so there is no reason to pick between them. Note the
`hd` *request parameter* is a UI hint and is not a control; only the claim is
trustworthy.

**Recommended if cheap:** set the Google OAuth consent screen to *Internal*,
which blocks non-org accounts at Google's edge before a token is ever issued.
It requires the GCP project to live inside the Workspace org, which is the only
hard coupling in this design. If that move is annoying, the claim checks above
are adequate on their own; they just become the whole defense rather than the
second layer.

The check happens once, at login. Our Lambda never sees a Google token.

### Three gotchas that would each cost a day

- **Watch the front door for header remapping.** API Gateway REST renames
  `WWW-Authenticate` to `X-Amzn-Remapped-WWW-Authenticate`, which is the exact
  header OAuth discovery depends on, so the client never sees the challenge
  and auth silently never starts. An ALB should pass it through untouched,
  which is one reason the ALB is the right front door here, but `curl -i` the
  401 and confirm before building further.
- **The token verifier must throw `OAuthError`**, not a plain `Error`. A plain
  error produces a 500 rather than a 401, and a 500 never triggers Claude
  Code's OAuth flow.
- **`appendOfflineAccess` defaults on** in Claude Code, and Google does not
  advertise `offline_access`. Set it false if the flow breaks; Google returns
  refresh tokens to installed apps regardless.

Reference implementation worth reading: `taylorwilsdon/google_workspace_mcp`,
which is this exact pattern at scale.

### Cheaper first step

If the 3-5 days is not worth it yet, `headersHelper` in `.mcp.json` runs a
command that prints a JSON header object and re-runs it on 401. A script
emitting a `gcloud` Google ID token gives real, domain-restricted identity with
**no authorization-server code at all**, verifiable offline against Google's
JWKS. The cost is a `gcloud` dependency on an otherwise AWS-only team, and it
does not block the full build later.

## Why one container rather than Lambda plus tasks

Earlier drafts split this three ways: Lambdas for webhooks, a control plane,
and one ECS task per agent. Every seam between those pieces cost something.
Cross-process dispatch needed `RunTask` with a deterministic `clientToken`,
because ECS has no conditional write and `ListTasks` cannot see a finished
task. `ask_human` needed a relay, because the agent and the Boss were not in
the same place. State needed a database, because two tiers had to share it.

Persisting sessions to S3 every turn removes the reason for all of it. A
killed agent loses one turn, so agent lifetime no longer needs to survive a
deploy, so agents do not need to be separately deployable, so there is no
cross-process dispatch, so there is no ECS consistency problem to solve.

What is left is one process where dispatch is starting a child, `ask_human` is
a function call, and shared state is a variable.

## No Slack Socket Mode

An earlier draft had the Boss hold a Socket Mode WebSocket to avoid a public
endpoint. We already have public webhook endpoints for Grafana, so a Slack
Events subscription costs nothing extra, and `autopilot` already implements
Slack signature verification at `POST /autopilot/slack`. Socket Mode was
solving a problem we do not have.

## Authentication

| Direction | Authenticated by | Authorizes |
| --- | --- | --- |
| Grafana → Boss | HMAC `X-Grafana-Alerting-Signature` + basic auth, fails closed | Signal ingest only |
| Slack → Boss | Slack signing secret, v0 HMAC over `timestamp:body`, replay window | Identifies the Slack user |
| Agent → Boss | A scoped token on a local socket or loopback HTTP, carrying `incidentId` | **That one incident.** See the note below; this is the one thing co-location makes harder. |
| Employee → Boss, in Slack | Slack workspace membership, via the signature above | All incidents |
| Employee → MCP | OAuth 2.1 against our own AS, with Google Workspace as the login upstream and `hd` verified at `/callback`. Bearer is an HS256 JWT scoped to the MCP URL. | All incidents, attributable per user |
| Boss → S3, Slack, Bedrock | Task role and Secrets Manager | Outbound |
| Agent → Slack, GitHub, Bedrock, Grafana | Scoped tokens; GitHub App limited to omni | Outbound, cannot merge |

### The agent's AWS access is a second role, not a scrub

The task role cannot simply be withheld: on Fargate it arrives through
`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, so scrubbing it removes Bedrock and
the read-only AWS an agent needs to investigate at all.

Instead the parent assumes a dedicated **`bugboss-agent`** role via STS and
hands the child those temporary credentials. It carries `bedrock:InvokeModel*`
and read-only ECS, CloudWatch, RDS and ELB, and nothing else. The boundary is
an IAM role rather than a list of environment variable names someone has to
keep current. `maxSessionDuration` is 12 hours, the maximum, because incidents
outlive the one-hour default; expiry is one more reason an agent restarts, and
it resumes from its session.

Attribution is free: a role session name per incident makes every call show up
in CloudTrail as `bugboss-agent/<incidentId>`.

**Assuming a compromised agent, the one real exposure is account-wide
CloudWatch Logs read.** It cannot reach S3, Secrets Manager, the release path,
or `sts:AssumeRole` to pivot. It can burn Bedrock spend, bounded by the
deadline. But `logs:FilterLogEvents` on `*` means it can read production logs
for every service in the account.

That is inseparable from the job. An agent restricted to a fixed list of log
groups cannot investigate the first incident in a service nobody predicted. We
accept it knowingly, and it raises the stakes on the log-redaction rule in
`docs/observability.md`, since redaction is now the control that matters.

**Co-location weakens containment, so run agents as child processes with a
scrubbed environment.** Previously an agent was a separate task with its own
role, so a compromised one could corrupt one incident record. Now it shares a
container with the Slack token, the GitHub token and S3 write credentials, and
it reads attacker-writable log lines for a living.

The mitigation is cheap and not optional: spawn each agent as a child process
with no AWS environment variables inherited, a per-incident token for the tool
API, and only the outbound credentials it actually needs. The parent keeps
everything else. Both candidate harnesses already run the model in a
subprocess, so this costs process hygiene rather than architecture.

## Rollout: straight to autonomous

No shadow phase and no assisted phase. The system goes live making real
decisions, and **V1 is not done until at least one incident has been carried
end to end**: triaged, root-caused, fixed by a merged PR, verified, and
written up.

That is defensible because the guardrails are structural rather than
procedural. The agent can open a PR but a ruleset on `main` stops it merging.
Triage's failure mode is opening too many incidents, since the fallback on any
error is `new_incident`, which is noisy rather than dangerous. The raw alert
firehose still reaches Slack through Grafana's own integration, so nothing is
lost if the system misbehaves. And the kill switch is one action in the
Grafana UI, repointing the notification policy away from the webhook.

What we give up is a tuning period before triage makes real calls. The trade
is deliberate: a shadow mode that nobody acts on tends to stay in shadow, and
this one already has a precedent sitting in prod (see below).

## Ship this first, independent of everything above

Add a parallel route in Grafana so the raw alert firehose always reaches Slack
through Grafana's own integration, regardless of whether BugBoss is running.
Alertmanager's `continue: true` keeps evaluating sibling routes, and
`dev-alerts` already exists as both a Slack and a webhook contact point, so
this is a policy edit rather than a build.

After that, BugBoss is purely additive. It can crash, be redeployed, or be
switched off entirely, and the worst case is exactly today's behavior.

---

---

# Observing BugBoss itself

We build this and we also depend on it, so debugging it has to be a designed
surface rather than an afterthought.

## Where things are

| Artifact | Location |
| --- | --- |
| Boss logs | CloudWatch, one log group |
| Agent logs, per task | CloudWatch, `/ecs/bugboss-agent-<env>`, stream per task id |
| Agent session (live) | S3, `sessions/incident/<id>/`, current as of the last completed turn |
| Agent session (archived) | S3, on close |
| Incident state | SQLite on the task, snapshot at `s3://bugboss-{env}/state/db` |
| Failed webhook deliveries | Lambda DLQ |

## The primary debug interface is the Slack agent

Asking `@bugboss` what happened to incident 42 is faster than any dashboard we
would build, and it already has the tools: read the record, read the transcript,
read what the agent ruled out. Build that well and most debugging needs nothing
else.

## Break-glass, for when the Boss is the thing that is broken

There are no debugging skills, because asking `@bugboss` already does that job
and doing it twice would rot. The gap is the case where the normal interface is
unavailable: the Boss is down, or wrong, and you cannot ask it anything.

That path is a section in the `ops` repo's `AGENTS.md`, which is where an
agent working on BugBoss already looks. It needs to be enough to work without
the Boss:

- The S3 key for the database snapshot, so an incident can be read by pulling
  it and running one query.
- The S3 session prefix and layout, so a transcript can be fetched with one
  `aws s3 cp`.
- Log group names for the Boss and for agent tasks, and how a task id maps to a
  stream.
- How to stop a running agent without the Boss.
- How to disable ingest and fall back to plain Slack alerting, which is the
  Grafana notification-policy edit described above.

Everything else belongs in the Boss, not in a document.

## BugBoss alerts must not route through BugBoss

The failure that matters is a silent one: the Boss is down, alerts are being
accepted and dropped, and nobody notices because the thing that would have told
us is the thing that is broken. Netflix's Winston team reached the same
conclusion in 2015 and treated the automation platform's own health as
high-priority.

So BugBoss's own alerts go **straight to Slack through Grafana**, never through
itself:

- Boss heartbeat, alerting on absence.
- Webhook 5xx rate and DLQ depth.
- Agents that died N times on the same incident.
- Spend per hour above a ceiling.
- An incident open longer than a threshold with no owner.

This is also why the parallel raw-alert route matters: it means a dead Boss
degrades to today's behavior rather than to silence.

# Decisions that are not obvious

| Decision | Why |
| --- | --- |
| Incident is the unit, signals attach | Grouping can be corrected rather than guessed right |
| Merge and split are one primitive | One code path, one audit shape |
| Triage stays conservative | Association needs evidence; a wrong merge hides a second problem |
| Dispatch is capped, not grouping | When the first agent merges nine queued incidents, those nine never start |
| A PR is not a phase | Resolving may take zero PRs or four, plus migrations |
| One agent, investigate and patch together | Splitting by lifecycle stage is Anthropic's named anti-pattern; handoff loss exceeds the gain |
| Subagents split by data domain | Logs, traces and metrics, recent deploys. Never by workflow stage |
| BugBoss lives in `ops`, not omni | omni merges to `main` every ~8 minutes and its release train is deliberately not path-filtered, so living there would kill every running agent several times per investigation |
| Bound runs by wall clock, not by budget | A timeout is external, so enforcing spend never constrains which harness we pick |
| Sessions sync to S3 per turn, from a wrapper | Resumability and shared reads are different requirements; splitting them removes the need for a shared filesystem entirely |
| Pi over the Claude Agent SDK | The SDK ships more of what we need, but Anthropic-only is permanent and the gap is about a week of adapter work |
| SQLite, mirrored to S3 | The control plane barely needs a database; the agents do. SQL is a far better tool surface for an open-ended question box than a fixed set of query functions, and transactions make a merge atomic |
| Resume is the primitive | Deploys and crashes end a long process eventually |
| Replay the prefix verbatim | Thinking blocks are bound to `system`, `tools` and all prior messages |
| Dispatch by comparing desired to observed | No leases, no TTLs, no clock skew |
| Dispatch compares in-memory desired to in-memory observed | Agents are child processes, so there is no external state to reconcile against and no consistency window |
| Nothing auto-closes | Every incident terminates in a human-visible outcome |
| PR yes, merge never | Enforced by a ruleset, so it survives token leak |
| Agents hold nothing | Telemetry is attacker-writable input |

---

# Open questions

1. **Does `WWW-Authenticate` survive our front door?** Verify with `curl -i`
   before building the OAuth leg. API Gateway REST silently remaps it and
   kills discovery; an ALB should not, but confirm rather than assume.

2. **Does session resume work end to end?** Two tests: kill an agent
   mid-turn, resume, and confirm thinking signatures replay and the turn
   completes; then compact a session, restore it from S3, and confirm resume
   respects the compaction point rather than replaying the whole tree.

3. **Reproduce the Converse empty-thinking drop** on Opus 5 or Sonnet 5
   before writing the InvokeModel adapter. It is a concrete code path but the
   trigger shape is inferred.

4. **Can `clear_thinking` pass through our InvokeModel adapter?** Worth
   checking while that code is being written, since it would be a better
   compaction primitive than summarization.

5. **Five body-shape questions one live Bedrock call settles**, in risk
   order: whether `output_config: { effort }` passes through InvokeModel;
   whether `block_binding: { prefix_mismatch_behavior }` does (resume depends
   on it); the `amazon-bedrock-invocationMetrics` field names (a wrong name
   degrades to zeros, not wrong numbers); `anthropic_beta` as a body field;
   and whether `context_management` / `clear_thinking_20251015` is accepted.
   All are modelled on Pi's first-party Anthropic path and unverified against
   Bedrock.

6. **Fix the preview-database migration problem separately.** Editing a
   migration after a PR push breaks the preview DB with a checksum mismatch,
   which surfaces as broad unrelated E2E failures. An agent iterating on a
   migration will hit it. The fix is to make preview databases tolerate it
   (wipe on deploy, or similar), not to stop agents writing migrations. Out of
   scope here, worth its own ticket.

7. **How many concurrent fixers?** Investigating agents carry source only, so
   the disk cost is entirely in agents that reached `FIXING`, at up to
   4.79 GB each. Fifteen simultaneous fixers would be 72 GB, which fits, but
   it is worth measuring a real `npm ci` in the container before assuming
   fifteen concurrent installs behave.

## Deferred, deliberately

- **Query budget for subagents.** Fan-out multiplies Loki reads. Watch the
  bill rather than pre-solving it.
- **A cost ceiling across concurrent incidents.** The parallelism cap bounds
  it well enough for a first pass.

# Verified facts worth not re-deriving

Everything here was checked against primary sources or measured directly during
design, on 2026-09-23.

**Thinking blocks.** Signatures do not expire; a 38-day-old block replayed
successfully. They are portable between the Anthropic API and Bedrock. The
signature *is* the encrypted reasoning, not a hash: on Opus 5 and Sonnet 5 the
plaintext is empty and the signature is the only copy. Prefix binding was
confirmed with four mutation tests (system, tools, prior message, and a
control).

**`ops`, surveyed 2026-09-24 at `origin/main` `264b7b1`.** Its `deploy.yml` is
unfiltered, and because the image tag is the commit SHA, a docs-only merge
produces a new task definition revision (verified against PR #83). Separate
path-filtered Pulumi projects are the established fix, used twice in the last
week. There is no ECS service, no ALB and no `ephemeralStorage` anywhere in
the repo. One shared `DELEGATES` secret maps every key into every container.
`Environment: infra` is a protection tag enforced by the engineer SSO
permission set, not a label. The account is the AWS Organizations management
account, so SCPs do not constrain anything deployed there. Bedrock works but
has **no model invocation logging configured**, and BugBoss would be the
repo's first runtime Bedrock caller. **The repo is public.**

**Unrelated finding worth a ticket:** the pmf-engine IAM policy grants
`ecs:TagResource` without the
`"Condition": {"StringEquals": {"ecs:CreateAction": ["RunTask"]}}` guard, so
that role can retag arbitrary resources.
