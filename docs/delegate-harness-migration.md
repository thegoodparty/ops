# An agnostic call shape for `delegate`: `runAgent` on the Vercel AI SDK

> This changes no code. It records the decision to remove the Claude Agent SDK and the `claude-code`
> CLI from `delegate/` and put `runAgent` on the [Vercel AI SDK](https://ai-sdk.dev) — `ai` 6.x plus
> the `@ai-sdk/*` provider packages — the steps that do it, and the evidence each needs. The SDK is
> in-process, its call shape is provider-neutral, and it lets the reviewer mix providers inside a
> single run. Where this makes a call of its own it says **decided here** and gives the reasoning, so
> review can argue with the reasoning.
>
> Verified against `main = 7ccb6a6`, the AI SDK docs at `ai-sdk.dev`, the `ai` 6.0.209 tarball, and
> `@ai-sdk/anthropic` 3.0.86 — the versions `omni` resolves — plus the `@ai-sdk/amazon-bedrock` and
> `@ai-sdk/fireworks` provider documentation, and `omni` at its current `main`. **Nothing here was run
> against a model.** The size figures come from `npm ci` / `npm install -g` on a scratch tree and
> from the lockfile, not from an image build. Every `path:line` was re-read while writing, and the
> commands that regenerate the inventory are in this document rather than an appendix, because the
> previous appendix went stale twice. Four things about the AI SDK path could not be checked at all
> and are listed at the end, unasserted: cross-provider `prepareStep` over a shared history,
> `Output.object` on Fireworks and on Bedrock's JSON-tool fallback, whether a major `ai` bump stays
> behind `runAgent`, and whether the library respects the child process's allowlist.
>
> **What changed since the first version.** Four of its eight per-agent phases described deleted
> agents (#500, `03ed677`, 29 files); the `PhaseCostUsd` metric three of them gated on went with
> them; the arms harness it required merged (#488); and five of its claims about pi were wrong, one
> of them backwards on a security control.

## The decision, and how much is left

`delegate` runs one agent through the Claude Agent SDK: `query()` (`delegate/framework/agent.ts:1`),
backed by a globally installed `@anthropic-ai/claude-code` that nothing resolves
(`delegate/worker/Dockerfile:4`), with SDK types in `delegate`'s own API surface
(`delegate/framework/types.ts:1`).

**"Fully replaced" means exactly this**: no file imports `@anthropic-ai/claude-agent-sdk`, no image
installs `claude-code`, no SDK type appears in `delegate`'s API, no `CLAUDE_*`/`ANTHROPIC_*`
variable reaches an agent, and no Claude-specific key is declared for the worker task — checkable
by the greps under "Load-bearing surface".

**The goal is an agnostic call shape, not an agnostic harness.** `runAgent` stays the one seam, and
under it the call layer is provider-neutral: a `provider(modelId)` expression evaluates to a
`LanguageModel` value that is passed into the call, so which vendor answers is an argument rather
than a property of the runtime. The end state is not "delegate runs some other CLI"; it is that
`delegate` has no harness vendor to name. One provider is chosen per model, and per step when a step
should use a different one.

**One agent and two subagents, not a fleet.** `delegate/agents/index.ts` imports only
`./pr-reviewer`; `delegate/worker/entrypoint.ts:44` refuses any other agent name at boot; the
webhook Lambda has one route (`delegate/lambdas/handler.ts:18-20`). So the migration is
`pr-reviewer` and its three subagents — `scout`, `architect` and `deep-reviewer`, the keys of
`prReviewerSubagents` (`pr-reviewer-subagents.ts`) — one seam, and the image. Everything else in
`delegate/` is already deterministic code.

**The record of the old argument, and why it was the wrong one.** The first two versions of this
document framed the goal as moving to an agnostic *harness*, and the argument for one stack in the
repo was "`agent-swarm/` already runs pi, so use pi"
(`HARNESS_PROVIDER=pi`, `agent-swarm/host/render-env.sh`). That was a consistency argument standing
in for an objective. The objective is provider portability, and a harness is the component that
makes a second provider hardest to reach — see the next section.

**Decided here: no compatibility flag and no `harness` field on `ReviewRecord`.** The old plan's
`AgentConfig.runner?: "claude" | "pi"` existed so a partially migrated fleet could run; there is no
fleet. An enum, a driver registry and a "which harness ran" audit story for one agent is pure cost,
and the rollback it buys is bought as well by `git revert` plus the previous image tag — always
addressable, because `workerImageUri` is a Pulumi value and ECR tags are the ops commit. For the same
reason there is no mixed corpus to keep joinable: `agentVersion` (`delegate/review/schema.ts`, set
from the image tag) already names the commit, and leaving `ReviewRecordSchema` untouched keeps old
records replayable as eval inputs.

## The architecture: the Vercel AI SDK, for provider portability

This replaces the section that weighed `pi --mode rpc` against `pi-durable`. Neither is taken.

### The AI SDK is the pick, and the reason is the objective, not the shape

An in-process SDK was the review's ask, and it is the right shape — but "in-process" is not what
decides between the candidates. The recorded objective does: **provider portability, with
anticipated within-run model mixing**. The AI SDK is the one candidate whose primary axis is
provider choice, and the only one with a first-class way to change model mid-run.

**Provider switching is the AI SDK's primary axis.** Its unit is `provider(modelId)` returning a
`LanguageModel` object that you pass into a call as the `model` argument. There is no catalog of our
own to correct and no global model registry to keep honest: you name the model and you own the price.
A provider package is imported, given a key, and is then interchangeable with any other.

**Within-run mixing is a first-class primitive there and absent from pi as a harness.** AI SDK 6's
`prepareStep` callback runs before each step and may return `{ model }`; its own documentation
example is "use a stronger model for complex reasoning after initial steps". The reviewer's actual
shape is exactly that: a cheap model over the read/grep grind, a strong one for the verdict. Under
pi one session takes one model, so mixing means stitching several sessions together, which the old
plan had no answer for. (pi is not entirely without routing: an extension can register a *virtual
model* whose `route()` picks a physical model per request. That is a router bolted on above the
session, configured through an extension, and it is still a harness. `prepareStep` is inside the call
we are already making, which is the difference between a capability and a workaround.)

**The portability claim is corroborated by workarounds `ops` already committed.** These are not
hypothetical costs; they are in the tree today:

- `agent-swarm/host/render-env.sh` — the comment on `LEAD_MODEL_OVERRIDE` / `WORKER_MODEL_OVERRIDE`
  explains that the provider id is `fireworks-us`, not the built-in `fireworks`, because pi *adds* a
  `models` entry to a built-in provider's catalog instead of replacing it, so only a separate
  provider id removes the global-id models from the picker. That is a provider-portability hack
  forced by pi's catalog shape.
- `agent-swarm/host/global-setup-script.sh` — a hand-maintained, hand-copied price block, because
  pi's catalog carries 0.3/1.2 for the `-1017` Fireworks entries and under-reports the US rate by a
  third.
- `docs/bifrost-fireworks-model-metadata.md` — a whole document about the gateway serving no model
  metadata for Fireworks, and about `gp-pi` mapping a missing price to `0`.

The old plan's `delegate/pi/models.json` was going to be the same correction again, repeated once
per future provider. Under the AI SDK there is no catalog to correct at all: the rate lives in
delegate's own table because it was always delegate's number to state, not because a harness got it
wrong.

### The org-consistency tension is real, and this plan chooses the org

The old plan had one stack-consistency argument — one harness in the repo rather than two, because
`agent-swarm/` runs pi. But `omni` uses the AI SDK heavily: `ai` at `^6.0.182` (resolving to
6.0.209) and `@ai-sdk/anthropic` at `^3.0.77` (`packages/gp-api/package.json`), behind one central
`LlmService` (`packages/gp-api/src/llm/services/llm.service.ts`) that uses `generateObject`,
`generateText`, `streamText`, `tool()`, `stepCountIs`, `prepareStep`, `toolChoice`,
`providerOptions.anthropic.cacheControl`, and an error taxonomy split on `NoObjectGeneratedError` /
`TypeValidationError` that is already load-bearing in
`packages/gp-api/src/chats/evals/judge/judge.ts`. So there are now two "one stack" goals pointing
different ways — one stack *in ops*, one stack *across the org* — and this plan chooses the org,
because the recorded objective is provider portability and the AI SDK is the stack the org has
already exercised for it.

The countervailing risks, stated here rather than discovered later:

- **Different repo, different runtime, different deploy.** `omni` is NestJS on Node 24; `delegate`
  is a plain ESM worker on Node 22 (`delegate/worker/Dockerfile`). Sharing a library is not sharing
  a stack, and nothing here reuses `omni`'s code — only its evidence.
- **`omni`'s integration is deliberately Anthropic-shaped.** `providerOptions.anthropic` and
  `provider.tools.webSearch_20250305` (`llm.service.ts`) mean "we already know this works" is proven
  for one provider and unproven for Fireworks or Bedrock.
- **`ai` is on its sixth major and seventh is already published.** A major bump rewrites the seam.
  That is not worse than pinning pi, but a pin does not make the problem go away for either
  candidate, and the plan should not pretend otherwise.

### `pi-agent-core` + `pi-ai` bare: dropped

It is the same pin as `pi createAgentSession` with less of it, and it grants nothing the AI SDK does
not. The lower-level packages would still be pi's catalog, pi's provider set and pi's single model
per session; adopting them buys the same pin with more of the work left to us and none of the
portability.

**A sentence this document used to contradict itself on.** The previous version said adopting
`@aantenore/pi-budget` would mean taking on "an SDK adapter for `pi-agent-core` — the one integration
this plan explicitly does not take". That phrase originated as a *reason not to adopt pi-budget*, not
as a statement about the architecture, and when commit `da296f5` dropped pi-budget the justification
went with it while the sentence stayed. It is named here because it is the same decay that made the
first version stale: a reason attached to a decision outlives the decision unless someone removes it.
`pi-agent-core` and `pi-ai` are therefore dropped because they buy nothing, which is a different
reason from the one that sentence used to give.

### The credential boundary is a process boundary, and the harness choice is orthogonal

`delegate/review/run.ts` states the requirement in the comment above `ENV_ALLOW_EXACT` (`run.ts:43`):
the worker's env is the whole `DELEGATES` bundle, and a read of `/proc/self/environ` would leak any
key the allowlist failed to name. Two things carry it — `agentEnv()` (`run.ts:65`) hands the child a
short allowlist, and the child is a **different process**, whose environ the read tool can only reach
by escaping the checkout, which the path guard stops (`pathGuardHook`, `run.ts:78`). Run the agent
in-process and both fail at once: `/proc/self/environ` is the worker's own environ, and no path guard
applies to it at all.

**Decided here: the agent runs in a spawned Node child with the explicit allowlist env.** This is not
an argument for a CLI harness — an SDK in a child process is still an SDK, and the review conceded
exactly this point. The asymmetry is what matters, and the reviewer's own `@`-strip finding shows a
guard bug of that shape is plausible rather than theoretical: a guard bug in the allowlisted child
reaches **the fourteen names in `ENV_ALLOW_EXACT`**, and a guard bug in the worker reaches **every key
the worker holds**. The isolation is bought by `spawn`, not by which library produced the tool calls.

What that costs, concretely: the child needs the review checkout, the allowlist and the provider key,
and its usage has to come back over a pipe. Everything else `runAgent` does — the tool list, the
loop, the budget counters, the repair turn — happens on our side of that pipe, in code this repo
tests.

## Three differences in kind that remain

Everything else in the old translation table was a rename.

### 1. Structured output is an object call, and the workaround goes away

`pr-reviewer.ts` sets `outputFormat` and includes `"StructuredOutput"` in `tools`, because that is a
built-in *tool* the harness routes the answer through; `structured_output` (`agent.ts:205`) is what
`parseReviewOutput` (`run.ts:303`) consumes. Under the AI SDK the call is direct: `generateText` with
`output: Output.object({ schema })`, or `generateObject` against the same schema, and the result is
the parsed object with usage beside it. There is no terminating tool to build and no second failure
class to reason about.

- **`ReviewOutputSchema` stays the authority.** It is what the object call is given and what
  validates the result, in-process, once.
- **`REVIEW_OUTPUT_JSON_SCHEMA` and `toSupportedDialect` go.** The `oneOf`→`anyOf` rewrite
  (`pr-reviewer.ts:38-52`) exists for one vendor's dialect and for a model-facing tool input schema
  that cannot carry a top-level union. Neither constraint survives: the provider package normalises
  the schema it sends — `@ai-sdk/anthropic`'s `sanitizeDefinition` maps `oneOf` to `anyOf` itself
  (verified in the 3.0.86 tarball) — and the object we need is the union `ReviewOutputSchema`
  already declares. The tests in the `REVIEW_OUTPUT_JSON_SCHEMA` describe block in
  `pr-reviewer.test.ts` — which pin draft-07, the flat object, and `anyOf` in place of `oneOf` — go
  with them, replaced by a test that the object call accepts `ReviewOutputSchema` and that the union
  validates a real result.

**The bounded repair turn gets simpler, not harder.** It is a second call with the validation error
appended to the same message array — no session to resume, no cwd to keep fixed, no session id to
thread through `RunOverrides`. The old plan had to list "session resume at a fixed cwd" as one of
four spikes it could not verify, and had to warn that a session which never received a message leaves
no `.jsonl`, so "resumed" and "new" are indistinguishable. That entire class of problem disappears,
and it was the single most awkward thing in S5.

**The repair decision has a tested taxonomy.** `NoObjectGeneratedError` and `TypeValidationError` are
the AI SDK's own distinction between "the model answered the wrong shape" and "the response never
arrived intact", and `omni`'s `judge.ts` already uses exactly that split to separate a bad rubric
answer from a truncated one. The repair turn keys on the same distinction: a `TypeValidationError`
cause is worth one re-prompt with the specific error; anything else is a run failure, because asking
again will not fix a truncated response.

**Decided here: `usage` and the parsed object are what `runAgent` returns.** Both are on the call's
result, so the repair turn and the cost ledger stop being things the caller reconstructs from a
stream of messages.

**The one mechanic that does not dissolve: a review both calls tools and ends in an object.** Read
from the 6.0.209 source, `generateText` resolves `output` only when the last step's `finishReason`
is `stop`; a loop that ends on a tool call leaves it unset, and reading `.output` then throws
`NoOutputGeneratedError`. The docs say the same thing from the other side, and warn that structured
output generation *counts as a step* in `stopWhen` arithmetic. So the loop needs an explicit last
step that produces the object and no tools — which is a configuration, not a terminating-tool
protocol: `stopWhen` bounds the steps, and the final step's `toolChoice: 'none'` (or an empty
`activeTools`) makes the object the only thing the model can return. That is the one piece of harness
knowledge this section keeps, and it is written down here so nobody rediscovers it in S5.

### 2. Budgets and spend: delegate owns both counters and the abort

`agent.ts` sets `maxTurns: 50` / `maxBudgetUsd: 5`; `pr-reviewer.ts` raises them to 80 / $10;
exhaustion arrives as `error_max_turns` / `error_max_budget_usd`, which `run.ts` turns into a failed
review. The AI SDK has neither a turn cap nor a dollar cap. What it has is a step loop with
`stopWhen` and per-step `usage`, which is the raw material the cap is built from. The surviving outer
bound is still the worker's 45-minute deadline (`entrypoint.ts:56-64`), which is still only an outer
bound.

**Decided here: delegate owns a step counter, a spend counter and one abort, in `runAgent`.** The
step counter reads the step results the loop already accumulates (`generateText` reports `steps` and
a `totalUsage`, and `stopWhen` is the condition that bounds them); the spend counter multiplies each
step's `usage` by `delegate/pricing/models.json`; one `abortSignal` past either limit ends the run. A
test asserts the abort fires at N and that the failed review carries a reason.

**The price is delegate's because the SDK reports tokens and not USD.** `LanguageModelUsage` carries
`inputTokens`, `outputTokens`, `totalTokens` and a `inputTokenDetails` breakdown for cache reads and
writes, and no money at all (verified in the 6.0.209 type). That is *stronger* than the position the
old plan was in, where a harness catalog was a second rate source that could silently disagree with
ours. A missing row in our own table is a bug in a file this repo tests, and **a replay whose
`costUsd` is `0` while it reported tokens is a failure, not a zero-cost win.** A cap that reads $0
can never fire.

**The `@aantenore/pi-budget` retrospective, kept as a record.** The previous version recommended
against depending on it, and the reasons were measured: created 2026-10-20, last pushed 2026-10-23,
one npm publish, one star, one contributor, no release tags, and it would have run in-process beside
`REVIEWER_APP_PRIVATE_KEY`; its enforcement policy was 27 non-blank lines of handlers plus 20 of
accounting out of 1,059 shipped, the rest being config merging, formatting, a `/budget` TUI command a
headless worker cannot use, and an SDK adapter. **Its hooks are pi extension hooks and no longer
apply to anything this plan builds** — there is no pi extension left to hook. The decision it records
is unchanged and still right: own the cap in code this repo can test, do not depend on a one-star
package for it. The measurement is kept because deleting a decision that was made and reversed on
review loses the reasoning; the "revisit if `pi-budget` grows maintainers" note is moot.

**Failure vocabulary.** The Claude SDK's `subtype` strings have no AI SDK equivalent, so a small
closed `RunnerError` enum is still needed or every timeout becomes a red `error` status. And a step
is not a turn: the Claude SDK's `num_turns` and an AI SDK step are different definitions, so the
caps are re-tuned from measurement rather than assumed equivalent.

### 3. The security seam, concretely — and most of it dissolves
The old document had this backwards, so it got its own section. Most of that section is now moot,
and it is worth saying so plainly rather than deleting the findings silently: every item below was
effort spent making a coding harness behave like something that is not one, and every one becomes
irrelevant when the tool list starts empty and the loop is ours.

**Moot, because we own the tools and there is no CLI:**

- **The `@`-strip bypass.** pi strips a leading `@` from a path argument and then treats it as
  absolute (`resolveToCwd("@/etc/hostname", "/tmp/x")` returns `/etc/hostname`). There is no
  pi read tool to disagree with our guard, because the read tool is ours.
- **The unicode-space second door** to the same room.
- **`--no-mcp` versus `isMcpToolName`'s MCP *resource* tools** — the flag existed because
  `--exclude-tools 'mcp__*'` missed three resource tools. There is no MCP layer to switch off.
- **`--no-skills` and cwd-only `.pi/skills` discovery.** Nothing loads a skill.
- **`--no-context-files`.** `AGENTS.md` / `CLAUDE.md` are not read by anything.
- **The `EACCES` on a read-only agent directory.** There is no agent directory.
- **The cwd-scoped `--session-id` resume for the repair turn.** There is no session.

**What replaces it.** `runAgent` passes an explicit `tools` object, built with `tool()`, containing
only read, grep, glob and the git tools. Each tool carries its own path guard inside its `execute()`,
and the guard normalises **before** the prefix test — unicode spaces, strip a leading `@`, `resolve`,
`realpath`, prefix test — because a guard that trusts the model's string is the bug, whichever
implementation reads the file. The seven-case adversarial table is still the property, and it now
pins *our* implementation rather than describing pi's bug:

| case | input | expected |
|---|---|---|
| inside | `src/a.ts` | allowed |
| outside, absolute | `/proc/1/environ` | denied |
| outside, relative | `../../etc/passwd` | denied |
| at-prefixed absolute | `@/etc/hostname` | **denied** |
| at-prefixed traversal | `@../../etc/passwd` | **denied** |
| unicode space | `\u00a0/etc/hostname` | **denied** |
| symlink out | a link inside the checkout to `/etc` | denied |

Both guard call sites stay, `pathGuardHook` in `delegate/review/run.ts` and `replayToolGuard` in
`delegate/review/eval/replay.ts`, and the existing denial assertions are **rewritten, never
deleted** — the `agentEnv` allowlist tests and the `pathGuardHook` confinement test in
`delegate/review/run.test.ts` (`:176-209` and `:222-238`), and the `replayToolGuard` pair in
`delegate/review/eval/replay.test.ts` (`:695-713`). They are the only thing that fails when someone
widens a list or drops a normalisation step.

**The new constraint the objective creates: design `agentEnv()` for non-role credentials from the
start.** Stage 2 is a provider move, and the only acceptable version of it keeps the credential out of
the task role: a model-invoke grant on the role of the container that parses untrusted PR content is
the thing that made Bedrock unacceptable before, and `AWS_BEARER_TOKEN_BEDROCK` as one more key in
the same allowlist is what makes it acceptable now. S5 shapes the seam for that, because reshaping it
one provider later is a security change made under pressure. The constraint is provider-shaped, not
SDK-shaped — pi would have had exactly the same problem.

**`git-tool` keeps its own guards verbatim.** `isSafeRef` / `isSafePath` / `truncate` are ref and
argument validation inside a tool, not path confinement, and they survive the port unchanged; only
the registration changes, from `createSdkMcpServer` to the `tool()` set.

**Whether the reviewer should ever get bash is out of scope.** It is a security question about the
reviewer's authority, not about the call layer, and the review agreed.

## Provider and model: settled

**The migration is three stages, and the middle one is what makes the claim measurable.**

1. **The call layer.** Claude Code out, the AI SDK in, still on the Anthropic API and still on
   `claude-opus-5-5` / `claude-sonnet-5-5`. One variable changes.
2. **The route.** Same two Claude models, reached through Bedrock instead of `api.anthropic.com`.
   Still one variable: the provider, with the model ids held constant.
3. **The model.** Bedrock's Claude out, Fireworks' DeepSeek in, where it is acceptable.

The ordering argument is the same at each hop: a failure names its own cause. Stage 1 is the call
layer at constant provider and model, Stage 2 is the provider at constant model, Stage 3 is the
model. The version of this document that went straight from Anthropic to Fireworks collapsed the
last two, so a regression there had two candidate causes — and the portability claim the whole plan
rests on was never measured by a gate at all, only by an ad-hoc side run. Inserting Stage 2 replaces
that side run with a real gate: same models, two routes, one variable, ordinary `costRatio`. That is
what the middle stage buys, and it is worth the extra hop.

**Stage 1 needs nothing but a provider package and a key.** The two models are reachable through
`@ai-sdk/anthropic`, so the reviewer moves to the new call layer while still calling the API it
calls today.

**Stage 2's models exist and are already subscribed, and that is recorded rather than assumed.**
`utils/bedrock-models.ts` is the account's allowlist and it carries
`anthropic.claude-opus-5-5` with `invokeId: global.anthropic.claude-opus-5-5` — the orchestrator's
model — beside `anthropic.claude-sonnet-5-5`, which the subagents run. Its own note on the opus entry
says `GetFoundationModel` reports `inferenceTypesSupported: [INFERENCE_PROFILE]` and nothing else, so
there is no in-region invocation to fall back to. Model access is not a manual step either:
`scripts/enable-bedrock-models.ts` subscribes the account to `WORKBENCH_MODELS`, and
`deploy-workbench.yml` runs it with `APPLY=1` on any push that touches either the script or the list,
which is how adding a model becomes automatic. So Stage 2 has no unverified premise about model
reachability, and nothing about it needs a spike.

**Stage 2 must select `global.` profiles, because that is the account's decision and not a default.**
Every entry in `utils/bedrock-models.ts` is a `global.` cross-region inference profile, the file says
plainly that no `us.` geo profile is permitted by any principal any more, and the 2026-11-04 move to
`global.` was made to stop paying the geo premium. So the model ids Stage 2 requests are
`global.anthropic.claude-opus-5-5` and `global.anthropic.claude-sonnet-5-5`, matching the list rather
than the provider's own `us.` examples. This matters beyond naming: the residency reasoning in that
file is written for the workbench account, which it says carries no product or voter data, and the
delegate worker is a different account in the same organization running a different workload. Stage 2
does not get to inherit that conclusion silently — `utils/bedrock-models.ts`, its
`bedrockInvokeResources`, and the "Inference residency" reasoning in `docs/bifrost-gateway.md` are
written about Bifrost's task role in the workbench account, and what the reviewer's account may invoke
is a separate decision that S7 has to state. That is the one thing about Stage 2 this document cannot
settle from the files, and it is flagged here rather than discovered in the implementation PR.

**Stage 2's credential does almost all the IAM work by itself, and the residual is why S7 exists.**
`deploy/bedrock-invoke-principals.test.ts` pins that invoke actions appear as an `Allow` in exactly
one policy in the repo — Bifrost's task role — and as a `Deny` in exactly one, `WorkbenchAccess`. A
bearer token (`AWS_BEARER_TOKEN_BEDROCK`, which `@ai-sdk/amazon-bedrock` reads natively) adds no
policy line at all: it is one more key in `agentEnv`'s allowlist, so the invariant is untouched and
the task role gains nothing. That is the whole reason this route is acceptable where a SigV4 grant was
not, and it is why the bearer token is the only shape S7 declares. What it does not do is make the
reviewer's own account able to invoke anything, which is the open question above.

S5 shapes `agentEnv` for a non-role credential precisely so S7 can declare this one, and S7 declares
it **additively** while `ANTHROPIC_API_KEY` stays, on the same rule as the Fireworks key. SigV4 and
the instance credential chain remain out: either puts the grant back on the role.

**Model ids and region become explicit, and structured output stops being transparent.** Ids move from
`claude-sonnet-5-5` to `global.anthropic.claude-sonnet-5-5`, and the provider takes a region where the
Anthropic provider infers everything from one key. Bedrock's `structuredOutputMode` defaults to
`auto`, which uses native output where supported and otherwise falls back to a JSON tool, and its own
docs warn native structured output can be unreliable across workloads and Bedrock accounts. That
fallback changes which application tools are available on the step — under `jsonTool`,
`toolChoice: 'none'` sends only the internal JSON response tool — which is the mechanism the last-step
design below relies on. S8 pins `structuredOutputMode` explicitly rather than leaving it on `auto`,
and the Stage B gate is what proves the pinned value works for this schema.

**Fireworks US-only direct is the Stage 3 destination.** `FIREWORKS_API_KEY` replaces the worker's
Anthropic key. This touches **one** human-owned file, `deploy/delegate-secret.ts`
(`DELEGATE_SECRET_KEYS`, where `ANTHROPIC_API_KEY` is the first entry), and **no** change to
`deploy/components/worker.ts`: the task already runs in public subnets (`deploy/index.ts:38`), so any
HTTPS endpoint is reachable and no IAM or egress change is needed — which answers open questions 1
and 7 of the old plan.

**Bifrost: rejected for this worker, though it is the gp-pi path.**
`docs/bifrost-virtual-keys.md` §"Non-human callers" calls a shared worker key "a separate
decision with its own attribution story": worse attribution (one bucket, no per-review split) for a
wider credential (eight frontier models usable as `x-bf-vk` / `Bearer` / `x-api-key`). Blast radius
is the deciding argument, not convenience: a Fireworks key is a billing credential, and leaked it
costs money and is rotatable — it cannot read a bucket, a secret or a repo.
`DELEGATE_GATING_MODE=enforce` is deployed (`deploy/components/worker.ts:159`), four Pulumi trees
are unowned in `CODEOWNERS`, and so the reviewer merges code.

**Both quality fallbacks are named now, not mid-migration.** Each stage has its own, and they
point different ways, which is the benefit of staging.

Fireworks US-only serves one model family — DeepSeek V4.1 Flash 1017 US — so Stage 3's provider
choice *is* the model choice *is* a quality gate: can Flash approve and merge where Opus did? That
question is asked only after Stages 1 and 2 have been proven with the models unchanged, which is what
makes the answer interpretable. If it says no, **the fallback is a Bifrost service key**, keeping Opus
and Sonnet reachable at zero `worker.ts` cost and one more line in `delegate-secret.ts`; the
reviewer then runs on the new call layer, over the Bedrock route, with the models it has today, and
the migration still lands its actual goal. **S10's rollback is that same move**, so the fallback is
the revert rather than a second piece of work.

Stage 2's failure mode is different and cheaper, because the previous route is still deployed:
Bedrock's Claude is not Anthropic's Claude at this task, or `claude-opus-5-5` is not there at all,
and S8's revert returns the reviewer to `api.anthropic.com` with the same models and the same call
layer. Nothing in this plan depends on Stage 2 succeeding; it depends on Stage 2 being *tried*, because
it is the only thing that turns "provider-agnostic" into a measurement.

**Cost is pinned in the repo:** `delegate/pricing/models.json` at the US 1.5× rate — `input: 0.45,
output: 1.8, cacheRead: 0.009, cacheWrite: 0`, the numbers in
`agent-swarm/host/global-setup-script.sh` — **not** pi's catalog figure of 0.3/1.2 (verified in the
installed `fireworks.json`; under-reports by a third), and not zero. This is no longer a patch to a
harness catalog; it is delegate's own price table, used to turn `usage` into dollars.
`delegate/pricing/` joins the `replayKey` inputs (`eval/cache.ts:26`).

**The judge stays on Anthropic.** `judge.ts` is a raw `fetch` to `api.anthropic.com`, not Claude
Code. Deliberately: it is the frozen instrument (changing it invalidates every recorded verdict) and
independence argues for it — a blind judge must not share a family with the arms it scores. The
residual Anthropic surface is exactly three things: the CI `ANTHROPIC_API_KEY` secret in **11
occurrences** in `delegate-eval.yml` (`:81` and `:86` are the pre-flight check, the other nine are
step env) plus **7** in `delegate-eval-run.yml`; `judge.ts`'s call plus `DEFAULT_JUDGE_MODEL`; and
the **20** `CLAUDE_CODE_DISABLE_*` lines in those workflows (12 and 8) — no-ops for anything but the
Claude CLI, which can go first and independently. Use a **separate** Anthropic key for CI, so judging
spend is separable and deleting the worker's old key is not the same event.

## The plan

One PR per step, in this order, each independently revertible. The ordering is forced five ways:
`runAgent` (`agent.ts:40`) *is* the SDK, so the seam is neutralised before anything moves; the call
layer goes **before** the provider, and the provider **before** the model, so each stage gets a clean
A/B; `deploy.yml` runs `./deploy.sh` on **every push to `main`** (`:6`, `:135-138`), so a step that
changes code is a deploy the moment it merges; `deploy/check-secret-keys.ts:51-57` enforces only that
a *declared* key is present, so a key the code needs that nobody declared is never noticed — which is
why every credential step declares a key, additively, **before** the step whose code calls it; and
`DELEGATE_GATING_MODE` is `enforce` in the deployed task definition (`deploy/components/worker.ts:159`),
so the reviewer keeps its merge authority through every stage unless something takes it away first.

**The canary comes before the first unmeasured reviewer, not after the last one.** The previous
version flipped to `shadow` only for a canary after the final stage, which meant the call-layer swap
and both provider moves all deployed under `enforce`: an approval from a reviewer nobody had measured
could merge a PR touching only the de-owned Pulumi trees. The plan itself records that neither
offline harness can grade the call layer — `neverTouch` and `CANDIDATE_FILES` both exclude exactly
those paths — so the only protection against a false approve is the canary, and a canary that runs
last cannot protect anything. **S4 takes the authority away before S5 exists**, and it stays away
until S11 restores it.

| # | Stage | Step | Reversible? | Evidence gate |
|---|---|---|---|---|
| **S1** | — | **Delete the dead CLI install.** `delegate/worker/Dockerfile:4` is proven dead: nothing sets `pathToClaudeCodeExecutable` (0 hits repo-wide) and the SDK resolves its own platform binary by `require.resolve`, never `PATH`. ~346 MB, no behavioural risk. | revert + rebuild | `deploy.yml` builds and pushes; **one real review posted end to end** from the new image; image size recorded before/after. |
| **S2** | — | **Neutral runner contract.** Local `McpServerConfig`, a `ToolCallHandler` matching the new call layer, a structured-output ask, a step and usage result — the six SDK-derived fields leave `types.ts` (`AgentConfig`'s `permissionMode`, `agents`, `tools`, `outputFormat`, and `RunOverrides`' `preToolUseHooks`, `resume`), replaced by AI SDK shapes (`tools: ToolSet`, a `prepareStep`-shaped hook, `output: Output.object(...)`). Split `GIT_TOOL_NAMES` (`git-tool.ts:5-10`) into a constants module with no SDK import. `agent.ts` keeps a behaviour-identical Claude implementation. | yes (refactor) | `npm run build` (the only full typecheck; `tsx --test` does not typecheck) plus `npm test`; a byte-identical review prompt for a recorded bundle; `agentEnv` and both guard tests unchanged and green. |
| **S3** | — | **The security seam.** Both guards on the new handler type — `pathGuardHook` (`run.ts:78`) and `replayToolGuard` (`replay.ts:358`) — with the normalisation described above applied *before* the prefix test. Symbol names rather than line ranges, deliberately: the ranges differ between the PR base and `main`, and the drift is what made the first version of this document stale. | yes | The adversarial table above passes; every existing denial assertion kept; the `agentEnv` / `pathGuardHook` tests in `run.test.ts` and the `replayToolGuard` pair in `replay.test.ts` rewritten, never deleted. |
| **S4** | — | **Take the merge authority away: flip to `shadow`.** One line in `deploy/components/worker.ts` (`DELEGATE_GATING_MODE`), which is a **human-owned carve-out** in `.github/CODEOWNERS`, so this is a human-approved infra PR the bot cannot approve for itself. It merges **before S5 does**. Under `shadow` nothing is ever approved — `verdict` is `approve` only when `gating.mode === "enforce"` (`gates.ts:150-152`) — and the status line reports what the gate *would* have done, so the canary's numbers come from the deployed task rather than from a side run. | revert (flip back to `enforce`) | `pulumi preview` shows only the env value changing; one review from the deployed task carries a `Shadow: would approve` or `Shadow: would comment (…)` status and **no** approval verdict. |
| **S5** | **1. The call layer** | **The call-layer swap, on Anthropic.** `runAgent` over the AI SDK in a spawned Node child with the explicit allowlist env, still on `claude-opus-5-5` / `claude-sonnet-5-5` through `@ai-sdk/anthropic` — **neither provider nor model changes**. Tools are the `tool()` set we write (read, grep, glob, `git-tool`), each guarding its own paths; subagents stay child invocations returning usage to the parent; **the step and spend caps as delegate's own counters plus one abort**, with a test that each fires; `git-tool` keeps `isSafeRef` / `isSafePath` / truncation verbatim; `agentEnv` gains the provider key and drops `CLAUDE_`/`DISABLE_`, and is **shaped for a non-role credential** so S7 and S8 can add a bearer token without reshaping it. | revert + deploy (image tag retained) | **Stage A**: call-layer parity at constant provider and model, `costRatio` gated because both sides price the same table rows. Deployed under `shadow`, so S4's canary window opens here. |
| **S6** | 1 | **Dependency removal.** `package.json:22`, regenerated lockfile, the 20 `CLAUDE_CODE_DISABLE_*` lines, `Skill` out of the default allowlist (`agent.ts:80`), `eval/cache.ts:26`'s comment. Also `delegate/review/eval/block-judge.ts`, which imports `query()` from the SDK for the no-API-key local path and has to move to the AI SDK's judge or be deleted. Now safe: nothing runs on the SDK any more. | revert | `npm test` and `npm run build` green; a full cold `delegate eval` after the lockfile change (every cached run is re-keyed); image size after. |
| **S7** | **2. The route** | **Declare the Bedrock credential, additively.** The bearer token's value goes into the live `DELEGATES` secret out of band first; then `deploy/delegate-secret.ts` gains `AWS_BEARER_TOKEN_BEDROCK` and **keeps `ANTHROPIC_API_KEY`**, and that deploys. **No IAM change and no `worker.ts` change**: a bearer token is a key, not a grant, so `deploy/bedrock-invoke-principals.test.ts`'s file list is untouched — that is the whole reason this route is acceptable. No agent code changes, so the running reviewer is untouched. Human-owned carve-out, its own PR. | yes | `deploy.yml` reaches `./deploy.sh`; `pulumi preview` shows exactly one added entry in the task's `secrets` and nothing else; `check-secret-keys.ts` passes with both keys declared; `bedrock-invoke-principals.test.ts` still passes unchanged; a real review still posts, still on Anthropic direct. |
| **S8** | 2 | **The provider move, to Bedrock, at constant model.** `@ai-sdk/amazon-bedrock` replaces `@ai-sdk/anthropic`; model ids become the `global.` profiles `utils/bedrock-models.ts` already lists and the region becomes explicit; `agentEnv` allowlists the bearer token and the region. **The models do not change** — `global.anthropic.claude-opus-5-5` and `global.anthropic.claude-sonnet-5-5` are both in that list. `structuredOutputMode` is **pinned** rather than left on Bedrock's `auto`, which switches between native output and a JSON tool per model and schema. | yes (flip the provider import back, with both keys declared) | **Stage B**: same models, two routes, one variable. Quality gated; `costRatio` recorded, not gated, because the two sides price from different table rows. One review from the **deployed task** recording nonzero `costUsd`. |
| **S9** | **3. The model** | **Declare the Fireworks key, additively.** The same pattern as S7, applied to the third provider: value into the secret out of band, then `FIREWORKS_API_KEY` added to the declared list while both earlier keys stay. `delegate/pricing/models.json` lands here too, so the rate is committed before anything spends it. No code change. Human-owned carve-out, its own PR. | yes | As S7, and `check-secret-keys.ts` passes with three keys declared. |
| **S10** | 3 | **The model move, to Fireworks.** Point the orchestrator and the subagents at the Fireworks provider and its model. Code only — the key it needs was declared and deployed in S9, and both earlier keys are still declared, so the rollback actually works. | yes (flip back to the Bedrock provider, with no deploy-ordering problem) | `npm run build` and `npm test`; **Stage C** of the gate below; and one review from the **deployed task**, not a local smoke prompt, recording nonzero `costUsd` — a smoke prompt cannot see the task definition's `secrets` and would pass on a key the task does not have. |
| **S11** | — | **Restore `enforce`, once the canary has passed.** One line in the same human-owned carve-out as S4. Blocked until the canary reports zero false approves and `review_failed` at or below baseline. | revert (flip back to `shadow`) | The canary's numbers, plus a review from the deployed task that carries a real approval verdict again. |
| **S12** | — | **Docs and the plan amendment.** `CLAUDE.md:14,145`, `delegate/README.md:3,26,30`, `eval/README.md`, `docs/pr-previews.md:123` (also `getSecretVersion`→`getSecret`), and `docs/plan-gated-merges.md:378` as a **plan amendment, not a checklist edit**, because its "`anyOf` … because that is the keyword Anthropic's structured-output dialect supports" becomes false. | yes | Docs only; the amendment PR names its plan and step. |

**What S5 delivers that the old call-layer step did not.** Two things at once: **the provider seam** — a
`provider(modelId)` expression as a value, so S8 and S10 are a provider import and a key rather than a
rewrite — and **the mixing capability** — `prepareStep` returning `{ model }`, which is how a cheap
model covers the tool grind and a strong one gives the verdict. S5 does **not** configure mixing.
S5 is parity at a constant provider and a constant model, and turning mixing on before parity is
proven would make Stage A uninterpretable: a regression would have two candidate causes again. The
capability lands in S5; the configuration is deliberately deferred until after Stage C.

**Effort: ~14 engineering days** (S1 0.5, S2 2, S3 1, S4 0.25, S5 5, S6 1.5, S7 0.5, S8 1.5, S9 0.5,
S10 0.5, S11 0.25, S12 0.5) plus ~25% contingency, so **~18 days**. The three-stage sequence costs
about two and a half days over the two-stage one, and none of it is padding: **S8 is a new step at
1.5 days** for a provider swap with its own model-id, region and structured-output work; **S7 and S9
add a day between them** for a credential declared and deployed twice; and **S4 and S11 add half a
day** for two one-line human-owned PRs that have to be sequenced around the code. Two of those three
are needed in any version of this plan that takes the merge authority away before measuring — which
the previous version did not do.

**Eval spend is three rounds and still lower than it was.** Stage A ~$330, Stage B ~$90–170, Stage C
~$90–170: roughly **$520–670**, against ~$840 for the previous two rounds plus its ad-hoc portability
leg. The leg is no longer a side run — it is Stage B, a gated round, and it reuses Stage A's Anthropic
side as its own Anthropic-direct side. Three rounds for one variable each is cheaper than two rounds
and one unmeasured claim.

**The credential rule applies twice, and that is the point.** S7 and S9 each *declare* a key while
every earlier key stays declared, so neither the code nor the task definition is ever in a state
where a running review lacks a key it needs. `deploy.yml` deploys on every push to `main`, and
`check-secret-keys.ts` notices only a *declared* key that is absent — so "add one, drop the other" in
a single infra PR takes every review down with no error anywhere.

`ANTHROPIC_API_KEY` therefore leaves the worker in three later PRs, none of them in this plan: it
stops being *used* at S8, when the Bedrock bearer token takes over, while staying declared; it is
*undeclared* after the canary, which is what makes it inert since the task definition injects only
declared keys; and its *value* is deleted weeks later — the one irreversible act. Until the second of
those, S8's rollback is real: the key is still declared and injected, so flipping the agent back to
Anthropic direct works with no deploy-ordering problem. The judge stays on Anthropic permanently
(above), so this key never fully goes away; only the worker's copy does.

**Two things deliberately not done.** `ReviewRecord` does not change (above). And
`.claude/skills/hill-climb/` does not move: `eval/arms.ts:45-47` reads its `targets/*.json` at
runtime as the `neverTouch` source of truth, so moving it is a code change, and `.dockerignore:4`
excludes `.claude`, so moving it into an agent-read path would start shipping it in the image. Its
`SKILL.md:15` credential line is stale for #488's loop and should be fixed where it is.

## The evidence gate, and why the old one did not work

**The hole.** `eval/arms.ts:63` refuses an arm that differs from the scorer in the `neverTouch`
paths, which `.claude/skills/hill-climb/targets/delegate-pr-reviewer.json:7-13` defines as
`delegate/review/eval/`, `delegate/review/`, `delegate/framework/`, `.github/`, `package.json`,
`package-lock.json`. The runner seam lives in exactly those paths, so **the arms harness cannot
grade a runner swap in either direction**. `delegate eval` has the same problem from another angle:
`eval/dispatch.ts:10` limits a candidate branch to two literal-only files (`CANDIDATE_FILES`).
Widening either list would let a candidate grade itself, which is the one property they exist to
guarantee. **Decided here: neither is widened, and the swap is not measured by either.**

**The gate instead: three cold A/Bs, human-assembled, one variable each.** The eval already takes a
results directory as its baseline (`--mode gate --base <dir>`), which is all a comparison needs if a
human assembles the pair. Every round **freezes the cases** at the current manifest — editing a case
invalidates its cached answer, and all three are structural questions, not prompt questions.

**Stage A — the call layer, at constant provider and model** (gates S5). Both sides on
`claude-opus-5-5` and `claude-sonnet-5-5`, both against `api.anthropic.com`: `results-old` (Claude
Agent SDK) and `results-new` (AI SDK), three runs per case, scored by **one** checkout — the branch's
`expect.ts`, so neither side grades itself. ~$330. This is the round that can be trusted most,
because the prompt, the output schema, the provider and both models are held fixed. A regression here
is the call layer, full stop.

**Stage B — the route, at constant model** (gates S8). `results-ai-sdk-anthropic` (Stage A's new
side, reused, so only one side is cold) against `results-ai-sdk-bedrock`: same two Claude models,
reached two ways, one variable. ~$90–170. **This is the round that measures the plan's central
claim**, and it is why the third stage exists: a call layer that works over exactly one provider is
indistinguishable, from the evidence, from one that is not portable at all. It also proves the pinned
`structuredOutputMode` for a schema this shape, which is the one place Bedrock's `auto` behaviour
could quietly change the call.

**Stage C — the model** (gates S10). `results-ai-sdk-bedrock` (Stage B's new side, reused) against
`results-ai-sdk-fireworks`, one variable changed: ~$90–170, since only the model differs. If it
fails, the named Bifrost fallback applies and Stages A and B stand — the call layer and the provider
route are both already proven, so a failure here is a model decision, not a plan restart.

**What every round gates on:** no case main passed on every run regresses; holdout counts only, never
holdout ids; the judge's pairwise verdict not-worse; `--final true` so a rerun that never happened
cannot pass. **`costRatio` is gated in Stage A and only recorded in Stages B and C.** In Stage A both
sides are priced from the same table rows, so `COST_LIMIT = 1.1` (`eval/expect.ts:335`) is a real
comparison of the two call layers' token use. In Stages B and C the two sides price from different
rows — Bedrock's Claude rates are not Anthropic's, and Fireworks' are not either — so a human reads
the first three production `costUsd` values against a billing line instead. The
zero-cost-with-tokens assertion runs automatically in all three.

**The canary runs *under* the three rounds, not after them.** `DELEGATE_GATING_MODE=shadow` is
deployed from S4, before the call layer lands, so 10–20 production reviews accumulate inside every
stage's window — no merge outcome can change by construction, because `decide` returns `approve` only
under `enforce`. The requirement is the same one: **zero false approves and `review_failed` at or
below baseline**, measured on the whole window from S4 through S10. S11 restores `enforce` only after
that holds, and it is a separate human-owned PR, so the flip back is a decision someone makes after
reading the numbers rather than something that rides along with a code change.

That ordering is the whole argument for splitting S4 out of S5. A canary cannot retroactively
un-merge an approval, so it has to be running before the first reviewer nobody has measured can
approve anything. Which is also why the offline gate and the canary are not alternatives: the cold
A/Bs say whether the reviewer still *finds* what it found before, and the canary says whether it
*approves* what it should not.

`replayKey` (`eval/cache.ts:26-33`) hashes `delegate/agents`, `delegate/framework`, `delegate/review`
and the lockfile, so S2, S5 and S6 each re-key the cache. Budget the cold sides in one calendar
window — and the three-way split keeps this affordable: Stage B reuses Stage A's new side and Stage C
reuses Stage B's, so only one side of each later round is priced from cold.

**An opportunity the call layer enables, not taken here.** The judge stays on Anthropic, but it no
longer has to stay on *one* Anthropic deployment: seat A could run on one provider and seat B on
another, which is a stronger independence claim than "different model family" because it also
removes a shared serving stack. That belongs to the eval's own work, not to this plan, and is
recorded so it is not lost.

## Load-bearing surface, and how to regenerate it

The old appendix listed 200 lines of `path:line` and was wrong within a week. This is only what
*carries* the dependency.

**Imports the SDK** (8 files import it and `package.json` declares it — 10 lines at `7ccb6a6`,
excluding eval fixtures):
`delegate/framework/agent.ts:1` (`query()`), `delegate/framework/types.ts:1` (`HookCallback`,
`Options`), `delegate/review/eval/block-judge.ts:1` (`query()`, the no-key local judge path),
`delegate/review/git-tool.ts:2` (`tool`, `createSdkMcpServer`), `delegate/review/run.ts:5`,
`delegate/review/eval/replay.ts:4` and `replay.test.ts:8` (`HookCallback`), `package.json:22`, and
`eval/dispatch.test.ts:126,163` — fixture *strings* asserting the candidate-diff rule, which must
survive as text. **Installs the binary:** `delegate/worker/Dockerfile:4`, unpinned (2.1.326 today,
~346 MB).

**Passes Claude-specific configuration:** `pr-reviewer.ts` (model, `maxTurns`/`maxBudgetUsd`, the
`tools`/`allowedTools` lists carrying `Task` and `StructuredOutput`, and `outputFormat`);
`pr-reviewer-subagents.ts` (each subagent's `tools` and `model: "claude-sonnet-5-5"`);
`agent.ts:71-91` (default `allowedTools` including `Skill`, `permissionMode`, `hooks.PreToolUse`,
`stderr`); `run.ts:47-73` (env allowlist, its `ANTHROPIC_*` names and `CLAUDE_`/`DISABLE_`
prefixes); `deploy/delegate-secret.ts` (the only human-owned file this plan changes); and
`.github/workflows/` (11 + 7 `ANTHROPIC_API_KEY` occurrences, 20 `CLAUDE_CODE_DISABLE_*` lines).

**Regenerate rather than trust** — the commands do not go stale, which is why the list above is short:

```bash
git grep -n '@anthropic-ai/claude-agent-sdk' -- ':!package-lock.json'   # the dependency
git grep -n 'claude-code' -- ':!package-lock.json'                      # the binary install
git grep -il -e claude -e anthropic -- ':!package-lock.json' ':!*.md'   # all of it, code only
git grep -c 'CLAUDE_CODE_DISABLE' -- .github/workflows/                 # the dead env vars
git grep -n 'ANTHROPIC_API_KEY' -- .github/workflows/
# After the swap these must be empty: the definition of done.
git grep -n '@anthropic-ai/claude-agent-sdk' -- ':!package-lock.json' ':!*.test.ts'
git grep -n 'claude-code' -- ':!package-lock.json'
# And these must stop being empty: the new surface.
git grep -n -e '"ai"' -e '@ai-sdk/' -- package.json
git grep -n '@ai-sdk/' -- delegate/
```

At `7ccb6a6`: 8 files import the SDK and `package.json` declares it (10 lines, excluding eval
fixtures); 121 files / 364 lines match `claude|anthropic` with docs, 107 / 286 in code. The count
moves weekly; the commands do not.

**Two things that look in scope and are not.** `delegate`'s `claude|anthropic` matches that belong to
a different system: `utils/bedrock-models.ts` and its tests, `deploy/bedrock-invoke-principals.test.ts`,
`deploy-workbench/bifrost/*`, `docs/bifrost-*.md`, `docs/workbench-account.md`, the `/anthropic/*`
prefix in `deploy-workbench/ingress.ts`, `gating.ts:247-248` and `codeowners.test.ts:87` (a
`CODEOWNERS` glob), and the `CLAUDE.md` string in
`eval/expected/ops-plan-amends-itself.bundle.json:18`, where editing it changes an eval case. And
the struck `@modelcontextprotocol/sdk` item: it is not in `package.json`, nothing imports it, and
`delegate/framework/mcp.ts` — the file the old plan feared would "lose its SDK" — **does not exist**.

## PR discipline, because every path here is human-owned

`.github/CODEOWNERS` owns `*` by default, and seven paths inside `deploy/` are re-owned after the
owner-less Pulumi lines so the reviewer cannot approve a change to its own logic or authority. So
**one file under an owned path pulls the whole PR into human review** — expected here, since `docs/`
is owned, and the reason each credential change is its own PR (S7, S9) and no step bundles infra with an
agent change. **Do not add anything to the opt-out list** to make any of this mergeable. And **CI
stays split**: `deploy.yml` runs `npm test` in the credential-less `test` job, and nothing here moves
a step that executes code into the job that assumes the deploy role.

**How an implementation PR binds to this plan.** Two lines in the PR body, each on its own line:

```
Plan: docs/delegate-harness-migration.md
Step: 5
```

`Step:` takes **digits only** — `STEP_LINE` is `/^[ \t]*step:[ \t]*(\d+)[ \t]*$/`
(`gating.ts:91`) — so this document's `S5` label must be written `Step: 5`, not `Step: S5`. A
malformed or duplicated `Step:` is silently ignored (`gating.ts:108-111`), which leaves the step's
status where it was rather than failing loudly, so getting this wrong is invisible. `Plan:` is what
the gate reads; `Step:` only advances status and never affects the verdict.

## What this document could not verify

**No code was run against a model.** The ≈900 MB figure — ~552 MB of platform packages npm installs
because no platform package in the lockfile declares `libc`, ~24 MB `@anthropic-ai/sdk`, ~4.7 MB
SDK, plus the ~346 MB global install — comes from `npm ci` / `npm install -g` on a scratch tree and
from the lockfile, not from an image build. And **five things about the AI SDK path need a spike in
the step that depends on them**, none of them asserted anywhere above:

1. **That `prepareStep` model switching behaves across providers with a message history that spans
   both.** The mechanism is documented and the type permits it (`PrepareStepResult.model`), but a
   history whose tool calls were produced by one provider and whose next step runs on another is not
   something the docs exercise, and provider-specific content parts (thinking signatures, cache
   markers, Anthropic's `container`) are where it would break. This is after Stage C, since mixing is
   configured only once the three stages are done.
2. **Whether the reviewer's own account may invoke Bedrock models.** `utils/bedrock-models.ts`
   answers this for the workbench account, and `deploy/bedrock-invoke-principals.test.ts` pins that
   Bifrost's task role is the only principal in the repo with an `Allow`. The delegate worker is a
   different account running a different workload, and neither the model list nor its residency
   reasoning transfers automatically. S7 has to state which account and which profiles, and the bearer
   token makes that a configuration question rather than an IAM one.
3. **That `Output.object` against `ReviewOutputSchema` works on Bedrock's JSON-tool path and on
   Fireworks.** Bedrock's own documentation warns native structured output can be unreliable across
   workloads and accounts and defaults to `auto`, which falls back to a JSON tool; Fireworks' own
   capability table lists object generation per model and names none of the router ids the worker
   uses, so support for `deepseek-v4p1-flash-1017-us` is unstated either way — and the schema here is
   a two-branch discriminated union nested inside another union, which is the shape most likely to
   hit a fallback. Stages B and C measure it, not this document.
4. **That a major-version `ai` upgrade stays contained behind `runAgent`.** The seam is designed for
   it, but AI SDK 7 already renames things AI SDK 6 documents (`stepCountIs`→`isStepCount`,
   `system`→`instructions`), and whether the next one lands inside one file is unproven.
5. **That a spawned Node child is enough isolation for the AI SDK path** — that no in-process
   provider fetch, retry or telemetry path reads something outside the allowlist. The child gives the
   boundary; whether the library respects it is measured, not assumed.

**Whether Flash can carry the review is unmeasured by design** — that is Stage C, and the fallback is
named. **Whether Bedrock's Claude is as good as Anthropic's Claude at this task is also unmeasured
by design** — that is Stage B, and it is the one stage whose failure does not fall back to Bifrost but
to staying on Anthropic direct, which S8's rollback already allows. And **the arms harness's refusal
was read from source**, not reproduced.