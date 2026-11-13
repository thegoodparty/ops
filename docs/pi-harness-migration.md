# Replacing Claude Code with pi in `delegate`

> **Status: proposal.** This changes no code. It records the decision to remove the Claude Agent SDK
> and the `claude-code` CLI from `delegate/` and run the reviewer on
> [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi-coding-agent) (pi,
> **pinned 1.5.2**), the steps that do it, and the evidence each needs. Where it makes a call of its
> own it says **decided here** and gives the reasoning, so review can argue with the reasoning.
>
> Verified against `main = 8d33889`, pi 1.5.2's docs and `dist/`, and npm tarballs. **Nothing here
> was run against a model.** Size figures come from `npm ci` / `npm install -g` measurements and
> pi's published `dist/`, not from an image build or a review. Every `path:line` was re-read while
> writing, and the commands that regenerate the inventory are in this document rather than an
> appendix, because the previous appendix went stale twice.
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

**One agent and two subagents, not a fleet.** `delegate/agents/index.ts` imports only
`./pr-reviewer`; `delegate/worker/entrypoint.ts:44` refuses any other agent name at boot; the
webhook Lambda has one route (`delegate/lambdas/handler.ts:18-20`). So the migration is
`pr-reviewer`, `scout` and `deep-reviewer` (`pr-reviewer-subagents.ts:80-81,138-139`), one seam,
and the image. Everything else in `delegate/` is already deterministic code.

Motivations, in order. **The provider and model choice is a quality gate, not a cost saving**, and
the harness currently makes a second vendor unreachable. **One harness in the repo instead of two**:
`agent-swarm/` already runs pi (`HARNESS_PROVIDER=pi`, `agent-swarm/host/render-env.sh:105`), and the
repo carries both catalog patches that divergence costs
(`agent-swarm/host/global-setup-script.sh:186-198`, `docs/bifrost-fireworks-model-metadata.md`). And
**~900 MB of Claude Code leaves the image** — step S1, which ships on its own.

**Decided here: no compatibility flag and no `harness` field on `ReviewRecord`.** The old plan
carried `AgentConfig.runner?: "claude" | "pi"` so a partially migrated fleet could run; there is no
fleet, and an enum, a driver registry and a "which harness ran" audit story for one agent is pure
cost. The one-line rollback it buys is bought as well by `git revert` plus the previous image tag —
always addressable, because `workerImageUri` is a Pulumi value and ECR tags are the ops commit. For
the same reason there is no mixed corpus to keep joinable: `agentVersion`
(`delegate/review/schema.ts`, set from the image tag at `deploy/components/worker.ts:163`) already
names the exact commit, and leaving `ReviewRecordSchema` untouched keeps old records replayable as
eval inputs.

## Three differences in kind that remain

Everything else in the old translation table was a rename.

### 1. Credential isolation is a process boundary, and stays one only because we spawn

`delegate/review/run.ts:42-45` states the requirement: the worker's env is the whole `DELEGATES`
bundle, and a read of `/proc/self/environ` would leak any key the allowlist failed to name. Two
things carry it — `agentEnv()` (`run.ts:46-72`) hands the child a short allowlist, and the child is
a **different process**, whose environ the read tool can only reach by escaping the checkout, which
the path guard stops (`run.ts:74-110`). Run pi in-process and both fail at once:
`/proc/self/environ` is the worker's own environ and no path guard applies.

**Decided here: every agent is a spawned `pi --mode rpc` child with an explicit `env`.** Neither pi
integration point gives that for free: **`RpcClient` cannot express an allowlist** — it spawns with
`env: { ...process.env, ...this.options.env }` and offers no removal, so the client is hand-rolled
over the documented protocol — and **`bash` inherits the child env wholesale**, since `getShellEnv()`
returns `{ ...process.env, ... }` (`dist/utils/shell.js:147`), which makes the child's env the exact
blast radius of a bash call. Two mechanics follow. **The JSONL framing helper is not exported**:
`attachJsonlLineReader` / `serializeJsonLine` live in `dist/modes/rpc/jsonl.js` but off the package
export map, so the client reimplements an **LF-only** splitter — Node's `readline` splits on
U+2028/U+2029, which occur inside payload strings. And **the agent directory must be writable**: on a
read-only `PI_CODING_AGENT_DIR` pi fails at startup with `EACCES` on `mkdir` of `trust.json.lock`,
writing `auth.json`, `models-store.json`, `trust.json*` — so an image directory with no `auth.json`
and no `mcp.json` is right in intent and needs a writable copy or tmpfs.

The allowlist test (`delegate/review/run.test.ts:176-209`) is **rewritten, not deleted** — it is the
only thing that fails when someone widens the list.

### 2. Structured output changes regime, and one half is better than assumed

`pr-reviewer.ts:230` sets `outputFormat` and `:221` includes `"StructuredOutput"` in `tools`,
because that is a built-in *tool* the harness routes the answer through; `structured_output`
(`agent.ts:205`) is what `parseReviewOutput` (`run.ts:302`) consumes. pi has no `outputFormat`.
The replacement is a terminating custom tool: the model is asked to call it, `execute()` validates
with `ReviewOutputSchema`, `terminate: true` ends the run. pi **validates tool arguments** and
returns the error to the model in-turn, so a malformed argument is a cheap retry rather than a
second failure class — but it **never validates `structuredContent`/`outputSchema`**, so
`ReviewOutputSchema` stays delegate's job: validate in `execute()`, return `isError: true`. Also,
`terminate` fires only when **every** result in a batch is terminating; `{ block: true }` alone
never ends a run.

`constrainedSampling` and nested unions stay mutually exclusive. The model-facing schema stays the
flat object (`pr-reviewer.ts:18-30`), which exists because a tool input schema cannot carry a
top-level union, and `ReviewOutputSchema` stays the authority. `toSupportedDialect`
(`pr-reviewer.ts:38-52`, the `oneOf`→`anyOf` rewrite) exists for one vendor's dialect; it goes, with
the four `draft-07` tests (`pr-reviewer.test.ts:286-346`), replaced by a test that the tool accepts
the flat object and the union validates the result.

The bounded repair turn (`run.ts:672-713`) survives, with one caveat: **`--session-id` resume is
cwd-scoped.** A session created at one cwd is not found from another with the same `--session-dir`;
pi creates a second file with the same id. The repair turn must run at the same cwd, and a session
that never received a message leaves no `.jsonl`, so "resumed" and "new" are indistinguishable
until the first prompt. Test it.

### 3. Budgets do not exist, so they are built — and cost is the sharp edge

`agent.ts:82-83` sets `maxTurns: 50` / `maxBudgetUsd: 5`; `pr-reviewer.ts:216-217` raises them to
80 / $10; exhaustion arrives as `error_max_turns` / `error_max_budget_usd`, which
`run.ts:663-666` turns into a failed review. pi 1.5.2 has neither — searched in the CLI, the
settings schema and the extension API. `agent_before_settle` is a settle-time boundary that can
append entries and request one continuation, so a budget extension has a hook, but nothing caps
spend. The surviving outer bound is the worker's 45-minute deadline (`entrypoint.ts:56-64`).

A turn cap is a counter over the event stream. A **spend** cap needs a price, and pi computes cost
by catalog arithmetic — `cost.totalFromProvider` is only ever true for OpenRouter — defaulting a
missing row to `0` silently. This repo has been bitten by that twice. **Decided here:** cost is an
estimate from a price committed in the repo, never from pi's catalog, and **a replay whose
`costUsd` is `0` while it reported tokens is a failure, not a zero-cost win.** That one assertion
is what makes the migration's own success criterion unfoolable. The SDK's failure `subtype`
vocabulary has no pi equivalent either, so a small closed `RunnerError` enum is needed or every
timeout becomes a red `error` status; and `num_turns` and pi's `turn_end` are different
definitions (one assistant response plus its tool calls), so the caps are re-tuned from
measurement.

## Provider and model: settled

**Fireworks US-only direct, mirroring `agent-swarm/`.** `FIREWORKS_API_KEY` replaces
`ANTHROPIC_API_KEY`. This touches **one** human-owned file, `deploy/delegate-secret.ts:16`, and
**no** change to `deploy/components/worker.ts`: the task already runs in public subnets
(`deploy/index.ts:38`), so any HTTPS endpoint is reachable and no IAM or egress change is
needed — which answers open questions 1 and 7 of the old plan.

**Bedrock: rejected, and not on cost.** It is the only option that puts a model-invoke grant in the
production account, on the task role of the container that parses untrusted PR content, with
`global.` routing that cannot be US-pinned — and it breaks
`deploy/bedrock-invoke-principals.test.ts`'s invariant that invoke actions appear in exactly four
files with `Allow` in exactly one, which exists to make someone argue for it. It also needs model
agreements (`aws-marketplace:Subscribe`), i.e. `/breakglass`.

**Bifrost: rejected for this worker, though it is the gp-pi path.**
`docs/bifrost-virtual-keys.md` §"Non-human callers" calls a shared worker key "a separate
decision with its own attribution story": worse attribution (one bucket, no per-review split)
for a wider credential (eight frontier models usable as `x-bf-vk` / `Bearer` / `x-api-key`).
Blast radius is the deciding argument, not convenience: a Fireworks key is a billing credential,
and leaked it costs money and is rotatable — it cannot read a bucket, a secret or a repo.
`DELEGATE_GATING_MODE=enforce` is deployed (`deploy/components/worker.ts:159`), four Pulumi trees
are unowned in `CODEOWNERS`, and so the reviewer merges code.

**The quality fallback is named now, not mid-migration.** Fireworks US-only serves one model family
— DeepSeek V4.1 Flash 1017 US — while the reviewer is `claude-opus-5-5` plus `claude-sonnet-5-5`
specialists, so the provider choice *is* the model choice *is* a quality gate: can Flash approve and
merge? If stage A below says no, **the fallback is a Bifrost service key**, keeping Opus and Sonnet
reachable at zero `worker.ts` cost and one more line in `delegate-secret.ts`. A failed quality gate
is a provider pivot of about a day, not a plan restart.

**Cost is pinned in the repo:** `delegate/pi/models.json` at the US 1.5× rate — `input: 0.45,
output: 1.8, cacheRead: 0.009, cacheWrite: 0`, the numbers in
`agent-swarm/host/global-setup-script.sh:186-198` — **not** pi's catalog figure of 0.3/1.2
(verified in the installed `fireworks.json`; under-reports by a third), and not zero.
`delegate/pi/` joins the `replayKey` inputs (`eval/cache.ts:26`).

**The judge stays on Anthropic.** `judge.ts:63` is a raw `fetch` to `api.anthropic.com`, not Claude
Code. Deliberately: it is the frozen instrument (changing it invalidates every recorded verdict) and
independence argues for it — a blind judge must not share a family with the arms it scores. The
residual Anthropic surface is exactly three things: the CI `ANTHROPIC_API_KEY` secret in **11
steps** (`delegate-eval.yml:81,86` pre-flight check, `:256,:352,:427,:547,:633,:751`, and
`delegate-eval-run.yml:274,:302,:445,:602`); `judge.ts`'s call plus `DEFAULT_JUDGE_MODEL`
(`judge.ts:6`); and the **20** `CLAUDE_CODE_DISABLE_*` lines in those workflows (12 and 8) — no-ops
for anything but the Claude CLI, which can go first and independently. Use a **separate** Anthropic
key for CI, so judging spend is separable and deleting the worker's old key is not the same event.

## The one open architecture question: `pi --mode rpc`, or `pi-durable`

The first version of this document did not see this, and it is the largest decision in it.

- **`pi --mode rpc`** — a spawned child speaking JSONL over stdin/stdout. Stable, documented, and
  where the credential argument already lands. It gives no turn cap, no scheduler, no
  per-conversation cost ledger and no subagent primitive; delegate builds those.
- **`@earendil-works/pi-durable` 1.5.2** — commits every turn and tool call to storage before it
  is shown, so a dead process resumes. It ships `maxTurns`, a durable scheduler, per-conversation
  usage/cost (`harness.usage()`), an owned-conversation subagent pattern and `beforeTool` hooks
  that block or rewrite arguments. `ops` PR #530 prototypes it at ~1.5k lines. It is marked
  **Experimental — "the API changes without notice between releases"** — and it replaces
  `pi --mode rpc` as the runner shape.

**Recommendation: `pi --mode rpc`, hand-rolled client, `runAgent` kept as the only seam.**
Ordered by what it would cost to be wrong:

1. **Credential isolation is the reviewer's security control and is cheapest where it already
   works.** rpc's child with an explicit `env` *is* the control. pi-durable runs in-process: its
   `NodeExecutionEnv` spawns shells with `getShellEnv(baseEnv, extraEnv, inheritEnv = true)`, which
   spreads `process.env`, so adopting it means re-earning the isolation argument inside a
   dependency via a custom `ExecutionEnv` — more security-critical code than the client rpc needs.
2. **Durability buys nothing for this workload.** One Fargate task per job, one PR, a 45-minute
   deadline, a record keyed by `(pr, sha)` — ECS *is* the restart boundary, and a resumed
   conversation has nowhere to resume to once the task is gone. #530 needed durability because it
   replaced a long-lived Slack swarm; the reviewer is a single-shot batch job.
3. **The one thing it gives that delegate wants is the turn cap**, and that is a counter, not an
   architecture. Its experimental flag is a real cost here specifically: the reviewer is the merge
   authority, and an API change under it during an eval campaign is a rewrite scheduled by someone
   else's release.

**What being wrong costs.** If rpc is chosen and durability is later wanted, the neutral contract in
`delegate/framework/types.ts` plus one `runAgent` file makes the driver swappable and #530 is the
reference: a rewrite behind an interface that already exists. If pi-durable is chosen and its API
moves, the bill is the same rewrite *plus* a security control re-established inside a dependency's
execution environment — strictly worse, which is why the asymmetric choice is the right one.
Revisit if pi-durable stabilises *and* delegate grows a long-lived surface; neither is in this plan.

## The plan

One PR per step, in this order, each independently revertible. The ordering is forced twice:
`runAgent` (`agent.ts:40-93`) *is* the SDK, so the seam is neutralised before anything moves; and
`deploy/check-secret-keys.ts:43-57` makes an extra key a warning but a *missing declared* key a hard
exit 1, so the credential swap is last.

| # | Step | Reversible? | Evidence gate |
|---|---|---|---|
| **S1** | **Delete the dead CLI install.** `delegate/worker/Dockerfile:4` is proven dead: nothing sets `pathToClaudeCodeExecutable` (0 hits repo-wide) and the SDK resolves its own platform binary by `require.resolve`, never `PATH`. ~346 MB, no behavioural risk. | revert + rebuild | `deploy.yml` builds and pushes; **one real review posted end to end** from the new image; image size recorded before/after. |
| **S2** | **Provider wiring, no behaviour change.** Put `FIREWORKS_API_KEY` in the live `DELEGATES` secret out of band first, then commit `delegate/pi/models.json` at the US price. `ANTHROPIC_API_KEY` stays declared. | yes (unused) | `npm run build` and `npm test`; one smoke prompt inside the image's env records nonzero tokens **and nonzero cost**. Zero cost fails the step. |
| **S3** | **Neutral runner contract.** Local `McpServerConfig`, a `ToolCallHandler` replacing `HookCallback`, a structured-output ask, a session handle — six SDK-derived fields leave `types.ts` (`:3,13,14,15,16,24`); split `GIT_TOOL_NAMES` (`git-tool.ts:5-10`) into a constants module with no SDK import. `agent.ts` keeps a behaviour-identical Claude implementation. | yes (refactor) | `npm run build` (the only full typecheck; `tsx --test` does not typecheck) plus `npm test`; a byte-identical review prompt for a recorded bundle; `agentEnv` and both guard tests unchanged and green. |
| **S4** | **The security seam.** Both guards on the new handler type (`run.ts:77-110`, `replay.ts:353-367`) with pi's own path normalisation. **The `@`-strip bypass is fixed here.** | yes | The adversarial table below passes; every existing denial assertion kept; `run.test.ts:176-209,222-238` and `replay.test.ts:694-712` rewritten, never deleted. |
| **S5** | **The runner swap, atomic.** `runAgent` over a spawned `pi --mode rpc` child with the explicit allowlist env; structured output as a terminating tool; subagents as child processes returning usage to the parent; turn and cost caps; `git-tool` as an extension (`tool()`/`createSdkMcpServer` at `git-tool.ts:48,67,82,101,120`) keeping `isSafeRef`/`isSafePath`/truncation verbatim; `replayKey` gains `delegate/pi/`; `agentEnv` gains pi's knobs and drops `CLAUDE_`/`DISABLE_`. | revert + deploy (image tag retained) | The two-stage gate below, then a shadow canary. |
| **S6** | **Dependency removal.** `package.json:22`, regenerated lockfile, the 20 `CLAUDE_CODE_DISABLE_*` lines, `Skill` out of the default allowlist (`agent.ts:80`), `eval/cache.ts:26`'s comment. | revert | `npm test` and `npm run build` green; a full cold `delegate eval` after the lockfile change (every cached run is re-keyed); image size after. |
| **S7** | **Infra.** `deploy/delegate-secret.ts:16`: add `FIREWORKS_API_KEY`, drop `ANTHROPIC_API_KEY` — **the same PR as the deploy, never before it.** Human-owned carve-out, its own PR, no agent work riding along. | yes, until the value is deleted | `pulumi preview` shows exactly the expected `secrets` delta and nothing else; the deploy lands; a real review posts with nonzero `costUsd`; then soak. |
| **S8** | **Docs and the plan amendment.** `CLAUDE.md:14,145`, `delegate/README.md:3,26,30`, `eval/README.md`, `docs/pr-previews.md:123` (also `getSecretVersion`→`getSecret`), and `docs/plan-gated-merges.md:378` as a **plan amendment, not a checklist edit**, because its "`anyOf` … because that is the keyword Anthropic's structured-output dialect supports" becomes false. | yes | Docs only; the amendment PR names its plan and step. |

**Effort: ~11 engineering days** (S1 0.5, S2 1, S3 2, S4 1.5, S5 4, S6 1, S7 0.5, S8 0.5) plus
~25% contingency, so ~14 days, plus one eval round at roughly **$420** and its wall time. S5 is the
only step that is not mostly mechanical, and most of it is the measurement queue.

**One one-way door, and it is not in this plan.** Deleting the `ANTHROPIC_API_KEY` *value* is
irreversible, so it happens weeks after S7, on its own, once `costUsd` has been nonzero for a while.
Undeclaring a key is what makes it inert — the task definition injects only declared keys — so "no
Anthropic spend from the worker" is achieved without it. (`.claude/skills/hill-climb/SKILL.md:15`'s
credential line is stale for #488's loop and should be fixed where it is, not moved.)

**Two things deliberately not done.** `ReviewRecord` does not change (above). And
`.claude/skills/hill-climb/` does not move: `eval/arms.ts:45-47` reads its `targets/*.json` at
runtime as the `neverTouch` source of truth, so moving it is a code change, and `.dockerignore:4`
excludes `.claude`, so moving it into a pi-read path would start shipping it in the image.

## The security seam, concretely

The old document had this backwards, so it gets its own section.

**pi strips a leading `@` from a path argument and then treats it as absolute.** Verified against
the installed build: `resolveToCwd("@/etc/hostname", "/tmp/x")` returns `/etc/hostname`. A guard
doing `realpathSync(resolve(cwd, raw))` sees the literal `@/etc/hostname`, resolves it to
`<cwd>/@/etc/hostname`, finds it inside the checkout and **allows it** — while the read tool strips
the `@` and reads the real file. That is a bypass to any absolute path, and unicode spaces are a
second door to the same room. So the guard applies pi's own normalisation *before* the prefix test
— unicode spaces, strip a leading `@`, `resolve`, `realpath`, prefix test — and these cases pin it,
run identically against both guards (`replay.ts`'s tool allowlist and `run.ts`'s path guard, which
answer one question and have drifted before):

| case | input | expected |
|---|---|---|
| inside | `src/a.ts` | allowed |
| outside, absolute | `/proc/1/environ` | denied |
| outside, relative | `../../etc/passwd` | denied |
| at-prefixed absolute | `@/etc/hostname` | **denied** |
| at-prefixed traversal | `@../../etc/passwd` | **denied** |
| unicode space | `\u00a0/etc/hostname` | **denied** |
| symlink out | a link inside the checkout to `/etc` | denied |

Two facts the rest of the confinement depends on. **`--no-mcp` is the only reliable MCP switch**:
`--exclude-tools 'mcp__*'` does not cover the three MCP *resource* tools (`list_mcp_resources`,
`list_mcp_resource_templates`, `read_mcp_resource`) because `isMcpToolName` matches more than the
`mcp__` prefix (`dist/core/mcp-servers.js:37`), and `--tools read,grep,find` does not filter MCP
tools at all unless an entry starts with `mcp__`; keep the exclusions as belt-and-braces, rely on
`--no-mcp`, and give the agent directory no `mcp.json` and no `--approve` so a `.pi/mcp.json` in a
PR checkout cannot load. And **`--no-skills` for the reviewer**, for a *weaker* reason than the old
document gave: `.pi/skills` is **cwd-only**, with no walk to the repository root (the ancestor walk
exists only for `.agents/skills`, stopping at the git root), so a PR cannot add skills from above
the checkout — but a checkout-root `.pi/skills/` is still repo-supplied instructions reaching the
system prompt of the reviewer judging that repo. Context files (`AGENTS.md`, `CLAUDE.md`,
`AGENTS.override.md`) also load unless `--no-context-files`, so the reviewer passes both flags, with
a fail-closed assertion in the same PR.

## The evidence gate, and why the old one did not work

**The hole.** `eval/arms.ts:63` refuses an arm that differs from the scorer in the `neverTouch`
paths, which `.claude/skills/hill-climb/targets/delegate-pr-reviewer.json:7-13` defines as
`delegate/review/eval/`, `delegate/review/`, `delegate/framework/`, `.github/`, `package.json`,
`package-lock.json`. The harness seam lives in exactly those paths, so **the arms harness cannot
grade a harness swap in either direction** — an arm carrying the new runner differs in
`delegate/framework/`, and so does one carrying the old. `delegate eval` has the same problem
from another angle: `eval/dispatch.ts:10` limits a candidate branch to two literal-only files.
Widening either list would let a candidate grade itself, which is the one property they exist to
guarantee. **Decided here: neither is widened, and the swap is not measured by either.**

**The gate instead: one cold A/B, human-assembled, on both harnesses.** The eval already takes a
results directory as its baseline (`--mode gate --base <dir>`), which is all a harness comparison
needs if a human assembles the pair.

1. **Freeze the cases** — the current manifest (36 cases: 20 tune, 16 holdout). Editing a case
   invalidates its cached answer, and this is a harness question, not a prompt question.
2. **Stage A — can Flash review at all?** `--mode inner` over the tune cases, one run each, from the
   branch. ~$80 and ~20 minutes, and it answers the model question separately and cheaper than the
   gate does: if it fails, the answer is the named Bifrost fallback, not another harness iteration.
   Gate: valid `ReviewOutput` at all, repair-turn rate recorded, a human reads three.
3. **Stage B — the swap, both sides.** Two worktrees a human names: `results-old` (old harness, old
   model) and `results-new` (new harness, Fireworks). Three runs per case, both sides scored by
   **one** checkout — the branch's `expect.ts`, so neither side grades itself. ~$330.
4. **Gate on:** no case main passed on every run regresses; holdout counts only, never holdout ids;
   the judge's pairwise verdict not-worse; `--final true` so a rerun that never happened cannot
   pass. `costRatio` is **recorded, not gated** — across the swap it compares an SDK-reported total
   to a locally estimated one, which is exactly the comparison the old plan would have trusted. A
   human reads the first three production `costUsd` values against a billing line instead, and the
   zero-cost-with-tokens assertion runs automatically.
5. **Then the canary.** 10–20 production reviews with `DELEGATE_GATING_MODE=shadow` — one line in a
   human-owned file, no merge outcome changed by construction — requiring zero false approves and
   `review_failed` at or below baseline, then a flip back to `enforce` in its own PR.

`replayKey` (`eval/cache.ts:26-33`) hashes `delegate/agents`, `delegate/framework`, `delegate/review`
and the lockfile, so S3, S5 and S6 each re-key the cache: budget both cold sides in one calendar
window, which the ~$330 above already assumes.

## Load-bearing surface, and how to regenerate it

The old appendix listed 200 lines of `path:line` and was wrong within a week. What follows is only
what *carries* the dependency.

**Imports the SDK** (8 files / 9 lines at `8d33889`): `delegate/framework/agent.ts:1` (`query()`),
`delegate/framework/types.ts:1` (`HookCallback`, `Options`), `delegate/review/git-tool.ts:2`
(`tool`, `createSdkMcpServer`), `delegate/review/run.ts:5`, `eval/replay.ts:4` and
`replay.test.ts:8` (`HookCallback`), `package.json:22`, and `eval/dispatch.test.ts:126,163` —
fixture *strings* asserting the candidate-diff rule, which must survive as text. **Installs the
binary:** `delegate/worker/Dockerfile:4`, unpinned (2.1.323 today, ~346 MB).

**Passes Claude-specific configuration:** `pr-reviewer.ts:214,216-217,221-229,230` (model, caps,
`tools`/`allowedTools` with `Task` and `StructuredOutput`, `outputFormat`);
`pr-reviewer-subagents.ts:80-81,138-139` (tool lists, `claude-sonnet-5-5`); `agent.ts:71-91`
(default `allowedTools` including `Skill`, `permissionMode`, `hooks.PreToolUse`, `stderr`);
`run.ts:46-62` (env allowlist, its `ANTHROPIC_*` names and `CLAUDE_`/`DISABLE_` prefixes);
`deploy/delegate-secret.ts:16` (the only human-owned file this plan changes); and
`.github/workflows/` (12 `ANTHROPIC_API_KEY` occurrences, 20 `CLAUDE_CODE_DISABLE_*` lines).

**Regenerate rather than trust:**

```bash
# The dependency: 8 files / 9 lines at 8d33889.
git grep -n '@anthropic-ai/claude-agent-sdk' -- ':!package-lock.json'
# The binary install: 1 line.
git grep -n 'claude-code' -- ':!package-lock.json'
# The whole named surface, code only: 56 files / 177 lines at 8d33889.
git grep -il -e claude -e anthropic -- ':!package-lock.json' ':!*.md'
# The workflow lines that can go independently of everything else.
git grep -c 'CLAUDE_CODE_DISABLE' -- .github/workflows/
git grep -n 'ANTHROPIC_API_KEY' -- .github/workflows/
# After the swap, these must be empty: the definition of done.
git grep -n '@anthropic-ai/claude-agent-sdk' -- ':!package-lock.json' ':!*.test.ts'
git grep -n 'claude-code' -- ':!package-lock.json'
```

At `8d33889`, `claude|anthropic` matches 70 files / 253 lines including docs and 56 / 177 in code.
The count moves weekly; the commands do not. **Do not touch** (`claude`/`anthropic` that is a
different system): `utils/bedrock-models.ts` and its tests,
`deploy/bedrock-invoke-principals.test.ts`, `deploy-workbench/bifrost/*`, `docs/bifrost-*.md`,
`docs/workbench-account.md`, the `/anthropic/*` prefix in `deploy-workbench/ingress.ts`,
`gating.ts:247-248` and `codeowners.test.ts:87` (a `CODEOWNERS` glob), and the `CLAUDE.md` string
inside `eval/expected/ops-plan-amends-itself.bundle.json:18` — a replayed plan's text, where
editing it changes an eval case.

**Struck from the old inventory:** the `@modelcontextprotocol/sdk` "dependency ordering" item. It
is not in `package.json` and nothing imports it, and `delegate/framework/mcp.ts` — the file the old
plan feared would "lose its SDK" — **does not exist**. The only MCP server in `delegate/` is the
git tool `run.ts` and `replay.ts` construct.

## PR discipline, because every path here is human-owned

`.github/CODEOWNERS` owns `*` by default, and seven paths inside `deploy/` are re-owned after the
owner-less Pulumi lines so the reviewer cannot approve a change to its own logic or authority. So
**one file under an owned path pulls the whole PR into human review** — expected here, since `docs/`
is owned, and the reason S7 is its own PR and no step bundles infra with an agent change. **Do not
add anything to the opt-out list** to make any of this mergeable. And **CI stays split**:
`deploy.yml` runs `npm test` in the credential-less `test` job, and nothing here moves a step that
executes repository code into the job that assumes the deploy role.

## What this document could not verify

**No code was run against a model.** The ≈900 MB figure — ~552 MB of platform packages npm installs
because no platform package in the lockfile declares `libc`, ~24 MB `@anthropic-ai/sdk`, ~4.7 MB
SDK, plus the ~346 MB global install — comes from `npm ci` / `npm install -g` on a scratch tree and
from the lockfile, not from an image build. **pi's behaviour was read, not measured**, except where
marked verified above, and **four of its behaviours need a spike in the step that depends on them**:
subagent result handoff and child usage reaching the parent, a `tool_call` handler mutating
arguments (the `forceSynchronousTaskHook` equivalent), session resume at a fixed cwd for the repair
turn, and whether a throw from a start-up handler is reliable fail-closed. **Whether Flash can carry
the review is unmeasured by design** — that is stage A, and the fallback is named. And **the arms
harness's refusal was read from source**, not reproduced.
