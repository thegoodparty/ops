# Replacing Claude Code with pi in `delegate`

> **Status: proposal.** This document records the decision to remove the Claude
> Code dependency from `delegate/` and run every agent on
> [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi-coding-agent)
> (pi), the plan for doing it, and the evidence each step needs before it ships.
> It changes no code. Where this document makes a call of its own rather than
> restating one of the three source reports, it says **decided here** and gives
> the reasoning, so review can argue with the reasoning rather than guess at
> it. Everything still owed to a human is collected under "Open questions".

> **Where the technical facts come from.** Three read-only investigations ran
> before this document was written: an inventory of every Claude-Code/Anthropic
> surface in the repo, a capability-by-capability design for each of them on
> pi, and a rollout/measurement review of the sequencing. Their findings are
> the source for this plan; the plan's authors did not re-derive them. The
> current-state citations below were re-verified against `main` at `ab7aed8`
> while this document was written. Nothing here was produced by running the
> code: no `node_modules` in the sandbox, so no `npm test`, no image build, and
> no pi run against a real model. Claims of the form "pi does X" are read from
> pi 1.5.0's own docs and `dist/`, not measured.

> **Why this lands as a human-authored document first.** The repo's own
> improvement loop cannot carry a change of this shape. The hill-climb
> dispatch (`delegate/review/eval/dispatch.ts:10`) restricts a candidate branch
> to literal-only changes in exactly two files — `delegate/agents/pr-reviewer.ts`
> and `delegate/agents/pr-reviewer-subagents.ts` — and
> `delegate/review/eval/dispatch.ts:163-173` refuses anything that differs
> outside string and template-literal text. A harness migration changes imports,
> types and the runtime the two files execute, and
> `.claude/skills/hill-climb/targets/delegate-pr-reviewer.json` lists
> `delegate/framework/` in `neverTouch` for exactly that reason: the allowlist
> is what makes an unattended, credentialled, budget-capped loop safe. So the
> decision is recorded in a document a human reviews, and the measurement
> instrument is rebuilt (§ "Measurement") before the reviewer itself moves.

## The decision

`delegate` runs every agent through the Claude Agent SDK today: `query()` from
`@anthropic-ai/claude-agent-sdk` (`delegate/framework/agent.ts:1`), backed by a
globally installed `@anthropic-ai/claude-code` CLI in the worker image
(`delegate/worker/Dockerfile:5`), configured through SDK types that leak
straight into `delegate`'s own public surface (`delegate/framework/types.ts:1`).

That is being replaced with pi, and **fully replaced** means exactly this: after
the last step, no file in the repository imports `@anthropic-ai/claude-agent-sdk`,
no image installs `claude-code`, no SDK type appears in `delegate`'s API
surface, no `CLAUDE_*`/`ANTHROPIC_*` variable reaches an agent, no
Claude-specific secret key is declared for the worker task, and no agent
behaviour depends on a Claude-Code-only feature (the `Task` tool, the `Skill`
tool, `StructuredOutput`, `settingSources`, `plugins`, `permissionMode`). The
exhaustive checklist in the last section is the definition of done.

Three motivations, in the order they matter:

1. **Model choice per agent, and per subagent.** Today the model is a string on
   each agent definition and the harness fixes which models are reachable at
   all. The reviewer's orchestrator runs `claude-opus-5-5`
   (`delegate/agents/pr-reviewer.ts:214`) and its specialists
   `claude-sonnet-5-5` (`delegate/agents/pr-reviewer-subagents.ts:82,143`) —
   a seam that exists but only inside one vendor. The point is not "cheaper
   models"; it is that the harness should not be the thing that decides which
   vendor a per-agent choice can name.
2. **Escaping a single proprietary vendor.** Every agent's availability, price
   and model roadmap is one company's decision, and the failure mode is not
   hypothetical: the repo already carries a patched pi model catalog because
   pi's built-in Fireworks pricing under-reports by a third
   (`agent-swarm/host/global-setup-script.sh:186-198`), and
   `docs/bifrost-fireworks-model-metadata.md` records a catalog gap that logged
   every Fireworks request at $0 with no error. Vendor concentration is a
   correctness problem in the cost telemetry, not only a commercial one.
3. **One in-repo precedent instead of two harnesses.** `agent-swarm/` already
   runs pi (`agent-swarm/host/render-env.sh:102`, `HARNESS_PROVIDER=pi`). Two
   harnesses in one repo means two credential models, two model-catalog
   patches and two sets of skills conventions. Converging on pi removes a
   duplicate rather than adding a third.

## What "today" is, exactly

The path is Lambda → Fargate → entrypoint → `runAgent` → Claude Code subprocess.
Each hop, with its file and line:

1. **Lambda webhook.** `delegate/lambdas/handler.ts` routes Slack events;
   `delegate/lambdas/github.ts:8-19,105-123` decides which PR events are worth
   a review; `delegate/lambdas/verify.ts` checks signatures. The handler builds
   an `AgentJob` (`delegate/framework/types.ts:37-43`) and calls
   `dispatch()`.
2. **Fargate dispatch.** `delegate/lambdas/dispatch.ts:44-47` issues
   `RunTaskCommand` with `launchType: "FARGATE"`, passing the job as the
   `AGENT_JOB` environment variable and tagging the task (`dispatch.ts:20-38`).
   One task per job; there is no per-agent release channel and no per-agent
   switch.
3. **Entrypoint.** `delegate/worker/entrypoint.ts:57-64` parses `AGENT_JOB`;
   `:83-95` arms a hard wall-clock deadline (`AGENT_DEADLINE_MS`, default 45
   minutes) on an `AbortController`, because the SDK's turn and budget caps
   only fire between turns and the cluster had accumulated zombie tasks before
   this existed; `:100-107` sets up GitHub App auth (the reviewer runs entirely
   as its own App); `:120-133` shallow-clones omni for `slack-responder`;
   `:143-200` checks out the PR at its live head SHA for `pr-reviewer`;
   `:270-280` hands the review to the deterministic layer; `:420` is the
   generic `runAgent(config, message, cwd, abortController)` call.
4. **`runAgent`.** `delegate/framework/agent.ts:43-48` is the single seam. It
   builds one `query({ prompt, options })` (`agent.ts:64-103`) with
   `systemPrompt`, `model`, `mcpServers`, `env`, `tools`, `outputFormat`,
   `agents`, `plugins`, `settingSources`, `allowedTools`, `maxTurns`,
   `maxBudgetUsd`, `permissionMode: "bypassPermissions"`, `cwd` and
   `hooks.PreToolUse`, then iterates the SDK's message stream: `system/init`
   gives `sessionId` (`:104-122`), `assistant` messages are the turn log
   (`:124-184`), `user`/`tool_result` blocks feed subagent bookkeeping
   (`:186-209`), and `result` gives `output`, `total_cost_usd`, `num_turns` and
   `structured_output` (`:211-268`). `AgentResult`
   (`delegate/framework/types.ts:52-62`) is the contract every caller sees.
5. **The subprocess.** The SDK spawns the Claude Code CLI, which is what
   actually holds the model connection, the tool loop and the permission
   machinery. That process boundary is load-bearing and is the subject of the
   first of the three differences below.

For the reviewer specifically, `delegate/review/run.ts` sits between the
entrypoint and `runAgent` and is *already* deterministic code: it builds the
input bundle, passes an allowlisted environment (`run.ts:46-72`), installs the
checkout path guard (`run.ts:77-110`), validates the structured output
(`run.ts:302-345`), runs one bounded repair turn on a schema failure
(`run.ts:674-712`), and is the only thing that touches GitHub. The agent only
reads code and answers.

## Three differences in kind

These are not renames. Each one is a property the current design depends on
that pi does not have in the same form, and each needs a decision rather than a
translation. They are listed without softening because the plan is only
credible if the hard parts are visible.

### 1. Credential isolation is a process boundary today, and stops being one in-process

`delegate/review/run.ts:42-45` states the model plainly:

> Everything the Claude Code subprocess (and therefore the model) can see in
> its environment. Allowlist, not denylist: the worker's env is the whole
> DELEGATES secret bundle, and a Read on /proc/self/environ would leak any key
> we forgot to name.

So the reviewer's confidentiality rests on two things that reinforce each
other: `agentEnv()` (`run.ts:46-72`) hands the child a *short allowlist*
(`PATH`, `HOME`, `TERM`, the two AWS region variables, three `ANTHROPIC_*`
model variables, plus the `CLAUDE_` and `DISABLE_` prefixes), and the child is a
*different process*, so the worker's own environ is a file the model cannot
reach except through the path guard (`run.ts:74-76` says `/proc/<ppid>/environ`
is "a regular file to the Read tool").

Run pi in-process — `createAgentSession()` in the worker — and both halves
fail at once. The agent's `read` tool sees `/proc/self/environ`, which is now
the worker's environ: the full `DELEGATES` bundle, the GitHub App private key
and the ClickUp token included. The path guard cannot save it, because the path
is not outside any checkout — it is inside the agent's own process. This is
**the** reason the recommendation below is a child pi process for every agent,
and it is not a preference.

**Decided here:** every agent gets a spawned pi child process with an explicit
`env`, never `createAgentSession` with inherited environment. The reviewer's
allowlist stays an allowlist, keyed by key, extended only with pi's own
non-secret runtime knobs; the `CLAUDE_`/`DISABLE_` prefixes go, because they
were escape hatches for a harness that will not be there. The allowlist test
(`delegate/review/run.test.ts:176-209`) is rewritten, not deleted — it is a
credentials test, and it is the only thing that fails when someone widens the
list carelessly.

Two traps that follow, both worth writing down now because they are silent:
`RpcClient` from pi merges `{ ...process.env, ...options.env }` and offers no
way to *remove* a key, so it cannot express an allowlist — the client must be
~80 lines over the documented protocol. And `HOME` is in the current allowlist
while pi resolves `~/.pi/agent` from it, so the image's `HOME` must either be
empty or be replaced by an explicit `PI_CODING_AGENT_DIR` with no `auth.json`
and no `mcp.json` in it.

### 2. The structured-output contract changes regime

The reviewer's deliverable is a JSON object, and today the harness guarantees
its shape. `delegate/agents/pr-reviewer.ts:218-230` sets
`outputFormat: { type: "json_schema", schema: REVIEW_OUTPUT_JSON_SCHEMA }` and
includes `"StructuredOutput"` in `tools`, with the comment explaining why both
are needed: `StructuredOutput` is a built-in *tool*, and restricting `tools`
without it leaves the model no way to return structured output at all. What
comes back is `msg.structured_output` (`delegate/framework/agent.ts:215`),
which `parseReviewOutput` (`delegate/review/run.ts:302-345`) treats as the
contract, with a prose-scanning fallback for when the model narrates instead.

pi has no `outputFormat`. The nearest primitive is a custom tool the model is
asked to call, returning `structuredContent` with `terminate: true`. That is a
different reliability regime: the harness no longer enforces a grammar, so a
missing tool call and a malformed one become two distinct failures, and the
one bounded repair turn that exists today (`run.ts:674-712`) becomes the
recovery path for both.

The union limitation is the part that must not be discovered late. Today the
model-facing schema is deliberately a **flat object** with every status-specific
field optional, and `ReviewOutputSchema` — the discriminated union — validates
what comes back afterwards (`pr-reviewer.ts:16-38`, with the comment that
"the Anthropic API requires a tool input_schema to be `type: "object"` with no
top-level oneOf/anyOf"). `toSupportedDialect` (`pr-reviewer.ts:46-58`) then
rewrites the nested `planConsistency` `oneOf` to `anyOf` for the same reason.
On pi the flat top level is still required (the provider builds
`{type: "object", properties, required}` and drops a top-level union), and if
provider-side strict sampling is requested, pi validates the schema first and
**rejects object and array unions outright**. So the choice is: strict
provider-side sampling, or nested discriminated unions — not both.

**Decided here:** leave `constrainedSampling` off, keep the flat model-facing
object verbatim, keep `ReviewOutputSchema` frozen as the authority, and lean on
local zod validation inside the tool's `execute()`, where a failure is a tool
error the model can fix in the same turn instead of a whole extra LLM turn. That
is strictly better than today on malformed output and slightly worse on
first-attempt misses. `ReviewOutputSchema` must not change during the
migration: it is what makes old and new records comparable in the corpus.

### 3. Budgets: there is no `maxTurns` and no `maxBudgetUsd`

`delegate/framework/agent.ts:92-93` sets `maxTurns: config.maxTurns ?? 50` and
`maxBudgetUsd: config.maxBudgetUsd ?? 5`, and every agent overrides them
(`slack-responder.ts:185-186` 80/$15, `pr-reviewer.ts:216-217` 80/$10,
`tech-design-agent.ts` 80/$10, `epic-agent.ts` and `epic-edit-agent.ts` 60/$5).
Exhaustion arrives as a non-success `result` whose `subtype` is
`error_max_turns` or `error_max_budget_usd`, which `delegate/review/run.ts:663-666`
turns into a failed review.

pi has neither. There is no CLI flag, no settings key, nothing in `pi --help`,
`docs/cli.md` or `docs/settings.md`: searched and absent. The outer bound that
survives is the worker's 45-minute deadline (`entrypoint.ts:83-95`). The inner
cap has to be **built** — and building it means computing cost locally, which
is the sharp edge.

`costUsd` today is the SDK's `total_cost_usd` (`agent.ts:213,245`), and it is
not cosmetic. It lands on the review record (`ReviewRecord.costUsd`,
`delegate/review/schema.ts`), it drives the eval's `costRatio` gate, and it is
the value of the `Delegate/Workflow:PhaseCostUsd` metric filter
(`deploy/components/worker.ts:41-54`, `value: "$.costUsd"`). pi computes cost
from its own model catalog, and **this repo has already been bitten by exactly
that**:

- `agent-swarm/host/global-setup-script.sh:186-198` patches pi's catalog by
  hand because pi's built-in Fireworks numbers are ".3/1.2 for the -1017
  entries, which under-reports by a third".
- `docs/bifrost-fireworks-model-metadata.md` records the same class of bug one
  layer down: with no pricing row, Bifrost's `resolvePricing` returns nil and
  "a request on the router id is logged at cost 0 with no error … the gateway's
  per-key cost attribution has been recording zero for every Fireworks request".

pi's `cost.totalFromProvider` is only ever `true` for OpenRouter-reported cost;
for every other provider the total is a locally computed estimate from catalog
rates. If the catalog has no row for the mapped model, the cost is `0`, the
budget extension never fires, the metric logs zero, and the migration's own
success criterion ("not more expensive") passes for the wrong reason.

**Decided here:** cost is an estimate and the plan says so everywhere it is
used. Three consequences are non-negotiable: (a) the pricing source is pinned
in one place, per harness, and the Fireworks US price is *not* taken from pi's
built-in catalog; (b) at least one representative run of each harness is
reconciled against a billing line before any `costRatio` is trusted; and (c) an
implementation-PR gate treats "cost dropped" as suspicious rather than as a win.
Turn counting also shifts by one definition — the SDK's `num_turns` counted
assistant messages, pi's `turn_end` is one assistant response *plus its tool
calls* — so the limits are re-tuned from measurement rather than assumed to be
equivalent.

Three smaller differences follow from the same seam and are handled in the
phase plan rather than here: the SDK's failure `subtype` vocabulary has no pi
equivalent, so a closed `RunnerError` enum is needed or every timeout becomes a
red `error` status on a PR; a pi session id is not comparable to a Claude one,
so the repair turn must be tested per harness; and the corpus needs a `harness`
field before a single pi record is written, or the eval cannot tell which tree
produced a review.

## Phase plan

One step at a time, one pull request per step, in the order below. The ordering
is forced by one fact: the only seam is `runAgent` (`agent.ts:43-48`), and today
that function *is* the SDK, with its types in `delegate/framework/types.ts:1,10-24`.
So the framework is neutralised before any agent moves, and the neutral contract
is the one-way door of the whole plan.

Each step is marked **atomic** (must land as one unit — splitting it produces an
intermediate that does not build or cannot be confined) or **independently
mergeable**, and **reversible** or **one-way**. The evidence column is the gate:
the work does not ship on "tests pass".

| # | Step | Atomic? | Reversible? | Evidence required before it ships |
|---|---|---|---|---|
| **P0** | This document. | independent | yes (docs revert) | Plan merged; the inventory checklist below adopted as the working list. |
| **P1** | **Framework seam.** A neutral `Runner` contract — tool set, tool-permission hooks, subagent specs, a structured-output ask, turn/budget limits, an opaque session handle, a normalised `AgentResult` — with the Claude implementation kept **behaviour-identical**. `GIT_TOOL_NAMES` split out of `git-tool.ts` so the four names stop dragging the SDK in via `git-tool.ts:2`. | **atomic** | **yes** (refactor) | `npm test`; `npm run build` (the only full typecheck — `tsx --test` does not typecheck, so `deploy.yml`'s `tsc` is load-bearing); behavioural-identity proof: byte-identical review prompt for a recorded bundle, `REVIEW_OUTPUT_JSON_SCHEMA` test unchanged, `agentEnv` test unchanged; one `delegate eval` on the PR showing quality not-worse and cost Same. |
| **P2** | **Attribution.** `harness` on `ReviewRecord`, in `replayKey` inputs (`delegate/review/eval/cache.ts:26`), in `report.json`/`report.md`, plus a golden parse test. | independent | yes | `npm test`; a `replayKey` test proving the new input changes the key; a report golden showing the column; a recorded back-fill decision for old records. |
| **P3** | **Selection.** `AgentConfig.runner?: "claude" \| "pi"`, default `"claude"`; both drivers registered; no agent flipped. | independent | yes (flag) | `npm test`; both drivers configured for every agent and both pass the existing suites — this is where the two failure taxonomies get caught; a dry run of each agent's config through both. |
| **P4** | **`tech-design-agent`** on pi. Cheapest and draft-only (`tech-design-agent.ts`: a draft ClickUp doc a human blesses), so its gaps surface at a few dollars a run instead of an eval round. | independent | yes | No automated quality instrument exists. Gate is (a) a scripted replay of 3–5 recorded real inputs through both harnesses, diffed by a human; (b) a canary in a scratch ClickUp list; (c) `PhaseCostUsd` within +10% for a week. |
| **P5** | **`epic-agent`, `epic-edit-agent`** on pi. `epic-edit` is the destructive one: it mutates and deletes subtasks behind nothing but `bless` and prompt-level discipline. | independent | yes | As P4, plus a snapshot-before-change check for `epic-edit` specifically. |
| **P6** | **`pr-reviewer` + `scout` + `deep-reviewer`** on pi. The keystone, and the only step that can change a merge outcome. | **atomic internally** | yes, at the flag | The full battery, in order: local structural A/B first → `delegate eval` on the PR with the expected gate `--final` (no regressions, no `rerun`, targets green) → pairwise quality not worse, holdout counts only → `costRatio ≤ 1.10` **with the price source verified** → 10–20 canary production reviews under `DELEGATE_GATING_MODE=shadow` with zero false approves and `review_failed` at or below baseline → flip back to `enforce` in a separate PR. |
| **P7** | **`task-execution-agent`** on pi. It opens PRs in 13 repos (`delegate/framework/repos.ts:17-31`) and its allowlist is **prompt-enforced only** (`repos.ts:11-16` says so explicitly). | independent | yes | As P4, plus a runtime check that the `WRITE_REPOS` refusal still fires — a port that loses the instruction becomes a bot that can push anywhere the App is installed. |
| **P8** | **`slack-responder`** on pi: skills in place of the Superpowers plugin, context-file loading made explicit and tested, MCP grafana preserved, deadline parity. | independent | yes | `npm test`; one Slack channel canaried; the full lifecycle verified — `:eyes:` reaction, callback, boot-failure message, deadline abort; and a pi-specific check that omni's `CLAUDE.md` is still known to the agent. |
| **P9** | **Decommission.** SDK dependency, the `claude-code` global install, `ANTHROPIC_*` undeclared, CI secrets (only if the judge moved too), docs. | **atomic** | **partly** — see "Rollback" | Every workflow green on the removal PR: `deploy.yml` test + deploy (typecheck, build, docker build, pulumi preview), the eval workflows updated and dispatchable; a full cold `delegate eval` after the lockfile change; image size before/after recorded; `pulumi preview` showing exactly the expected task-definition delta. |
| **P10** | Operator runbook and a **rehearsed** rollback with timings, written into `delegate/README.md`. | standalone | n/a | The rehearsal itself, recorded. |

**Which steps are one-way doors.** Four, and only four:

1. **`ReviewRecord`/`ReviewOutput` schema.** Once pi-produced records share the
   corpus, a change makes old and new records un-joinable and breaks the eval's
   baseline. It is one-way *in practice* because the S3 corpus is the
   measurement. Mitigation: P2 lands the `harness` field before anything writes.
2. **Deleting the `ANTHROPIC_API_KEY` value from the `DELEGATES` secret.** The
   only genuinely irreversible act in the plan — key material cannot be
   reconstructed. It is therefore *not* in P9; see "Rollback".
3. **Removing the `claude-code` install and the image contents behind the old
   runner.** Recoverable by a revert-merge plus an image rebuild (~20 min), so
   *effectively* reversible, but it is the moment the old runner stops being
   "one flag away".
4. **Moving `.claude/skills/hill-climb` to a pi-read path.** `.dockerignore`
   excludes `.claude`, so the skill never reaches the image; moving it into a
   pi-read directory would start shipping it. That is a silent behaviour and
   image-size change inside what looks like a tidy-up — do it deliberately or
   not at all.

**Nothing under `deploy/` is a one-way door.** `workerImageUri` is a Pulumi
config value and ECR tags are the ops commit, so every prior image stays
addressable.

### Coexistence: a mixed fleet, with a written end date

**Decided here: allow coexistence through P8, force a single harness at P9.**
The reasoning, from the rollout review:

- A six-agent fleet on a single image with no per-agent release channel means a
  phased migration is the only shape that keeps `main` shippable. A flag day
  would require all six agents and both subagents to be perfect at once.
- **A partially-migrated delegate is safe by construction**, with one
  exception. Each agent is independently triggered — Slack verbs and phase
  routing in `lambdas/handler.ts`, PR webhooks in `lambdas/github.ts` — and no
  agent calls another. One Fargate task per job, so concurrency is not a
  factor. The exception is shared state: all agents write the same
  `REVIEW_BUCKET` corpus, which is precisely what P2 fixes before any pi run
  writes a record.
- The seam already exists and is already swapped once in tests:
  `delegate/review/eval/replay.ts` injects `runAgentImpl`, which is proof the
  call site can dispatch to two implementations without touching callers.

The bounds, because an unbounded compatibility flag becomes the permanent
architecture and the image never shrinks:

- `runner` is a **two-value enum**, deleted in P9. It is not a stringly-typed
  extension point.
- **No per-dispatch runner override.** It would be trivial — `dispatch.ts:55-62`
  already overrides container env per task, so a canary needs no deploy — and it
  is refused: it puts a migration switch inside the dispatcher and
  `deploy/components/webhooks.ts`, both human-owned security-carve-out files,
  and turns "which harness ran?" into a runtime fact nobody can audit from git.
  A flag in code plus a revert PR is ~15 minutes and it is visible in the
  history.

**Blast radius, and who goes first.** Ranked by what breaks if the pi run is
subtly wrong: `tech-design-agent` (a bad draft) → `epic-agent` (recoverable by
hand) → `epic-edit-agent` (destructive, guarded only by a prompt) →
`task-execution-agent` (PRs in 13 repos) → `pr-reviewer` (merges) →
`slack-responder` (highest cost and blast, but every output is a chat message a
human reads).

**The one that is actually dangerous is `pr-reviewer`, because it is the thing
that merges PRs.** `DELEGATE_GATING_MODE=enforce` is the deployed value
(`deploy/components/worker.ts:240`), and in `thegoodparty/ops` — the only gated
repo — four Pulumi trees are unowned in `CODEOWNERS`, so a bot approval merges
those with no human. The governance asymmetry is therefore: *this migration
cannot approve its own code, but a buggy migrated reviewer can approve its own
infrastructure.* The cheap response, **decided here**, is to run the entire P6
window under `DELEGATE_GATING_MODE=shadow`: one line in a human-owned file, no
merge outcome changed by construction, the record and its evidence kept, and the
flip back to `enforce` its own small PR after the gate is green.

## Per-capability replacement designs

Condensed from the capability design; each entry is the decision plus the
reason, with the mechanism that carries it.

### Runner: RPC child process, not in-process SDK

**Decision: a spawned `pi --mode rpc` child process with an explicit `env`.**
Not `createAgentSession()`. Justification, in order:

1. It is the only option that preserves `agentEnv()` (§ "difference 1").
2. It is the only option that gives a hard kill. `session.abort()` is
   cooperative inside the worker process; a child can be `SIGTERM`ed and then
   `SIGKILL`ed after a grace period, which is what the zombie-task history
   (`entrypoint.ts:76-95`) demands.
3. It handles the review prompt and the repair prompt in **one** long-lived
   session with two `prompt` commands, which is what `run.ts:674-712` does
   today, without a session-file round trip.
4. Malformed or extreme output cannot take down the process holding
   `REVIEWER_GITHUB_TOKEN`.

`runAgent` keeps its signature and its `AgentResult`; it becomes an adapter over
a small client that speaks three commands (`prompt`, `abort`,
`get_session_stats`) plus the event stream. The client is hand-written over the
documented protocol rather than `RpcClient`, because `RpcClient` merges the
parent environment and cannot express an allowlist.

`permissionMode: "bypassPermissions"` (`agent.ts:94`) has no pi equivalent and
is not needed: in `print`/`json`/`rpc` modes there is no interactive approval,
and a `tool_call` handler returning `{ block: true }` is the only gate. Model
ids stop being Claude ids, and the reviewer's *and* its subagents' models must
be mapped explicitly.

Session persistence: the reviewer needs a real session directory for the repair
turn, inside the task's ephemeral storage, removed in a `finally` — sessions
contain the full diff and PR body. `--no-session`, which most pi examples use,
makes resume impossible.

### Tool restriction

`tools` (allowlist, by name or pattern), `excludeTools` (applied after),
`noTools`. Built-ins map mechanically — `Read`→`read`, `Grep`→`grep`,
`Glob`→`find`, and there is deliberately no `ls` because delegate never had one.
The reviewer's spawn is `read,grep,find` plus the four git tools plus the
structured-output tool, with `bash,powershell,edit,write,ls,mcp__*,codemode,tool_search`
excluded.

**The hazard is MCP tools arriving through codemode.** An allowlist alone is
not a boundary: MCP servers default to codemode exposure and pi auto-activates
codemode when such a server connects, and a codemode script can call every MCP
tool. So `--no-mcp` is required in addition to the exclusions, plus an agent
directory containing no `mcp.json` and no `--approve`, so a project
`.pi/mcp.json` in a PR checkout cannot load.

`createSdkMcpServer` (`git-tool.ts:2`) becomes `pi.registerTool`, keeping the
four operations and — importantly — the `isSafeRef`/`isSafePath` guards
(`git-tool.ts:12-18`) verbatim, since those were never SDK-specific. A same-name
`registerTool` silently replaces a built-in, so custom tools are registered only
from `-e` paths inside the image, never from anything inside a checkout.

### Path guard

`pathGuardHook` (`run.ts:77-110`) re-expressed as a `tool_call` handler: same
realpath resolution, same prefix test, same reason string. Three differences
that matter:

1. **The input field is `path`, not `file_path`.** Keep both keys in the shared
   helper; `path` is the one pi's tools actually use.
2. **`{ block: true }` does not stop the run.** `terminate` only bites when
   every finalized result in a batch is terminating, so in a parallel batch
   (one scout, several deep-reviewers) a blocked read is one of several results
   and nothing stops. The guard therefore counts denials and calls `ctx.abort()`
   past a threshold — **decided here** — because the alternative is a model
   retrying an escape until the turn cap fires.
3. pi strips a leading `@` from path arguments; the naive resolution already
   fails safe, and the note is there so nobody "fixes" it into a bypass.

Nested calls (`parentToolCallId` set) go through the same handler, which is what
makes the codemode hole survivable if it ever opens. `bash` is not guarded —
that is unchanged for the reviewer (no bash) and for `slack-responder` (which
never had a path guard), and this document flags rather than widens it.

The guard stays in the image and reads its root from the environment, so no tool
the model can call chooses the root.

### Structured output

A terminating custom tool, as designed above. The model-facing schema stays the
flat object from `pr-reviewer.ts:16-38`; `ReviewOutputSchema` stays the
authority and is validated inside `execute()`, where a violation is a tool
error the model can retry in the same turn. `parseReviewOutput` keeps its shape
and is fed the terminating result's `details`; the prose-scanning fallback is
deleted only after the eval shows it unused. `toSupportedDialect` and the
draft-07 choice (`pr-reviewer.ts:46-58`) go away entirely, and so do the four
tests in `pr-reviewer.test.ts:286-346` that pin Anthropic's dialect — replaced
by a test that the flat schema is what the tool accepts and that the union
validates afterwards.

`constrainedSampling` stays off (§ "difference 2"). Expect a slightly higher
first-attempt miss rate than the grammar gave; the eval measures it per harness
and a rise in repair-turn rate is a regression, not noise.

### Subagents

`Task` disappears. The replacement is a purpose-built `subagent` tool that
spawns a **child pi process per subagent** with the same confinement as the
parent: same checkout, same allowlisted `env`, `--no-context-files`, no session
file, the same extensions. Three properties have to survive, and each is a
requirement rather than a nice-to-have:

- **Synchronous by construction.** A child process result is synchronous, so
  `forceSynchronousTaskHook` (`agent.ts:11-41`) is deleted with no behavioural
  loss. That hook exists because background `Task` let the review publish on
  partial specialist results; `agent.test.ts` records the eval run that proved
  it, and that test's *purpose* must be re-expressed as "the tool has no
  background mode", not simply deleted.
- **Per-subagent models.** Opus orchestrator, sonnet specialists today; children
  must be given `--model` explicitly and must not inherit by omission.
- **Cost reaches the parent.** pi only counts nested spend if the tool returns a
  combined `usage`. If it returns text only, children's spend is invisible and
  `AgentResult.costUsd` under-reports — and the reviewer is mostly children.
  This is also what makes the budget cap (§ below) work at all.

`SubagentCall` keeps its field names (`subagent`, `prompt`, `result`) so
`replay.ts`'s lead tracing keeps working, but it is produced from the tool's own
`details` rather than from transcript scraping — more reliable than
`recordSubagentUses`/`recordSubagentResults`. If per-call attribution cannot be
reproduced at all, the expected suite loses its lead-attribution diagnostic, and
that is a **decision for the engineer** before P6 starts, not a surprise during
it.

### Skills

`obra/superpowers@v6.2.0` already ships pi support: its `package.json` declares
`pi.extensions` and `pi.skills`, and its `.pi/extensions/superpowers.ts` registers
the skills path plus the `using-superpowers` bootstrap. So the vendored
directory needs no conversion — it is installed as a pi package in the image
(`Dockerfile:12-15` keeps its pinned clone), and the plugin structure delegate
mounts is already a pi package.

What changes is the *invocation model*, and it is weaker: a pi skill is
model-invoked by name from the system prompt, not a `Skill` tool call. There is
no `Skill` tool, so `slack-responder.ts:16`'s "invoke the `superpowers:systematic-debugging`
skill" becomes "use the `systematic-debugging` skill", the namespace prefix
goes, and `"Skill"` leaves the default allowlist. The mitigation for the
reliability drop is to keep the instruction imperative and name the skill, which
is what delegate already does elsewhere.

`--no-skills` for the reviewer is mandatory, not hygiene: skills are discovered
from the working directory up to the repository root, so a PR could otherwise
add `.pi/skills/<name>/SKILL.md` and put instructions into the system prompt of
the reviewer judging it. `--no-skills` still honours explicit `--skill` paths,
which is the asymmetry that lets image-supplied skills stay on and repo-supplied
ones stay off.

### `CLAUDE.md`: the isolation default inverts

Today isolation is the SDK default and `slack-responder` opts **in** with
`settingSources: ["project"]` (`slack-responder.ts:173-181`), while the reviewer
deliberately stays isolated and *reads* a repo's `CLAUDE.md` as evidence
instead, so a PR cannot edit `CLAUDE.md` to steer its own verdict.

pi inverts this: context files including `CLAUDE.md` load **regardless of project
trust** unless context loading is disabled. Project trust is not sufficient, so
the reviewer's containment becomes something that must be actively switched off.

**Decided here:** `--no-context-files` on the reviewer's spawn args and on every
subagent's, plus a **fail-closed assertion** in the review path that refuses to
continue if any context file or skill reached the system prompt. It belongs in
the same PR that switches the runner, with a test that fails if the flag is
dropped — the flag list lives in one shared constant precisely so a subagent
cannot miss it. For `slack-responder`, deleting `settingSources` is enough and
its prompt's existing claim becomes true by default; but "does it still know
omni's conventions" is an explicit, tested check in P8, because a silent loss of
repo instructions has no test, no metric and no error today.

`--no-context-files` does not block `read`, which is what lets the reviewer still
open a `CLAUDE.md` as data. It also suppresses the agent directory's own context
files, so reviewer instructions travel through `--append-system-prompt`, as
`config.systemPrompt` does now.

### Session resume

Today `RunOverrides.resume?: string` (`types.ts:32-34`) carries a session id
into `query()` and the repair turn re-prompts that session with a tightened cap
(`run.ts:683`).

pi's equivalent for this shape is a deterministic session id given to *both*
processes (`--session-id <runId>`), reusing the run's existing durable handle
rather than inventing one. The RPC single-process form is simpler still — one
process, two `prompt` commands, cost accumulating in `get_session_stats()` — and
it preserves the prompt cache exactly, which is another argument for RPC over
one-shot JSON.

The adapter must await `agent_settled` between prompts (a `prompt()` during
streaming rejects rather than queueing), and `agent_settled` — never `agent_end`
— is the completion signal, because auto-retry can follow `agent_end`. Session
ids are opaque and harness-specific: never compare or log them across harnesses,
and test the repair turn per harness.

### Environment isolation

Design as § "difference 1": spawned child, explicit allowlist, keyed by key.
The allowlist keeps its current non-model entries, drops `ANTHROPIC_MODEL` (the
model now comes from `--model`), drops both `CLAUDE_`/`DISABLE_` prefixes, and
gains only pi's own non-secret knobs (agent dir, session dir, offline, version
check, telemetry) plus the review checkout root. `PI_CODING_AGENT_DIR` points at
an image directory with no `auth.json`, no `mcp.json`, and no user context files.

Three footnotes worth keeping: pi injects `PI_SESSION_FILE` and friends into its
`bash` tool (a path to the session, hence to the diff — irrelevant for the
reviewer, already true for `slack-responder`); `NODE_OPTIONS` is in the allowlist
and is a code-injection vector if anything ever sets it; and a credential
resolved through `models.json`'s `!command` form is not solved by an allowlist,
because the child runs the command — pick one mechanism.

### Turn and budget caps

**Decision: build them, in one extension, with the reason recorded before the
abort.** The extension counts assistant messages and accumulates `usage.cost.total`
per message, and on exceeding `max_turns`/`max_budget_usd` it appends a durable
`delegate-abort` entry and calls `ctx.abort()`. The adapter reads that entry
after `agent_settled` and maps it to the closed `RunnerError` enum:

| pi signal | `errorSubtype` |
|---|---|
| `delegate-abort` reason `max_turns` | `error_max_turns` |
| `delegate-abort` reason `max_budget` | `error_max_budget_usd` |
| `delegate-abort` reason `max_denials` | `error_path_guard` |
| `delegate-abort` reason `deadline` | `error_deadline` |
| `agent_settled { aborted: true }` with no entry | `aborted` |
| last assistant `stopReason: "error"` | the provider message |

That keeps every existing consumer working unchanged (the failure path in
`run.ts`, the eval's propagation, and the `workflow_phase_completed` telemetry
with its `error` outcome). The repair turn sets the caps through the child's
env rather than by overriding a config object.

Two honest limits. `ctx.abort()` is not instant — the current tool call may run
to completion, so a hung `bash` in `slack-responder` is still only killed by the
worker deadline; the two caps do not replace it. And the extension's live
accumulator differs from `get_session_stats()` because the latter includes
compaction and nested tool usage: use the accumulator to *enforce* and the stats
total to *report*. JSON-mode exit status is not a success signal at all, so
`errorSubtype` is always derived from events, never from an exit code.

## Measurement, and why the eval cannot carry this alone

The eval is the instrument, and it is itself under migration, which is the
sharpest process risk in the plan. The facts:

- `delegate/review/eval/dispatch.ts:10` allows a candidate branch to change
  exactly two files, and `:163-173` requires the two copies to be identical
  outside literal text. A harness migration violates that in at least five
  independent ways — the import, the tool list, the config keys, the subagent
  definitions, and the runtime, which a dispatched run takes from `main`. The
  last one is fatal and is not about the diff check at all: the dispatched
  harness measures *prompt text on main's runner*, so a migration PR would
  silently measure `main`.
- `replayKey` hashes `delegate/agents`, `delegate/framework`, `delegate/review`
  and `package-lock.json` (`eval/cache.ts:26-33`), so P1 invalidates the cache
  and P9 invalidates it again. Each invalidation is a cold `main` replay, ~$69
  (core) to ~$170 (37 cases × 3 runs), with the PR side doubling it.
- **Decided here: `CANDIDATE_FILES` is not widened.** That allowlist is what
  makes an unattended, credentialled, budget-capped loop safe to run against
  candidate code; widening it to `delegate/framework/` would let a candidate
  edit the thing that writes its own results.

The two legitimate instruments instead are (1) `delegate eval` on a
**human-authored** PR, where the PR head's agent replays and `main`'s code
scores, with `--mode gate --final`; and (2) a local arms harness for structural
A/B. The second is not on `main` today — it exists on a branch as PR #488 —
so **merging it is a prerequisite for P6**, and that is listed as an open
question rather than assumed.

Budget: roughly $600–900 of eval spend across the migration, scheduled as
calendar time (each round trip is ~30 minutes wall) rather than as engineer days.

Production signals to watch, named so they are not invented later: the
`review_failed` telemetry event, records with `action:"failed"` or `error` set,
`pr-reviewer` commit status `error`, `Delegate/Workflow:PhaseCompleted` split by
`outcome`, `PhaseCostUsd` split by `phase` and `outcome`
(`deploy/components/worker.ts:23-54`), ECS tasks hitting the 45-minute deadline,
webhook Lambda errors, and Slack threads left with `:eyes:` and no reply.

One more governance fact that shapes every PR boundary here: every path this
migration touches is human-owned. `.github/CODEOWNERS` owns `*` by default, and
`deploy/components/worker.ts`, `deploy/components/webhooks.ts`, `deploy/index.ts`,
`deploy/deploy.sh`, `deploy/delegate-secret.ts` and the two `ci-roles` files are
explicitly carved out so the reviewer cannot approve a change to its own harness.
So three rules: never bundle a human-owned infra change into an agent PR (one
carve-out file pulls the whole PR back and makes the reviewer comment rather
than approve); keep the dependency removal as one PR with a written rationale,
because splitting it produces commits that do not build; and do not add anything
to the opt-out list to make any of this mergeable.

## Effort

One engineer who knows the codebase, engineering days, excluding wall-clock
waiting for evals and deploys. **Attributed to the rollout report**, which is
where the numbers come from; they are estimates, not measurements.

| Block | Step | Days | Note |
|---|---|---|---|
| Spec | P0 | 1 | assembling the three reports into this document |
| Framework | P1 neutral contract + hook/tool/structured-output/subagent abstraction + git-tool split | 5 | the hardest engineering; the Claude path must stay byte-identical |
| | P2 attribution | 2 | touches the same file as P1, so sequenced |
| | P3 runner selection | 2 | |
| | **framework subtotal** | **9** | |
| Per-agent | P4 `tech-design-agent` | 2 | plus spill back into P1 fixes, expected |
| | P5 `epic-agent` + `epic-edit-agent` | 2 | the destructive path needs its own verification |
| | P6 `pr-reviewer` + both subagents | 10 | 4 code, 4 eval campaign, 2 canary + `enforce` flip |
| | P7 `task-execution-agent` | 2.5 | verify the prompt-only `WRITE_REPOS` guard still refuses |
| | P8 `slack-responder` + skills/MCP/context-file | 3.5 | |
| | **per-agent subtotal** | **20** | |
| Decommission | P9 dependency, image, CI, docs | 2 | plus a 30-day soak that is not engineer time |
| | P10 runbook + rehearsed rollback | 1 | |
| | **decommission subtotal** | **3** | |
| | **Core total** | **32** | |
| | Contingency (~25%) | 8 | |
| | **Total** | **40** | range 36–46 |

Plus ~$600–900 of eval spend (§ "Measurement"). The single largest line is P6 at
10 days, and most of it is not coding: it is the measurement queue.

## Rollback

What is retained at each phase, and when rollback stops being possible.

| Phase | Rollback | Mechanism | Time | Stops being possible when |
|---|---|---|---|---|
| P1, P2, P3 | Revert PR | git revert + deploy | ~20 min | never (behaviour-neutral) |
| P4, P5, P7, P8 | Flip that agent's `runner` back to `"claude"` | one-line PR + deploy, or the earlier revert PR | ~15–20 min | at P9, when the driver and the dependency are gone |
| P6 | Flip back, plus the `pr-reviewer` status on affected shas is already pinned or `error`, so nothing silently approves | flag PR + deploy; optionally `shadow` first (one line, human-owned) | ~20 min | at P9 |
| P9 | Revert-merge the whole PR | rebuild + push + `pulumi up` | ~25 min plus one task to observe | **when the `ANTHROPIC_API_KEY` value is deleted** |

**Retained, deliberately:**

- The previous image tag (the ops commit) — **forever**. It is the fastest path
  back and the deploy script accepts an arbitrary image.
- `ANTHROPIC_API_KEY` **in the secret but undeclared**, until a soak ends.
  Undeclaring it is what makes the key inert — the task definition injects only
  declared keys — so "no Anthropic spend" is achieved without the irreversible
  act. Deleting the value is a separate security decision weeks later.
- The last `AGENT_VERSION` that ran Claude for each agent, recorded in this
  plan, so "which commit do we go back to" is a fact rather than a search.
- The S3 corpus, forever.
- **Nothing else.** Keeping a dead dependency or a dead Dockerfile line "for
  rollback" is not rollback; it is a second untested path.

Two caveats. Rollback is not instantaneous for in-flight work — a running task
keeps the image it started with, and a waiting Slack user sees nothing until the
deploy lands; for P6 the status on the sha is `pending`, so a rollback must be
followed by a `delegate review` comment to resolve it. And rollback of P2's
schema is not a rollback: old records have `harness: null`, and a revert
reintroduces the ambiguity for everything written during the window — keep the
field.

The decommissioning **order** is not the order the artefacts appear in, and it is
forced by `deploy/check-secret-keys.ts:43-57`: an *extra* key in the live secret
is a warning, a *missing* declared key is a hard exit 1. So: code first (all
agents on pi, flags deleted, no file imports the SDK); then remove
`ANTHROPIC_API_KEY` from `DELEGATE_SECRET_KEYS` while keeping the value live;
then the Dockerfile line; then the dependency and a regenerated lockfile; then
CI secrets only if the judge moved too; then the prose; then the `CLAUDE.md`
question; and last, weeks later, the secret value.

## Risks

The five that could derail the plan, mitigations included. The first three
appear in the PR body as the top three.

1. **Cost attribution silently breaks the migration's own success criterion.**
   pi computes cost from its catalog; this repo documents that pi's built-in
   Fireworks catalog under-reports by a third and patches it by hand, and
   documents the same failure one layer down where a missing pricing row logged
   every request at $0 with no error. The eval's cost ratio does not fail the
   gate on its own and the production metric reads one log field, so a wrong
   price makes pi look cheaper, the gate passes, and the error is invisible
   until someone reads a bill.
   *Mitigation:* pin the price source per harness in one place; reconcile one
   representative run of each harness against a billing line before trusting any
   cost ratio; treat a cost drop as suspicious.
2. **The reviewer is the merge authority and the eval cannot prove absence of
   false approves.** `enforce` is deployed and four Pulumi trees are unowned, so
   a missed finding is a merge with no human. The plan's own evidence bar for
   de-owning was recorded as not met for any of the four, and recall is
   unmeasured — there is no baseline false-approve rate to regress against.
   *Mitigation:* run the whole P6 window under `shadow`; gate the flip on the
   expected suite `--final` plus zero false approves on the holdout with counts
   recorded; leave the existing tripwire standing.
3. **`CLAUDE.md` is load-bearing and its replacement is a product decision in a
   tidy-up costume.** Three agents' prompts tell the model to read `CLAUDE.md`
   and `slack-responder` depends on the harness to *inject* it. Patch the prose
   without fixing loading and the agent quietly loses its repo instructions — no
   test, no metric, no error. In the other direction, pi loads context files by
   default, so the reviewer's prompt-injection defence becomes an explicit
   opt-out, and getting that backwards is a security regression no test
   currently catches.
   *Mitigation:* for the reviewer, the opt-out plus a fail-closed assertion in
   the same PR as the runner switch; for `slack-responder`, context loading is an
   explicit, tested part of P8; and the repo-wide `CLAUDE.md`→`AGENTS.md`
   question is decided once, here, rather than per agent.
4. **The measurement instrument is itself under migration, so "the gate is
   green" can become unfalsifiable.** The dispatch harness measures prompt text
   on `main`'s runner, the replay key hashes the framework and the lockfile, and
   the scoring code is `neverTouch` for the hill-climb. A PR that changes both
   the runner and the eval plumbing can end up comparing two instruments and
   calling it a result.
   *Mitigation:* land the local arms harness first and use it for structural
   A/B; keep every eval-scoring change in its own PR with its own green gate; a
   single PR never changes both what is measured and what measures it; record the
   replay key on every reported result.
5. **The seam gets the security boundary slightly wrong and the reviewer can
   read the worker's credentials.** The path guard exists because
   `/proc/<ppid>/environ` is a regular file to the read tool, and the env
   allowlist exists because the worker's env is the whole secret bundle. Both are
   expressed in the current harness's hook shape, and a port that gets a key name
   wrong — `file_path` vs `path`, a block that lands as a warning, a symlink not
   resolved — yields a reviewer that reads the GitHub App private key while every
   test stays green.
   *Mitigation:* keep all three guards as one named contract with the *same*
   adversarial test cases run against both drivers; add a test that an outside
   path and a `/proc/self/environ` read are **denied**, not merely unpermitted;
   diff the child's env handoff against the allowlist key by key.

## Open questions needing an engineer's decision

Listed explicitly rather than buried in the text, because each one blocks work.

1. **Where do the models come from?** Delegate's task role has no `bedrock:*`
   grant and reaches models only through `ANTHROPIC_API_KEY` over the internet.
   pi needs a provider decision: Fireworks direct (as `agent-swarm` does), a
   Bifrost virtual key (as `gp-pi` does), or Bedrock (which needs new IAM in a
   human-owned file). This gates the whole eval, because nine workflow steps
   currently get `ANTHROPIC_API_KEY` and need a new credential story before the
   eval runs at all.
2. **Does the judge move off Anthropic?** The eval's blind judge posts directly
   to `api.anthropic.com` (`delegate/review/eval/judge.ts:56-80`), and the judge
   model and rubric are frozen for hill-climb purposes. The judge and the agent
   are separate decisions: if the judge stays, `ANTHROPIC_API_KEY` stays in CI
   and the "remove every Anthropic surface" goal is only half reachable. Changing
   the judge is a hill-climb governance change, not a migration detail.
3. **Does `subagentCalls` survive, and what happens if it does not?** If per-call
   attribution cannot be reproduced on pi, the expected suite loses its
   lead-attribution diagnostic. Acceptable or not is a decision before P6, not a
   discovery during it.
4. **Is the local arms harness (PR #488) merged before P6 starts?** Structural
   A/B depends on it. Without it the reviewer migration has only the blunt
   instrument, and risk 4 gets worse.
5. **Repo-wide `CLAUDE.md` → `AGENTS.md`, or a symlink?** Decide once, here.
   `pr-reviewer-subagents.ts`'s wording changes are literal-only changes in a
   candidate file and therefore measurable; the other agents' wording has no
   instrument and needs a human review that says so.
6. **What happens to `.claude/skills/hill-climb`?** It is read by the gp-pi
   container through an out-of-repo compatibility extension, not by any ops code.
   Moving it to a pi-read path would start shipping it in the image; leaving it
   keeps a `.claude` directory in a repo whose harness no longer reads `.claude`.
   Either is defensible; silence is not.
7. **Does `deploy/components/worker.ts` need an IAM or egress change?** It is
   human-owned, and today the task role carries no model-provider grant. If the
   answer to question 1 is Bifrost or Fireworks, it stays out of scope; if it is
   Bedrock, this becomes a human-owned infra change with its own PR.
8. **`permissionMode` per agent.** The workflow agents *need* write and bash;
   the reviewer must not have them. pi has no equivalent default, so the posture
   is re-decided per agent in the plan rather than inherited.

## What this document could not verify

Stated so the plan's confidence is legible, in the reports' own terms.

- **No code was run.** `node_modules` is absent in the sandbox: no `npm test`,
  no image build, no pi process against a real model. Everything about pi is
  read from pi 1.5.0's docs and `dist/`.
- **The 326 MB figure** for the `claude-code` install is unmeasured. Eight
  platform binaries plus a global install make the removal real; the number
  needs an image build.
- **Whether the global `claude-code` install is even still needed** — no code
  path invokes a `claude` binary, so it looks like dead weight, but that needs a
  build without it to confirm.
- **Five pi behaviours** the design depends on are documented but untested here:
  in-process subagent result handoff, tool-call-time blocking with argument
  mutation, a JSON-schema structured answer via a terminating tool, resumable
  sessions for the repair turn, and whether a throw from a start-up handler is a
  reliable fail-closed. Each already has a spike in the capability design; they
  are for the implementation PRs, not for this one.
- **Whether pi's provider module accepts GoodParty's actual endpoints and model
  ids** without a gateway change. This is the first spike, because nothing else
  can be tested end to end until it is settled.
- **No part of the plan rests on a missing report.** All three investigations
  completed and their reports were read in full. This document is the merge of
  them; where they disagreed the allocation is visible in the text (for example,
  the inventory classifies subagents as an architecture change, and the rollout
  report sequences it inside P6 rather than as its own step — this document
  follows the rollout report, because scout and deep-reviewer cannot migrate
  separately from `pr-reviewer`).

## Postscript: why not simply keep both harnesses

Worth recording as a rejected option, because it is the cheapest-looking one.

**Rejected: leave delegate on Claude Code and use pi only where it already is.**
It is rejected because the two motivations that survive cost analysis are
durability ones. Two harnesses in one repo means two credential models, two
model-catalog patches and two skills conventions, forever — and the repo already
carries the pi catalog patch (`agent-swarm/host/global-setup-script.sh:186-198`)
and the Bifrost pricing workaround (`docs/bifrost-fireworks-model-metadata.md`)
that exist precisely because two systems disagree about what a token costs. It
also means the per-agent model seam stays inside one vendor, which is the thing
this migration exists to change.

**Rejected: a flag day.** Discussed above: six agents, two subagents, one image,
no per-agent release channel. A flag day requires all of them perfect at once and
makes the reviewer — the merge authority — the first thing to change.

**Rejected: a per-dispatch runner override.** Trivial to build (`dispatch.ts`
already overrides per-task env) and refused for the reason given under
"Coexistence": it moves a migration switch into human-owned security-carve-out
files and makes "which harness ran?" unauditable from git.

---

# Appendix: the exhaustive Claude-Code inventory

The working checklist for the migration, ordered by file. Completeness matters
more than brevity here. **T** = trivial to remove (delete or re-string, no
replacement behaviour); **R** = needs replacement (mechanically different, same
behaviour); **A** = needs an architecture change (a property the current design
depends on that pi does not have in the same form).

Verified on `main` at `ab7aed8`. Scale: 51 tracked files match `claude|anthropic`,
~154 matching lines, of which the load-bearing set is small — `package.json`,
`delegate/framework/{types,agent,subagent-calls,mcp}.ts`,
`delegate/review/{run,git-tool}.ts`, `delegate/review/eval/replay.ts`,
`delegate/agents/*`, `delegate/worker/Dockerfile`, `deploy/delegate-secret.ts`,
and the eval workflows. The rest is prose, model-id strings, fixtures, or
unrelated Bedrock model ids.

## `package.json`, `package-lock.json`

- [ ] **R** `package.json:20` — `"@anthropic-ai/claude-agent-sdk": "^0.3.310"`. Removal breaks `tsc` over everything under `delegate/` that names it, which breaks `npm run build`, which breaks the image — so it goes last.
- [ ] **T** `package-lock.json:12` — the root entry mirroring it; regenerate the lockfile rather than hand-editing.
- [ ] **R** `package-lock.json:47-70` — the SDK node with **`optionalDependencies` on 8 platform packages (56-63)**. This is where the Claude Code CLI binary actually comes from at install time, so removing the Dockerfile line alone does not remove the CLI.
- [ ] **T** `package-lock.json:71-174` — the 8 platform package nodes.
- [ ] **T** `package-lock.json:175-194` — `@anthropic-ai/sdk@1.3.0`, `peer: true`, present only because the SDK declares it.
- [ ] **A** `package-lock.json:67` and `:2428` — `@modelcontextprotocol/sdk@1.32.2`, also a peer, pulled in **only** by the agent SDK. The MCP story must be settled before removal or `framework/mcp.ts`'s grafana server loses its SDK. This is a real dependency-ordering finding.
- [ ] `.github/dependabot.yml:10-24` — only `docker` ecosystems; no npm entry, so the SDK was never even tracked. Nothing to remove, but no automatic bump would ever have flagged it.

## `delegate/worker/Dockerfile`

- [ ] **T** `:5` — `RUN npm install -g @anthropic-ai/claude-code`, unpinned. Nothing in the repo invokes a `claude` binary (no `claude ` in any prompt, no `execFileSync("claude")`, no `pathToClaudeCodeExecutable`). **Verify by building without it** before claiming the removal.
- [ ] **R** `:12-15` — the Superpowers clone into `/app/plugins/superpowers`, described as a Claude Agent SDK plugin. It becomes a pi package; the pinned clone stays, the comment changes.
- [ ] `:10` — `COPY dist/delegate/` stays.
- [ ] `.dockerignore:4` — `.claude` excluded from the build context. **T** only once nothing in the repo needs the compatibility path (see `.claude/skills` below).
- [ ] `.github/workflows/deploy.yml:129-131` — the only build path for the worker image; unchanged, but it is the check that proves either removal.

## `delegate/framework/types.ts` — the whole type leak

- [ ] **A** `:1` — `import type { HookCallback, Options }`. The single place the SDK's types enter delegate's own surface; everything below is downstream.
- [ ] **R** `:3` — `McpServerConfig = NonNullable<Options["mcpServers"]>[string]`. Can become a local shape; the `{command,args,env}` literal in `mcp.ts` is already portable.
- [ ] **R** `:14` — `AgentConfig.mcpServers`.
- [ ] **R** `:18` — `permissionMode?: Options["permissionMode"]` — Claude permission modes.
- [ ] **A** `:19` — `agents?: Options["agents"]` — Claude's subagent-definition map.
- [ ] **R** `:20` — `plugins?: Options["plugins"]` — the Superpowers loader.
- [ ] **A** `:21` — `settingSources?: Options["settingSources"]` — the CLAUDE.md auto-load switch, whose default inverts on pi.
- [ ] **R** `:22` — `tools?: Options["tools"]` — Claude built-in tool names.
- [ ] **R** `:23` — `outputFormat?: Options["outputFormat"]` — the structured-output mode with no pi equivalent.
- [ ] **R** `:31` — `preToolUseHooks?: HookCallback[]` on `RunOverrides` — becomes a `tool_call` handler type.
- [ ] **R** `:34` — `resume?: string` — becomes an opaque session handle.
- [ ] **R** `:52-62` — `AgentResult`'s SDK-shaped fields: `sessionId`, `costUsd` (from `total_cost_usd`), `structuredOutput`, `errorSubtype`. The interface survives; three fields change meaning.
- [ ] **R** `delegate/framework/index.ts:6-12` — re-exports `McpServerConfig` as public API, so `eval/replay.ts:7` and `framework/mcp.ts:1,13` consume the SDK type indirectly.
- [ ] **R** `delegate/framework/mcp.ts:13` — `satisfies Record<string, McpServerConfig>`.

## `delegate/framework/agent.ts` — the execution engine

- [ ] **R** `:1` — `import { query }`, the only runtime entry point to the SDK.
- [ ] **A** `:11-41` — `forceSynchronousTaskHook`, the background-`Task` fix. Deleted with `Task`; its *purpose* moves to "the subagent tool has no background mode".
- [ ] **A** `:64-103` — the `query()` options block: `systemPrompt`, `model`, `mcpServers`, `env`, `tools`, `outputFormat`, `agents`, `plugins`, `settingSources`, `allowedTools`, `maxTurns`, `maxBudgetUsd`, `permissionMode`, `cwd`, `hooks`, `stderr`.
- [ ] **A** `:92-93` — `maxTurns ?? 50`, `maxBudgetUsd ?? 5`. No pi equivalent; must be built.
- [ ] **T** `:94` — `permissionMode: "bypassPermissions"` — no equivalent and not needed in a non-interactive mode.
- [ ] **R** `:104-122` — `system/init` → `sessionId`, MCP connect/fail logging.
- [ ] **R** `:124-184` — per-assistant turn logging and `recordSubagentUses`.
- [ ] **R** `:186-209` — `recordSubagentResults` from `tool_result` blocks.
- [ ] **R** `:211-268` — `result` → `output`, `costUsd`, `turns`, `structuredOutput`; non-success → `errorSubtype` and phase telemetry.
- [ ] **T** `:101` — the `[claude stderr]` log prefix.
- [ ] **R** `:146-173` — per-tool log summaries keyed on `Bash`/`Read`/`Grep`/`Glob`/`Edit`/`Write`, the `mcp__` prefix, and `subagent_type`/`run_in_background`.

## `delegate/framework/subagent-calls.ts`

- [ ] **A** `:12-13` — `SUBAGENT_TOOLS = Set(["Task","Agent"])`, with the comment that the SDK renamed the tool.
- [ ] **A** `:15-36` — pairing `tool_use`/`tool_result` by id to produce `SubagentCall`. Feeds `AgentResult.subagentCalls` → `replay.ts` lead tracing. Replace with the tool's own `details`; if this cannot be reproduced, the eval loses its lead diagnostic (open question 3).

## `delegate/review/run.ts`

- [ ] **R** `:5` — `import type { HookCallback }`.
- [ ] **R** `:42-62` — the env allowlist, with `ANTHROPIC_API_KEY`/`BASE_URL`/`MODEL` and the `CLAUDE_`/`DISABLE_` prefixes. Repoint at pi's needs, keep it an allowlist. Pinned by `run.test.ts:176-209`.
- [ ] **A** `:74-110` (+ installs at `:657`, `:690`) — `pathGuardHook`, the reviewer's filesystem boundary, re-expressed as a `tool_call` handler with denial counting and a fail-closed test.
- [ ] **R** `:302-345` — `parseReviewOutput` fed from the terminating tool instead of `structured_output`; the prose-scanning fallback (`:150-175`) deleted only after the eval shows it unused.
- [ ] **A** `:674-712` — the repair turn, re-expressed as a second `prompt` on the same session.
- [ ] **R** `:663-666` — `fail()` on `errorSubtype`, which needs the closed `RunnerError` enum to keep working.
- [ ] **T** `:42-45` — the "Claude Code subprocess" comment, rewritten to describe the new boundary (this is the comment the whole credential argument rests on).
- [ ] **T** `:751` — "Identity is the harness's job" — already harness-neutral, survives.

## `delegate/review/git-tool.ts` and `git-tool.test.ts`

- [ ] **R** `:2` — `import { tool, createSdkMcpServer }`; `tool(` at 48, 67, 82, 101; `createSdkMcpServer(` at 120.
- [ ] **T** `:12-18` — `isSafeRef`/`isSafePath`. Keep verbatim; they were never SDK-specific.
- [ ] **R** `:5-10` — `GIT_TOOL_NAMES`, the four `mcp__git__…` strings, which are also baked into `pr-reviewer.ts:237` and `pr-reviewer-subagents.ts:81,142`. The rename must be one change, or a prompt names a tool that does not exist.
- [ ] **R** `git-tool.test.ts:7,61-70,72-88` — imports both, and asserts `server.type === "sdk"` / `server.instance`, which is an SDK shape.

## `delegate/agents/pr-reviewer.ts`

- [ ] **A** `:14-52` — the model-facing schema, `toSupportedDialect` (`:46-58`), and the draft-07 choice (`:50`). The flat object stays; the dialect rewriting goes.
- [ ] **T** `:15` — the "StructuredOutput is a tool" comment.
- [ ] **T** `:32-37` — the "Anthropic's structured-output grammar" comment.
- [ ] **R** `:214` — `model: "claude-opus-5-5"`.
- [ ] **R** `:215` — `agents: prReviewerSubagents`.
- [ ] **R** `:216-217` — `maxTurns: 80`, `maxBudgetUsd: 10`.
- [ ] **R** `:218-229` — `tools: ["Read","Grep","Glob","Task","StructuredOutput"]` and the matching `allowedTools`.
- [ ] **R** `:230` — `outputFormat: { type: "json_schema", ... }`.
- [ ] **T** `:237` — the prompt's tool list, including the `mcp__git__…` names.
- [ ] **R** `:253-266` — the Phase 1/Phase 2 "send all Task calls in a single message" protocol, rewritten for the subagent tool.
- [ ] **R** `:191-210` — `buildRepairPrompt`, whose "do not call any tools" rule assumes the loop can be resumed.
- [ ] **R** `:303` — "Never guess around a missing subagent result" (survives in spirit; the detection changes).

## `delegate/agents/pr-reviewer-subagents.ts`

- [ ] **R** `:2,34` — `NonNullable<AgentConfig["agents"]>`, the SDK-shaped definition type.
- [ ] **R** `:81` — scout `tools: ["Read","Grep","Glob", ...GIT_TOOL_NAMES]`.
- [ ] **R** `:82` — scout `model: "claude-sonnet-5-5"`.
- [ ] **R** `:142` — deep-reviewer `tools`; **R** `:143` — its `model`.
- [ ] Keep, do not over-delete: `:51,52,98,110,112` name `CLAUDE.md` as a *document to read* in other repos, which stays true. Only the `AGENTS.md` question (open question 5) touches these, and that is a measurable literal-only change.

## The other five agents

- [ ] **R** `slack-responder.ts:159-161` — grafana MCP attachment.
- [ ] **R** `slack-responder.ts:162-172` — `plugins: [{ type: "local", path: ... }]`, the only `plugins` use in the repo.
- [ ] **A** `slack-responder.ts:173-181` — `settingSources: ["project"]`, plus its comment; the CLAUDE.md loading switch, which becomes pi's default.
- [ ] **T** `slack-responder.ts:179` — the `.claude/settings.json` comment.
- [ ] **R** `slack-responder.ts:16` — the prompt's "Skill tool" and `superpowers:` namespace.
- [ ] **R** `slack-responder.ts:185-186` — 80 / $15 caps.
- [ ] **R** `slack-responder.ts:187` — `claude-opus-5-5`.
- [ ] **R** `task-execution-agent.ts:195`, `tech-design-agent.ts:138`, `epic-agent.ts:132`, `epic-edit-agent.ts:125` — `claude-opus-5-5`.
- [ ] **R** `tech-design-agent.ts`, `epic-agent.ts`, `epic-edit-agent.ts` — their `maxTurns`/`maxBudgetUsd` pairs.
- [ ] **A** `framework/repos.ts:11-16` — the comment specifying how to add a runtime `WRITE_REPOS` gate via a `PreToolUse` hook; that design assumes the old hook API, and the guard is still prompt-only.
- [ ] `task-execution-agent.ts:189` — names `CLAUDE.md` as a repo doc. Keep.

## `delegate/review/eval/`

- [ ] **R** `replay.ts:4` — `import type { HookCallback }`.
- [ ] **R** `replay.ts:323-339` — `replayToolGuard` and `REPLAY_TOOLS` (`:326`), the eval's read-only enforcement.
- [ ] **R** `replay.ts:266-275,307-308,344-345` — the `runAgentImpl` injection signature (which is also the proof the seam can carry two drivers).
- [ ] **R** `replay.ts:406,413,500-570` — subagent lead tracing on `subagentCalls`.
- [ ] **R** `replay.test.ts:8,687-712` — fake hook events and the guard's allow/deny sets.
- [ ] **R** `replay.test.ts:703-712` — asserts Claude-shaped `tools`/`allowedTools` on `AgentConfig`.
- [ ] **T** `replay.test.ts:21,500-570` — `SubagentCall` fixtures (break only if the trace is rebuilt).
- [ ] **A** `cache.ts:23-26` — the replay key's comment and inputs; the *reason* changes even though the hash stays correct.
- [ ] **R** `judge.ts:6` — `DEFAULT_JUDGE_MODEL = "claude-sonnet-5-5"`; `:56-80` — the raw Anthropic HTTP call; `:61-62` — reads `process.env.ANTHROPIC_API_KEY`.
- [ ] **R** `cli.ts:328,343` — the judge model default and `createAnthropicJudgeModel`.
- [ ] **T** `dispatch.test.ts:125` — the `SRC` fixture containing the SDK import; `:126,142` — `claude-sonnet-4-5` / `claude-opus-4-1`; repoint so the test is not documenting a dependency that no longer exists.
- [ ] **T** Fixture model ids only: `cases.test.ts:20`, `judge.test.ts:17`, `mine.test.ts:30`, `store.test.ts:25`, `run.test.ts:122,593` (break only if `ReviewRecord.model` gains an enum).
- [ ] `workflow.test.ts:9-130` — not broken, but it asserts the eval workflow's job/security structure, so any edit to `delegate-eval-run.yml` must keep it green.
- [ ] **A** `dispatch.ts:10,51-60,163-173` — not a Claude surface, but it is the reason this plan cannot be carried by the hill-climb loop. Do not widen `CANDIDATE_FILES`.

## Tests that break, and why

- [ ] **R** `framework/agent.test.ts:1-42` — entirely `forceSynchronousTaskHook`: asserts `hook_event_name: "PreToolUse"`, `hookSpecificOutput.updatedInput`, and `subagent_type`/`run_in_background`.
- [ ] **A** `framework/subagent-calls.test.ts:1-107` — asserts SDK content-block shapes and the `Task`/`Agent` naming.
- [ ] **R** `review/run.test.ts:176-209` — the `agentEnv` allowlist, including the `CLAUDE_CODE_MAX_OUTPUT_TOKENS` prefix case. **Rewrite, do not delete**: it is a credentials test and load-bearing.
- [ ] **A** `review/run.test.ts:211-238` — `pathGuardHook` called directly, reading `hookSpecificOutput.permissionDecision`.
- [ ] **R** `review/run.test.ts:346-360` — the schema-failure rule via the SDK's `structuredOutput` path.
- [ ] **R** `agents/pr-reviewer.test.ts:286-346` — four tests pinning draft-07, the flat object, and `anyOf`-not-`oneOf`.
- [ ] **R** `agents/pr-reviewer.test.ts:485-495` — `buildRepairPrompt` assertions; survive only if the repair turn does.
- [ ] **R** `deploy/delegate-secret.test.ts:25,28` — uses `ANTHROPIC_API_KEY` as the exemplar of a missing declared key; repoint it.
- [ ] Not broken (verified by search): `review/{anchors,gates,gating,body,match,bundle,prompt-diff,github,codeowners}.test.ts`, `framework/{repos,thread-state}.test.ts`, `lambdas/*.test.ts`, `worker/github-auth.test.ts`. In `codeowners`/`gating` tests, `CLAUDE.md` appears only as a CODEOWNERS path sample.

## Outside `delegate/`

- [ ] **R** `deploy/delegate-secret.ts:15-16` — `"ANTHROPIC_API_KEY"` in `DELEGATE_SECRET_KEYS`. Removing it changes the task definition's `secrets` list, so it is a reviewed `pulumi up`; and per `check-secret-keys.ts:43-57` it must come out of the *declared list* while the value stays live.
- [ ] **R** `deploy/components/worker.ts:226-249` — the agent container's `environment` and `secrets`; where a pi harness's model alias and gateway URL/credential land.
- [ ] **A** `deploy/components/worker.ts:23-54` — the two metric filters, `workflowPhaseCost` reading `$.costUsd`. If the new harness's log line stops carrying that field, `PhaseCostUsd` silently drops to zero: an alerting-shaped failure, not a compile error.
- [ ] **T** `deploy/components/worker.ts:240` — `DELEGATE_GATING_MODE=enforce`, to be set to `shadow` for the P6 window and back afterwards (two small human-owned PRs).
- [ ] **A** `deploy/components/worker.ts:56-208` — the task role. There is **no `bedrock:*` grant**, so delegate reaches models only via `ANTHROPIC_API_KEY` over the internet. A pi harness pointed at Bedrock or Bifrost needs an IAM or egress decision (open question 1).
- [ ] **R** `deploy/index.ts:31,35-37` — `DELEGATES` secret name, `workerImageUri`, `secretKeys` wiring.
- [ ] `deploy/deploy.sh:71` — accepts an arbitrary image URI; this is what makes rollback a 20-minute operation and is why no phase before P9 is one-way.
- [ ] **T** `delegate/.env.example:7-8` — the `# Anthropic` line and `ANTHROPIC_API_KEY=`.
- [ ] **T** `.github/workflows/delegate-eval.yml` — **20 lines** matching `ANTHROPIC|CLAUDE_CODE`: the key presence pre-check (`:76-91`, which fails the eval before it starts if the secret is missing), 6 `CLAUDE_CODE_DISABLE_*` pairs (`:257-258,353-354,428-429,548-549,634-635,752-753` — 12 lines), and 9 `ANTHROPIC_API_KEY: ${{ secrets... }}` lines feeding replay and judge steps. Keep the secret if the judge stays (open question 2).
- [ ] **T** `.github/workflows/delegate-eval-run.yml` — **9 lines**: 3 `CLAUDE_CODE_DISABLE_*` pairs (`:249-250,368-369,515-516`) and 3 `ANTHROPIC_API_KEY` lines.
- [ ] **A** `deploy/components/ci-roles.ts:233-269` and `ci-roles/policies.ts:480-500` — the three eval roles and their `job_workflow_ref` pins. Not Claude-specific, but they must be able to reach whatever endpoint replaces Anthropic, and they are human-owned.
- [ ] `.github/CODEOWNERS:163-177` — every path in this inventory needs a human on `@thegoodparty/gp-contrib`; the seven carve-out paths are re-owned specifically so the bot cannot approve its own harness change.
- [ ] `.github/CODEOWNERS:57,60` — mentions `/CLAUDE.md` and `**/CLAUDE.md` as *paths* in the opt-out history. Leave.
- [ ] `scripts/`, `utils/` — nothing. Only Bedrock model ids (`utils/bedrock-models.ts:83-121`), which survive untouched.
- [ ] **Context, not a dependency:** `agent-swarm/` already runs pi (`host/render-env.sh:102`, `host/docker-compose.yml:39,44`, `host/scripts/fireworks-residency.test.ts:272-273`) and is the in-repo precedent for how a pi harness is wired. Worth reading before implementing P1.

## `.claude/` in this repository

- [ ] `A` `.claude/skills/hill-climb/SKILL.md` and `.claude/skills/hill-climb/targets/delegate-pr-reviewer.json` — tracked, read by the gp-pi container through an out-of-repo compatibility extension, **not** by any ops code and **not** by the Fargate worker (`.dockerignore:4` excludes `.claude`). Cannot be deleted without breaking the hill-climb workflow for pi users; moving it into a pi-read path would start shipping it in the image. Open question 6.
- [ ] `T` `.claude/skills/hill-climb/SKILL.md:15` — instructs reading `targets/<target>.json` by literal path; if the directory moves, this line moves with it.

## Documentation, and which sentences go wrong

- [ ] **T** `CLAUDE.md:14` — "powered by Claude Agent SDK".
- [ ] **T** `CLAUDE.md:143` — the architecture diagram's "Claude Agent SDK".
- [ ] **R** `CLAUDE.md:148` — the MCP config description (still true, different mechanism).
- [ ] **T** `CLAUDE.md:149` — "`slack-responder` using claude-opus-5-5"; also stale in a second way, since there are six agents now, not one.
- [ ] **A** `CLAUDE.md:153` — the reviewer's security paragraph: "only Read/Grep/Glob … and a **PreToolUse hook** that denies any file path outside the checkout". **Actively misleading until rewritten**, because the mechanism is what enforces the claim.
- [ ] **T** `CLAUDE.md:155` — the Superpowers/`plugins`/`Skill`/`allowedTools` bullet, entirely SDK-specific.
- [ ] **A** `CLAUDE.md:156` — the isolation/`settingSources`/CLAUDE.md bullet, wrong in both directions after the move.
- [ ] **T** `README.md:33,41` — "powered by Claude Agent SDK" and the diagram line.
- [ ] **T** `delegate/README.md:3` — the first sentence.
- [ ] **R** `delegate/README.md:99` — "how to add a runtime `PreToolUse` hook".
- [ ] **T** `delegate/README.md:122,126` — the two "Agent (opus)" diagram labels.
- [ ] **R** `delegate/README.md:179` — the operator instruction "tune `maxBudgetUsd`", which becomes unactionable until the cap is rebuilt.
- [ ] **T** `delegate/review/eval/README.md:14,22,85,130,161,182-183` — the cost model, the secret, the judge model, and the replay tool list (`Read, Grep, Glob, Task/Agent, StructuredOutput`).
- [ ] **A** `docs/plan-gated-merges.md:378` — the reviewer row states the schema renders the union as `anyOf` "because that is the keyword Anthropic's structured-output dialect supports". A **merged spec**: do not edit its checklist, but the technical claim becomes false, and a plan amendment is the honest route.
- [ ] **T** `docs/pr-previews.md:123` — "It fetches every value in the secret (**Anthropic key**, …)", an example list that goes stale.
- [ ] `docs/pr-previews.md:282` — instructs updating `CLAUDE.md` for an unrelated change; unaffected, listed because it is the same file being edited.
- [ ] `docs/bifrost-gateway.md:37,303,311,1081` and `docs/bifrost-virtual-keys.md:31` — "Claude Code / pi (Anthropic shape)", "a key per tool — one for pi, one for Claude Code". About the gateway's clients, not delegate: accurate, but one example retires if Claude Code is retired everywhere.
- [ ] `docs/archived/bifrost-zero-downtime-deploys.md:834` — archived; leave.

## Do not touch: `claude`/`anthropic` that is not this dependency

Listed so an exhaustive sweep does not over-delete: `utils/bedrock-models.ts:83-121`,
`deploy/bedrock-models.test.ts:49-54,111`,
`deploy-workbench/bifrost/{config.json:93-98,vk-mint-template.json:8-13,governance-overrides.json:20,config.test.ts:169-174}`,
`deploy-workbench/ecs.test.ts:1613`, the `governance-*`/`vk-*` fixtures,
`deploy-workbench/ingress.ts:168` and its test (the `/anthropic/*` path prefix),
`docs/workbench-account.md`, `docs/bifrost-*.md`,
`delegate/review/gating.ts:247-248` and `gating.test.ts:164-187` (a CODEOWNERS
glob), `delegate/review/codeowners.test.ts:87`, and the `CLAUDE.md` string inside
`delegate/review/eval/expected/ops-plan-amends-itself.bundle.json:18` — that one
is inside a replayed plan's text, and editing it changes an eval case.
