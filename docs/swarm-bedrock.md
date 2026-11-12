# Bedrock in the Delegate swarm, and the end of the Anthropic key

This is the plan for giving the Delegate swarm access to exactly two Amazon
Bedrock models, and for retiring the Anthropic API key the swarm still carries.
It records the decisions and the reasoning behind them, so the work can be
picked up across sessions and so a reviewer can tell a deliberate choice from an
accident. Fireworks stays the default for every agent and every task; Bedrock is
opt-in, one model at a time.

Read [`infrastructure-account.md`](./infrastructure-account.md) first. The swarm
runs in the account that document provisions — `394495727159`,
`goodparty-infrastructure`, us-west-2 — and this plan inherits its vocabulary and
its account boundary without restating either.

## Progress

This document is a spec. A step's status is not written here: it is derived from
the pull requests that name the step, which is decision 11 of
[`plan-gated-merges.md`](./plan-gated-merges.md). A merged PR naming the step is
`done`, with its merge date and a link to that PR as the evidence. Failing that,
an open PR naming it is `doing`, with its author and open date. A step with
neither is `todo`, whether it never had a PR or its only one was closed
unmerged. ClickUp carries only what git cannot express.

A pull request says which plan it implements, and which numbered step it closes,
in its body, each on its own line:

```
Plan: docs/swarm-bedrock.md
Step: 3
```

`Plan:` is a pointer to this file at `main` and nothing else. `Step:` is
deliberately not part of the merge gate: a missing, malformed or duplicated one
never flags a PR, it only leaves that step's status where it was. Status is read
from the PRs and never written back into this document, and the checklist below
is the record of what the plan expects to be run and how to know it worked, not
a place to tick.

The plan has two halves, and they are ordered rather than interchangeable:

- **Part A, steps 1 to 5** — the two-model grant. Model subscriptions, the
  dedicated role, the credential switch, the catalogue rows, and the proof.
- **Part B, steps 6 and 7** — the Anthropic key. An investigation, then the
  removal, and only if the investigation says the removal is safe.

- [ ] 1. Subscribe `394495727159` to the two models. Reporting first, then
      `APPLY=1`, and the account id and agreement outcomes recorded. `todo`
- [ ] 2. Create `delegate-swarm-bedrock` in `deploy-infrastructure/`, with an
      invoke grant scoped to those two models and nothing else, trusted by the
      swarm host role, and give the host role `sts:AssumeRole` on it. `todo`
- [ ] 3. Point `agent-swarm/host/aws-config` at the new role as `[default]` and
      demote `delegate-swarm-prod-read` to `[profile prod-read]`, after auditing
      what reaches for `[default]` today. `todo`
- [ ] 4. Write one model-catalogue overlay row per model in
      `agent-swarm/host/sync-agent-config.sh`. `todo`
- [ ] 5. Prove it: an invocation of each model from a worker container, with the
      ARNs and the refusal shape recorded, and the Fireworks default re-checked
      in the same session. Operational, no PR. `todo`
- [ ] 6. Establish what actually consumes `ANTHROPIC_API_KEY`, in the worker and
      in the api. Investigation, no code change, and step 7 waits on its answer.
      `todo`
- [ ] 7. Remove the key from the swarm's secret and every surface that carries
      it, or record why it stays. `todo`

## Goal

The swarm currently reaches exactly one model: Fireworks US-only, the DeepSeek
V4.1 Flash 1017 US router, for all three agents and every task. That is
deliberate and it stays the default. What it does not give us is a second
frontier model on a credential we already hold, in an account that already
exists, for the tasks where Fireworks is the wrong tool.

The second half of the plan comes from the same place. The swarm carries an
Anthropic API key that no agent uses, and the README's justification for it
does not survive being read against the pinned source: the "api service and
fallback path" it names is the one caller that rejects an Anthropic credential,
while two other callers are quietly using one. Either the key is needed and the
wrong sentence is written about it, or it is not needed and neither is the key.
This plan does not assume which; it makes the plan say so in writing.

Two outcomes, stated as invariants rather than features:

- **Two models are reachable from a worker container, through the AWS credential
  chain, and nothing else in Bedrock is.** Not "Bedrock works": a named pair,
  invoked by a role that can reach no other model and no Bedrock control-plane
  read.
- **The default does not move.** A task that names no model still runs
  Fireworks, on the same router id, with the same behaviour, whether or not the
  Bedrock path is healthy. A change here that risks the default is a change that
  is wrong.
- **No new key.** Bedrock authenticates through the AWS SDK's chain, which in
  that container means the instance role from IMDS. Nothing is added to
  `DELEGATE_SWARM` to enable this.
- **The Anthropic key is either justified in writing or gone.** Not "left in
  place because removing it is risky": step 6 establishes what reads it, and
  step 7 either removes it or replaces that sentence with a true one.

## What is being enabled

| Thing | Value |
|---|---|
| Account | `394495727159` (`goodparty-infrastructure`), region us-west-2 |
| Model | `openai.gpt-6.1-sol`, selected as `global.openai.gpt-6.1-sol` |
| Model | `anthropic.claude-haiku-5-5`, selected as `global.anthropic.claude-haiku-5-5` |
| Selection id in a container | `amazon-bedrock/global.openai.gpt-6.1-sol` |
| Selection id in a container | `amazon-bedrock/global.anthropic.claude-haiku-5-5` |
| Role that invokes them | `delegate-swarm-bedrock`, new, in the infrastructure account |
| Who may assume it | `arn:aws:iam::394495727159:role/delegate-swarm-host` only |
| Default model, unchanged | `fireworks-us/accounts/fireworks/routers/deepseek-v4p1-flash-1017-us` |
| Anchors in this repo | `utils/bedrock-models.ts` entries `openai.gpt-6.1-sol` and `anthropic.claude-haiku-5-5`; `deploy-infrastructure/agent-swarm.ts` for the host |

Both models are already entries in `WORKBENCH_MODELS` in
`utils/bedrock-models.ts`, with the `global.` inference profile as `invokeId`, so
their ids, profiles and Marketplace product ids are recorded rather than
remembered (`prod-qco655ut2vn54` and `prod-6cyn7tgqazjhu`). That file is the
single source of truth for which Bedrock models GoodParty permits, and this plan
does not fork it: the swarm's two models are a *selection* from that list, not a
second list. Where the IAM policy is built from, and why that matters for
review, is step 2.

The `global.` profile is not a choice this plan makes again. It is the
convention `utils/bedrock-models.ts` records for every model since 2026-11-04,
it is about 10% cheaper than the `us.` geo profile, and the reasoning — and the
residency acceptance that goes with it — is in
[`bifrost-gateway.md`](./bifrost-gateway.md) under "Inference residency".

## Decision 1: the grant lives in the infrastructure account

**Decision: `delegate-swarm-bedrock` is an IAM role in `394495727159`, holding an
invoke grant on the two models' profiles and foundation models. It is not routed
through the workbench Bifrost gateway, and it is not added to
`delegate-swarm-prod-read` in the management account.**

Three reasons, in the order that made the decision:

- **The resources are in that account.** The inference profiles are
  `394495727159`'s resources, and so are the Marketplace agreements that make
  them invocable. Invoking them is a same-account call. Routing through the
  workbench gateway would mean a cross-account hop plus a virtual key plus a
  second account's spending, for no capability the swarm does not already have
  in the account it runs in. The gateway exists for the inner loop's cost
  attribution and revocation
  ([`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md)); the swarm is one
  trusted workload with one bill, not a fleet of engineers.
- **`delegate-swarm-prod-read` is read-only by construction, and a test says
  so.** `deploy/delegate-swarm-prod-read.test.ts` walks every action in that
  role's policy against a `READ_ONLY` pattern —
  `(Describe|Get|List|View)…`, `logs:FilterLogEvents|StartQuery|StopQuery|
  TestMetricFilter`, `pricing:*`. `bedrock:ConverseStream` matches none of it, so
  the first attempt to add Bedrock there fails the suite. That is the test doing
  its job: the role's whole purpose is "the swarm may look at production and
  change nothing", and a model-invoking grant in it would blur the one boundary
  the management account's grant draws.
- **Blast radius.** Production reads and model inference fail differently. A
  compromised or misbehaving agent that can invoke a model is a spend and a data
  question; one that can also assume a production-read role is a different
  question. Keeping them in different roles in different accounts means the
  answer to "what did this credential reach" is one document each.

The cost, recorded: a second place a model list is expressed (mitigated in step
2 by deriving it from `utils/bedrock-models.ts` rather than retyping ids), and a
second account to check when a model is added or replaced. Both are the price of
the account boundary [`infrastructure-account.md`](./infrastructure-account.md)
was built for, and both are one edit.

Nothing about the Infrastructure SCP changes. It has no region deny, so unlike
the Workbench SCP — which exempts `bedrock:*` and `aws-marketplace:*` from its
region statement — there is nothing for a `global.` profile's routing to trip
over here. The SCP's `DenyIamUsersAndLongLivedKeys` does not deny
`iam:CreateRole`, which is what lets the stack create this role at all; that
exclusion was written for exactly this kind of consumer.

## Decision 2: a dedicated role, not the host role

**Decision: the grant is on a new role, `delegate-swarm-bedrock`, trusted only by
`arn:aws:iam::394495727159:role/delegate-swarm-host`. The host (instance) role
gets `sts:AssumeRole` on it and nothing else. `agent-swarm/host/aws-config` then
makes this role `[default]` and demotes `delegate-swarm-prod-read` to
`[profile prod-read]`.**

The host role today does two things no container should inherit. It holds
`secretsmanager:GetSecretValue` on the `DELEGATE_SWARM` secret — read at
container start, and `swarmHostPolicy` in `deploy-infrastructure/agent-swarm.ts`
is where that statement lives — and it holds `sts:AssumeRole` on
`delegate-swarm-prod-read`. Containers reach the instance role through IMDS
(`httpPutResponseHopLimit: 2`), which is deliberate and is how the agents already
read production. Putting Bedrock straight on the host role would mean every
process in the stack that can reach IMDS could invoke a model *and* read the
swarm's secret with one credential, and there is no reason to couple those.

The role-shaped alternative also gives one place to answer "what may the swarm do
in Bedrock", which is the property decision 4 depends on.

One difference from `delegate-swarm-prod-read`'s trust, worth recording because
it looks inconsistent: that role's trust names the account root as principal and
narrows with an `ArnEquals` condition on `aws:PrincipalArn`, because it is
created in a different Pulumi project (`deploy/`, in the management account) than
the host role it trusts, and IAM rejects a trust naming a role that does not
exist yet in that ordering. This role and the host role are in the *same* stack,
so `deploy-infrastructure/` can name the host role ARN as the principal directly
and let Pulumi order the two. If this ever moves projects, it takes the
account-root-plus-condition shape.

**The cost, and it is the sharpest thing in this plan.** `agent-swarm/host/aws-config`
is mounted read-only into the lead and both workers, and `AWS_CONFIG_FILE` points
at it, so today a bare `aws` or SDK call in a container is production, read-only,
by way of `[default]`. After this change `[default]` is the infrastructure
account and production is a named profile: a bare `aws s3 ls` in a worker would
read the wrong account, quietly and successfully. Two consequences:

- Step 3 is not a one-line edit. It must first find everything that reaches for
  `[default]`. What is in this repo is small —
  `agent-swarm/host/scripts/s2w-replies-upload.ts` signs its own request from
  IMDS directly and is unaffected, and the AWS CLI is installed by
  `agent-swarm/host/global-setup-script.sh` into the worker's PATH — but the
  swarm's *live* scripts and skills are not in this repo
  ([`../agent-swarm/README.md`](../agent-swarm/README.md), "Swarm state this repo
  owns"), so the audit is a read of the swarm's own catalog, not a grep here.
- Whatever the audit finds needs `--profile prod-read`, or an `AWS_PROFILE` set
  per command. `AWS_PROFILE=prod-read` cannot simply be set in the worker env:
  pi's Bedrock path prefers `AWS_PROFILE` when it is set, so that would point
  Bedrock at the read-only production role and every invocation would be refused
  on `bedrock:ConverseStream`.

If the audit finds a bare-`aws` path that cannot carry a profile, the answer is
to keep `[default]` as it is and put the Bedrock role behind an explicit profile
the invoke path sets, not to accept a silently wrong account. That is recorded as
the fallback rather than the plan, because it is the fallback that costs a second
mechanism.

The role's session is one hour, not because anyone chose it: containers assume it
from the instance role, which is role chaining, and AWS caps that at an hour. The
SDK re-assumes as credentials near expiry, the same way the prod-read path
already does, so a long task does not lose its credential mid-run.

## Decision 3: `BEDROCK_AUTH_MODE` is deliberately not set

**Decision: `BEDROCK_AUTH_MODE` is not set anywhere — not in `render-env.sh`, not
in `docker-compose.yml`, not in swarm config. Bedrock models are reached by
naming an `amazon-bedrock/<profile-id>` model per task or per agent, and the
agents' default stays `fireworks-us/…`.**

This was verified in the pinned tag, agent-swarm v2.10.0, rather than reasoned
about (`src/providers/pi-mono-adapter.ts`, `checkPiMonoCredentials`, and
`isBedrockMode` in `src/commands/provider-credentials.ts`). The Bedrock
credential branch is entered when `BEDROCK_AUTH_MODE=sdk`, when
`BEDROCK_AUTH_MODE=bearer`, or — the prefix-inference fallback — when
`BEDROCK_AUTH_MODE` is absent *and* `MODEL_OVERRIDE` starts with
`amazon-bedrock/`.

The gate is hard, in the way that matters. In `sdk` mode the worker runs a real
enumeration against Bedrock (`ListFoundationModels` + `ListInferenceProfiles`)
before it reports ready, and a failed probe returns `ready: false` with a
classified hint. The worker's boot path then parks in the credential wait loop
(`src/commands/credential-wait.ts`) — `BOOT_MAX_WAIT_SECONDS` defaults to
"forever" — so a Bedrock probe that fails for any reason (a missing agreement, a
region that has not propagated, a wrong account) takes *the whole worker* out of
service, including the Fireworks work that is healthy today. Setting
`BEDROCK_AUTH_MODE=sdk` would therefore make two opt-in models a gate on the
default.

Leaving it unset is safe because of where the gate reads from. It reads
`MODEL_OVERRIDE`, which is the agent's container default, not the task's model.
`MODEL_OVERRIDE` stays a `fireworks-us/…` id, so the branch is never entered and
the Fireworks readiness path is untouched. A task or an agent whose model is
`amazon-bedrock/<profile-id>` still runs on Bedrock, because `amazon-bedrock` is
a built-in pi provider (`bedrock-converse-stream`, wired through pi-ai's
`amazon-bedrock` provider and `ConverseStream`) and per-task model resolution
outranks `MODEL_OVERRIDE` on the claim path
(`src/be/model-tier-resolution.ts`, precedence 1 "task `model`" then agent
default; the runner then uses the server's `resolvedModel`, which wins over the
local one).

**What that costs, stated plainly.** With no probe there is no live model
enumeration, so the console does not discover the two models by itself. The
worker reports no `credStatus.bedrock`, and the dashboard's Bedrock group falls
back to the static models.dev snapshot with `enabled: false` and "Awaiting worker
probe" (agent-swarm v2.10.0, `apps/ui/src/lib/agent-runtime-models.ts`). The
plan's answer is the model-catalogue overlay row per model, which is the
mechanism this repo already uses for `fireworks-us` (step 4).

**The row is not proven to be enough, and this plan says so rather than assuming
it.** An overlay row merges into the served catalogue, so the two models will
*appear* in the Bedrock group. But the group's `enabled` flag comes from the
probe, and the model combobox renders a group with `disabled={!group.enabled}`
(`apps/ui/src/components/shared/model-combobox.tsx`), so a row alone may list
the models and still leave them unpickable. What is certain and does not depend
on the console at all:

- a task can be created with `model: "amazon-bedrock/global.openai.gpt-6.1-sol"`,
  which the claim path resolves directly and which outranks `MODEL_OVERRIDE`;
- an agent's runtime can be PATCHed to that model the same way
  `sync-agent-config.sh` already sets `fireworks-us` — and it already sends
  `allow_custom_model: true`, which is what makes a catalogued id acceptable on
  that route.

So step 4 verifies the console and records what it says. If the row is enough, a
second model is pickable. If it is not, the models are reachable by id and the
rows remain correct as catalogue metadata — reasoning levels, context window,
prices — and the console gap is an open question rather than a reason to turn the
probe on. What would not be acceptable is turning the probe on to fix a picker,
which is the failure this decision exists to avoid.

**If the probe is ever turned on**, it is one PR that says so, and it comes with
the two reads decision 4 withholds, plus a considered answer to "what happens to
Fireworks tasks while the probe is failing".

## Decision 4: no Bedrock control-plane reads on this role

**Decision: `delegate-swarm-bedrock` holds no `bedrock:ListInferenceProfiles`, no
`bedrock:ListFoundationModels`, and no other `bedrock:Get*` / `bedrock:List*`.
Its grant is the invoke family, on two models' ARNs.**

Those reads exist to serve one thing: the enumeration probe that decision 3 does
not enable. The gateway needed `ListFoundationModels` and nothing else —
`deploy-workbench/ecs.ts` grants exactly that, `TASK_BEDROCK_READ_ACTIONS`,
because Bifrost's Bedrock provider draws its model list from a signed
`GET /foundation-models` — and the swarm is not a gateway; it does not draw a
model list from AWS at all. A read with no caller is a permission that will
still be there when someone builds a caller.

The asymmetry with `deploy-workbench/ecs.ts` is deliberate and worth stating,
because a reviewer will notice it: that role grants `bedrock:ListFoundationModels`
on `*` and this one does not. The difference is the probe. If the swarm's probe is
ever turned on, both reads get added then, in a PR that says it is turning the
probe on — not in advance, and not "for symmetry".

The invoke actions themselves: the harness calls the Converse API
(`ConverseStreamCommand` from `@aws-sdk/client-bedrock-runtime`, via pi-ai's
`bedrock-converse-stream`), so the grant is `bedrock:Converse` and
`bedrock:ConverseStream`. `InvokeModel` and `InvokeModelWithResponseStream` are
*not* granted. Step 2 records whatever the invocation in step 5 proves, and
widening to the invoke pair afterwards is a one-line change with a reason.

Resources are the shape `bedrockInvokeResources()` in `utils/bedrock-models.ts`
already uses for exactly this grant, restricted to two models: each model's
`global.` inference-profile ARN in this account, plus the foundation-model ARN
(which carries no account) for routing outside the home region. Both are needed
and neither alone is enough — the request names the profile, and Bedrock then
invokes the foundation model wherever the global profile routes — and the region
is wildcarded on purpose, for the reasons that file records.

## The model catalogue overlay

One overlay row per model, written by
`agent-swarm/host/sync-agent-config.sh` the same way the `fireworks-us` row is:
`PUT /api/models-catalog/overlay`, keyed on provider and model id, upserted on
every deploy, so a merge is enough to apply it.

| Field | Value for both rows |
|---|---|
| `provider` | `amazon-bedrock` |
| `modelId` | `global.openai.gpt-6.1-sol`, `global.anthropic.claude-haiku-5-5` |
| `reason` | required by the API; states that the probe is off and the row is hand-verified |
| `verifiedBy` | `sync-agent-config.sh` |
| `reasoning`, `reasoningOptions` | from the model facts, not from memory |
| `contextWindow`, `maxOutput` | ditto |
| `pricing` | display only |

Two things to get right, both learned from the `fireworks-us` row:

- **The facts must be derived, not restated.** The `fireworks-us` row reads its
  reasoning levels out of the `models.json` heredoc in
  `agent-swarm/host/global-setup-script.sh`, so editing the model moves the
  console with it, and `agent-swarm/host/scripts/model-catalog-overlay.test.ts`
  fails if a second copy appears. These rows have no heredoc to read, so the
  facts come from the pinned agent-swarm snapshot the same version ships
  (`src/be/modelsdev-cache.json` at v2.10.0 does carry both `global.` ids) and
  the numbers are recorded in the row's `reason`/comment rather than being typed
  twice.
- **Leave `expiresWhenUpstreamMatches` at its default.** The `fireworks-us` row
  sets it `false` because models.dev has no `fireworks-us` section and the
  condition can never be met. That reasoning does not transfer: models.dev *does*
  list both of these under `amazon-bedrock`, so a row whose facts match upstream
  should be allowed to delete itself. Copying `false` here would turn a temporary
  enrichment into a permanent one.

These rows are display and selection metadata. They never touch the swarm's price
book, so they do not change what a session is charged — the same caveat the
README's "Models" section records at length for `fireworks-us`.

## Region

`docker-compose.yml` enumerates every environment variable a container receives,
and `AWS_REGION` is not among them; the systemd unit sets `AWS_REGION=us-west-2`
for the compose process, not for the containers. That is harmless today because
nothing in a container picks a region. It is worth naming here because Bedrock is
the first thing that might care, and the answer is not obviously "it works":

- pi-ai's Bedrock path resolves a region from the ARN embedded in the model id,
  then an explicit option, then `AWS_REGION`, then `AWS_DEFAULT_REGION`, then the
  region in the model's `baseUrl`, then falls back to `us-east-1`. The bundled
  catalog's `baseUrl` for both of these models is the us-east-1 endpoint, and the
  swarm's containers have none of `AWS_REGION`, `AWS_DEFAULT_REGION` or
  `AWS_PROFILE` — so unless step 3 sets one, the endpoint path wins and the call
  goes to us-east-1. Worth being precise about, because the same code uses
  `AWS_PROFILE`'s presence to decide whether to pin that endpoint at all.
- The IAM grant wildcards region, and a `global.` profile routes wherever AWS
  chooses, so a call made against the us-east-1 endpoint from a us-west-2 host
  is not an authorization problem. It is a "which endpoint did we actually talk
  to" question, and the answer decides what CloudTrail and VPC flow logs show.
- Step 5 records the region the invocation actually used. If it is not us-west-2,
  step 3 sets `AWS_REGION` (or `AWS_DEFAULT_REGION`) explicitly in
  `x-worker-env` so the container's region is a stated fact rather than a
  default. That is a one-line change in
  `agent-swarm/host/docker-compose.yml`, checked the way
  `agent-swarm/host/scripts/fireworks-residency.test.ts` checks the other env
  values, and it is cheaper than discovering the answer in a bill or a log
  search.

## Part B: removing the Anthropic key

This half is **not a finished decision.** `agent-swarm/README.md` says today that
`ANTHROPIC_API_KEY` "stays in the secret and in the worker env for the api
service and as a fallback path, but no agent runs an Anthropic model". That
sentence is two claims, and only the second is one anybody has checked. The plan
is to establish the first before acting on it.

### What the pinned source says

Everything here was read in agent-swarm v2.10.0, the tag
`agent-swarm/host/render-env.sh` pins, not recalled.

- **Verified: no agent needs it.** Every agent runs `pi` against `fireworks-us/…`
  (`HARNESS_PROVIDER=pi`, both `*_MODEL_OVERRIDE`s), and pi has no
  cross-provider fallback. Bedrock needs nothing from it either: Bedrock
  authenticates through the AWS credential chain, which is the whole point of
  Part A.
- **Verified: two internal callers almost certainly do, and neither is the
  "fallback path".** agent-swarm's `internal-ai` layer resolves a credential by
  walking `openrouter → anthropic → openai → openai-codex → claude-cli`
  (`src/utils/internal-ai/credentials.ts`, `CREDENTIAL_KIND_PRECEDENCE`), and
  this swarm's secret has none of `OPENROUTER_API_KEY`, `OPENAI_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN`. So Anthropic is the only kind it can satisfy. Two
  callers reach that path and neither is gated by a flag:
  - **Session summarisation, in the worker.** `summarizeSessionForPi` runs on
    `session_shutdown` (`src/providers/pi-mono-extension.ts`) unless
    `SKIP_SESSION_SUMMARY` is set, which this swarm does not set. It calls
    `summarizeSession`, whose first act is `resolveCredential`, and the model it
    then asks for is the credential's `modelDefault`, i.e.
    `MEMORY_RATER_DEFAULT_MODEL.anthropic` = `anthropic/claude-haiku-4-5`
    (`src/utils/internal-ai/models.ts`). `MEMORY_RATERS` gates only the *ratings*
    that ride along, not the summary.
  - **Task auto-titles, in the api.** `startTaskAutoTitleListener` is started
    unconditionally by the api process (`src/http/index.ts`) and
    `TASK_AUTO_TITLE_ENABLED` defaults to `true`
    (`src/be/task-auto-title-listener.ts`). It calls `generateTaskTitle`, which
    walks the same credential list and asks for its own candidate models — the
    Anthropic one is `anthropic/claude-haiku-5-5`
    (`src/utils/internal-ai/task-title.ts`).

  Both return a graceful no-op when no credential resolves (`completeStructured`
  returns `null`; `session_summary` logs "summarizer returned no result"). So
  deleting the key would not break anything loudly — it would silently stop
  writing session summaries and stop titling new tasks. **That is the finding
  that makes this a step rather than a cleanup**, and it is why deleting the key
  is not the same change as "the agents don't use it".

  Note what is *not* a consumer: **workflow LLM nodes reject an Anthropic
  credential outright** — `resolveWorkflowLlmConfig` accepts only `openrouter`
  and `openai` kinds and throws otherwise (`src/workflows/executors/workflow-llm.ts`).
  So the README's "api service … fallback path" is neither of the two real
  callers, and the sentence to write later is a different one.
- **Verified, and it is the second reason this is a gate:** the key is
  load-bearing for the *credential check* even though no agent uses an Anthropic
  model. `checkPiMonoCredentials` maps `MODEL_OVERRIDE` to required keys, and
  `fireworks-us/…` is not a provider it recognises: `modelToCredKeys` returns
  `null` for it, which selects the permissive case — "any one of
  `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `OPENAI_API_KEY`
  (`src/providers/pi-mono-adapter.ts`). `FIREWORKS_API_KEY` is not in that list
  and no `~/.pi/agent/auth.json` exists in the worker, so with the key gone and
  nothing added a worker's readiness check fails and the boot loop parks. This is
  not a theory: PR #491 removed the key for the right reason (a stray Anthropic
  model pin would bill about 9× the Fireworks price) and the swarm stopped
  detecting a valid credential in production, and it was reverted in `88a5a1f`.
  That commit and its revert are the record, and they are why step 7 is gated.

So removing the key is two problems, not one: replace the credential that two
internal callers are silently using, and replace what satisfies the `pi`
readiness check. Neither has an answer in this repository today, and neither is
solved by Part A — Bedrock is available to the *worker* through aws-config, but
`internal-ai` has no Bedrock credential kind at all in v2.10.0, and the api
container has no AWS access ([`../agent-swarm/README.md`](../agent-swarm/README.md),
"AWS access from inside the swarm"). That is worth knowing before anyone assumes
the two halves of this plan meet.

### The surfaces that carry it

| Surface | What it does | What removal means |
|---|---|---|
| `agent-swarm/host/docker-compose.yml` | `ANTHROPIC_API_KEY` in `x-worker-env` (all three agents) and in the `api` service env | drop both lines |
| `agent-swarm/host/render-env.sh` | `ANTHROPIC_API_KEY` in `REQUIRED_KEYS`, and the render flushes *every* secret key into `.env` | drop it from `REQUIRED_KEYS`; the flush then has nothing to flush |
| `agent-swarm/fill-secrets.sh` | asks for it ("3/5 Anthropic key"), and lists it in the final missing-key report | stop asking, stop listing, and prune it from an older secret the way the reverted change did |
| `agent-swarm/README.md` | the "Where it runs" key list, the "Models" paragraph quoted above, and the "Bringing it up" step 2 | correct all three in the same PR |
| `agent-swarm/host/scripts/fireworks-residency.test.ts` | asserts the key's presence in compose | invert the assertion; it is the test that will fail otherwise |

And one that is *not* a surface of this secret, though it looks like one:

- **`deploy/delegate-secret.ts` holds a different stack's Anthropic key.**
  `DELEGATE_SECRET_KEYS` is the key list for the `DELEGATES` secret, which feeds
  the Fargate `pr-reviewer` that runs the Claude Agent SDK, and
  `delegate/review/run.ts` allowlists `ANTHROPIC_API_KEY` as the only model
  credential that subprocess may see — the reviewer runs `claude-opus-5-5`
  through the Anthropic API by design. `deploy.sh` validates the live `DELEGATES`
  secret against that list on every apply, so removing the entry there would fail
  the deploy, and removing the key from that secret would break review.
  `deploy/delegate-secret.ts` is untouched by this plan, and a step that "removes
  the Anthropic key" by editing it is wrong.

### The gate

Step 7 is authorised by answers, not by a mood. Four questions, each answerable
from the swarm's own state and the pinned source:

1. **Is the session-summarisation caller actually producing summaries?** The code
   path is unconditional, but the evidence is in the swarm, not the source: rows
   in the memory index with `source: "session_summary"`, or `session_summary …`
   lines in the worker log streams. If summaries are being written, the key has a
   real consumer and removing it is a behaviour change to state out loud, not a
   tidy-up. If they are *not* being written, something already fails the call,
   and that is worth understanding before blaming the key.
2. **Same question for task auto-titles** — are recent tasks getting generated
   titles, and do the api logs show `[task-title] … via anthropic/claude-haiku-5-5`?
3. **If either is live, what replaces it?** This is where the honest answer is
   probably "the key stays, for these two callers only", and the plan's job
   becomes saying that precisely. The alternatives each cost something:
   `OPENROUTER_API_KEY` or `OPENAI_API_KEY` is a *new* credential, which is what
   this plan is trying not to add; `SKIP_SESSION_SUMMARY=1` and
   `TASK_AUTO_TITLE_ENABLED=false` make the loss deliberate and visible instead of
   silent, which is honest but is still a feature removal; an upstream change to
   teach `internal-ai` a credential kind it can reach in this account is the only
   answer that keeps both features and drops the key, and it is an agent-swarm
   change, not an ops one.
4. **What satisfies the `pi` readiness check once the key is gone?** A named
   upstream fix, a version bump that carries one, or `CRED_CHECK_DISABLE=1` — a
   real lever and a poor one, since it also turns off the check that would catch
   a genuinely missing Fireworks key. Step 7 names which in its PR body.

And one check that is not a question but a search: **does the swarm set the key
anywhere outside the secret?** `set-config` at agent scope, a live script, a
skill. The secret and this repository are not the whole surface, and a key in
swarm config survives every deploy.

Only then is deleting it from the secret safe. The order is: change the repo
(compose, render-env, fill-secrets, README, the test), deploy, confirm the stack
and a worker both come up healthy and a Fireworks task runs, and only after that
prune the key from the secret — the reverse order leaves a window where the
container env and the secret disagree and the failure looks like a credential
bug.

## What is NOT in scope

- **No second Bedrock account.** `394495727159` only. Not the workbench account,
  not the management account, not a new one.
- **No workbench Bifrost change.** No `deploy-workbench/` edit, no gateway
  provider, no virtual key, no alias. The gateway's own plan
  ([`bifrost-gateway.md`](./bifrost-gateway.md)) is untouched, and its
  "one principal may invoke" invariant is about that account.
- **No widening of `delegate-swarm-prod-read`.** It stays read-only, and the test
  that says so stays as it is. Nothing in Part A touches the management account.
- **No model other than the two named.** Not the other `WORKBENCH_MODELS`
  entries, not a `us.` profile of either of these, not a "spare" model for
  testing. A third model is an edit to this plan.
- **No new secret or API key**, in either half. Part A adds none, and Part B only
  removes one.
- **No change to the default model**, to `HARNESS_PROVIDER`, or to the
  `fireworks-us` provider block and its residency rules.
- **No probe.** `BEDROCK_AUTH_MODE` stays unset (decision 3), so no enumeration
  and no live Bedrock status in the console. Turning it on is a later decision
  with its own step.
- **`delegate/` and `deploy/`'s `DELEGATES` stack** are other deployments with
  other secrets and their own review requirements. Out of scope entirely.

## Rejected alternatives

Recorded so a later reader can tell these were considered rather than missed.
The first four are the decisions above, listed as what they reject; the rest are
the alternatives that came up while writing them.

- **Route through the workbench Bifrost gateway.** A cross-account hop, a virtual
  key, a second account's spend, and a dependency on a service in another account
  being up, to reach models whose profiles and agreements belong to this one. It
  buys cost attribution per key, which the swarm does not need — it is one
  workload. (Decision 1.)
- **Add the grant to `delegate-swarm-prod-read`.** The role's test asserts every
  action is a read, and the boundary it draws is "may look at production, may
  change nothing". A model invoke is not a read of production, it is spend and a
  second failure mode, and the account boundary exists to keep those apart.
  (Decision 1.)
- **Put the grant on the host role.** The host role reads the `DELEGATE_SWARM`
  secret and assumes the production-read role. A container that reaches IMDS
  would inherit both alongside the invoke grant, and the three have nothing to do
  with each other. (Decision 2.)
- **Set `BEDROCK_AUTH_MODE=sdk`.** It turns a failing Bedrock probe into a worker
  parked in the credential wait, which takes Fireworks work down with it. The
  gate reads the agent default, so leaving it unset keeps the default healthy
  while a per-task `amazon-bedrock/…` model still runs on Bedrock. (Decision 3.)
- **`BEDROCK_AUTH_MODE=bearer`.** Same gate, plus a Bedrock API key in the secret
  — a new long-lived credential in exactly the place Part B is trying to empty,
  for a scope the AWS role already gives.
- **Grant `ListInferenceProfiles` / `ListFoundationModels` "in case".** Nothing
  would call them: the enumeration they serve is off. `deploy-workbench/ecs.ts`
  grants one of them because Bifrost draws a model list from AWS; the swarm does
  not. A permission with no caller is the one that gets used accidentally.
  (Decision 4.)
- **Grant the whole invoke family because it is one line.** `Converse` and
  `ConverseStream` are what the harness calls. `InvokeModel` is a different API
  the harness does not use, and adding it "for symmetry" is the shape of grant
  that outlives its reason.
- **A second hand-kept model list in `deploy-infrastructure/`.** Two lists is the
  drift `utils/bedrock-models.ts` was created to stop — its header says so, and
  says what it cost the last time. The two ids are a selection from that list.
- **Pin the models in `models.json` so they appear in the picker.** The
  `fireworks-us` provider id exists there to *remove* models from pi's built-in
  catalogue. Adding `amazon-bedrock` blocks would fork pi's own Bedrock provider
  and lose its catalog and pricing; the picker's gap is a catalogue gap, and the
  overlay row is the mechanism this repo already uses for one.
- **Turn the probe on so the console lists the models for us.** It is the same
  failure as `BEDROCK_AUTH_MODE=sdk`: the picker's convenience is not worth a
  worker that parks when a Bedrock call fails.
- **Remove the Anthropic key now, on the strength of "no agent uses it".** That
  was PR #491, and it took the swarm's credential check down in production. The
  sentence in the README is about agents; the key also answers the `pi` readiness
  check and feeds session summarisation and task titles. Hence the gate.
  (Part B.)
- **Treat "the api service" as the consumer and call it answered.** Workflow LLM
  nodes reject an Anthropic credential, so the README's phrase points at the one
  caller that cannot be using it. The callers are the worker's session summary
  and the api's task titles, and they are found by reading `internal-ai`'s
  credential precedence, not by reading the README. (Part B.)
- **Assume Part A solves Part B.** It does not. Bedrock is reachable from a
  worker container through aws-config, but `internal-ai` has no Bedrock
  credential kind in v2.10.0 and the api container has no AWS access at all, so
  neither internal caller can be repointed at a Bedrock model without an upstream
  change. The two halves of this plan are independent.
- **`CRED_CHECK_DISABLE=1` as the answer to the readiness check.** It is the
  lever that exists, and it also disables the check that would tell us a Fireworks
  key had gone missing. If it is the answer, it is said out loud in step 7 with
  that cost written next to it, not slipped in.
- **A second model provider instead of Bedrock.** Fireworks stays the default;
  the point of these two is a credential and an account we already have, with no
  new key. That is also why this is not "add an OpenAI key".

## Implementation plan

Steps are staged so nothing consumes a grant that has not applied, and so each
one is a single PR or a single operational session. Several files this plan
names are owned by other changes in flight, so each step says which file it
touches; a step that finds a file already changed should rebase on it rather
than restate it.

1. **Subscribe the account to the two models.** The agreements are per account,
   and this account has none. `scripts/enable-bedrock-models.ts` is the existing
   answer and is *not* usable as it stands: its role, its credential resolution
   and its model list are all bound to the workbench account
   (`WORKBENCH_ACCOUNT_ID`, `arn:aws:iam::024901689212:role/pulumi-deploy`,
   `MODELS = WORKBENCH_MODELS`). Either parameterise it (it lives under
   `scripts/`, a human-owned path, and its `APPLY=1` mode accepts terms on
   GoodParty's behalf, so that edit deserves its own review) or run the
   subscription once out of band in an admin session the way workbench step 11
   did, and record what the report said.

   Report first, then `APPLY=1`. Record for each model: the agreement state, the
   region it was created in, and `GetFoundationModelAvailability` in us-west-2 —
   read the `agreement` field, not `entitlement` or `auth`, which report ready
   when no agreement exists at all (`workbench-account.md`, "What to check before
   and after"). Without this, the first invocation of an unsubscribed model
   works for up to fifteen minutes and then fails with AccessDenied, which reads
   like an outage.

2. **The role, its policy, and the host's one extra statement.** A new
   `deploy-infrastructure/bedrock-role.ts`, following `deploy-role.ts` and
   `preview-role.ts`: the trust and the policy document are exported constants so
   a test can read them without a Pulumi runtime, and a `createBedrockRole`
   function takes the explicit `provider` every resource in this project must
   name. `deploy-infrastructure/index.ts` calls it; `agent-swarm.ts` gains one
   statement.

   - A role named `delegate-swarm-bedrock`, trust principal
     `arn:aws:iam::394495727159:role/delegate-swarm-host`, `sts:AssumeRole` only,
     no condition — same stack, so the direct ARN is available (decision 2).
   - An inline policy (inline, matching the other scoped roles here) allowing
     `bedrock:Converse` and `bedrock:ConverseStream` on two models'
     `inference-profile` ARNs in this account and their `foundation-model` ARNs,
     region wildcarded, and nothing else. The ids come from
     `utils/bedrock-models.ts` by `id` lookup, not retyped, so a model's profile
     moving is one edit in the file that already owns that decision. That file is
     under `utils/`, which `.github/CODEOWNERS` keeps human-owned, so a PR
     touching it needs a human even though `deploy-infrastructure/` does not — the
     ids' single source of truth is worth that.
   - The host role's `AssumeProdRead` statement echoed for the new role: an
     `sts:AssumeRole` on its ARN added to `swarmHostPolicy` in `agent-swarm.ts`.
     Nothing else on the host role changes, and the existing `AssumeProdRead`
     stays as it is.
   - `protect` on the new role, as `pulumi-deploy` has: it is a credential path
     the containers depend on, and a replace is an outage that reads as an
     AccessDenied.

   Tests, in the style `deploy-infrastructure/agent-swarm.test.ts` already uses
   on the host policy: export the policy document as a pure function and assert
   (a) every action is one of the two invoke actions, (b) every resource names one
   of the two models, (c) no `bedrock:List*`/`Get*` and no wildcard action,
   (d) the trust admits only the host role, (e) the host policy gained exactly one
   statement.

   **`deploy/bedrock-invoke-principals.test.ts` will fail on this PR, and that is
   the tripwire working.** It asserts that the invoke actions appear in an
   enumerated set of files, and the list is meant to grow one reviewed entry at a
   time. The same PR adds this file to that list, with its comment updated to say
   why a second account now has an invoke grant. Do not "fix" it by widening the
   scan or by putting the actions in a file the test cannot see.

   Applied by `deploy-infrastructure.yml`, which already triggers on
   `deploy-infrastructure/**` and `utils/accounts.ts` — check the path filter for
   `utils/bedrock-models.ts` and add it if it is missing, since the ids now come
   from there.

3. **The credential switch.** `agent-swarm/host/aws-config`:

   ```ini
   [default]
   role_arn = arn:aws:iam::394495727159:role/delegate-swarm-bedrock
   credential_source = Ec2InstanceMetadata
   role_session_name = delegate-swarm
   region = us-west-2

   [profile prod-read]
   role_arn = arn:aws:iam::333022194791:role/delegate-swarm-prod-read
   credential_source = Ec2InstanceMetadata
   role_session_name = delegate-swarm
   region = us-west-2
   ```

   `region` is stated on both profiles rather than once. AWS does not carry a
   named profile's settings over from `[default]`, so a `prod-read` session with
   no `region` of its own is a session whose region depends on `AWS_REGION` or on
   the tool's default — and a Bedrock call with no region resolved is exactly the
   failure the "Region" section is about. The file has one `region = us-west-2`
   today, in `[default]`; the change keeps it there and adds the second.

   Two preconditions, and the step is not done until both are: the audit of
   bare-`aws` callers inside the swarm (README "Swarm state this repo owns";
   scripts and skills are live copies, not this repo's), and a re-read of the
   `agent-swarm/README.md` section "AWS access from inside the swarm" so the
   documented behaviour matches the file — after this change a bare credential is
   the infrastructure account, and production is `prod-read`. If the audit finds a
   caller that cannot carry a profile, use the fallback recorded under decision 2.

   `install.sh` already copies `aws-config` with `cp` rather than replacing the
   inode, because it is a single-file bind mount; nothing new is needed there.
   The verification is one command in a worker container:
   `aws sts get-caller-identity` must report the bedrock role, and
   `aws sts get-caller-identity --profile prod-read` must report
   `delegate-swarm-prod-read`.

4. **The two overlay rows.** `agent-swarm/host/sync-agent-config.sh`, following
   the `fireworks-us` row's shape and its comment style, and extending
   `agent-swarm/host/scripts/model-catalog-overlay.test.ts` to cover them. Note
   that `host/scripts/` is deliberately not uploaded to the host (`hostFiles` in
   `deploy-infrastructure/agent-swarm.ts` filters `scripts/` and `skills/`), so
   the test runs in CI and the script runs from the host's copy of `host/` — both
   from the same merge.

   Confirm on the console afterwards that the two models can be **selected**, not
   merely listed, and record what the picker says about the group. If a row is not
   enough (decision 3's cost), say so in the PR and leave the rows in place as
   catalogue metadata.

5. **Prove it, from inside a worker container.** Operational, no PR; the record
   is the PR bodies of steps 2 to 4 and, where it is not a git fact, ClickUp.

   - `aws sts get-caller-identity` — names the bedrock role.
   - A real `Converse` call to each model via the profile id, with the region
     recorded — `aws bedrock-runtime converse --model-id
     global.openai.gpt-6.1-sol …` and the same for the haiku profile, if the CLI
     build installed by `global-setup-script.sh` has the `converse` subcommand;
     otherwise a short `@aws-sdk/client-bedrock-runtime` script. Success proves
     the agreement, the region, the trust and the policy at once.
   - A refusal, deliberately: the same call for a model this plan does *not*
     grant (say `global.openai.gpt-6.1-terra`) must fail with an AccessDenied
     that names `bedrock:Converse` and this role. If it succeeds, the grant is
     wider than this plan says and step 2 is wrong.
   - The default, unchanged: a task with no model named still runs Fireworks,
     and the agent's runtime model is still the `fireworks-us/…` router.
   - If the region the call used is not us-west-2, go back to step 3 and set it
     explicitly.

6. **What consumes the Anthropic key.** Investigation, no code change, and no PR
   is required unless the answer belongs in the repo. Answer the four questions
   under "The gate" with evidence rather than inference: the swarm's own logs
   and tables (`session_summary` rows in the memory index, `[task-title]` lines
   in the api stream, `session_summary skipped` lines in the worker streams), the
   config that gates them (`SKIP_SESSION_SUMMARY`, `TASK_AUTO_TITLE_ENABLED`,
   `MEMORY_RATERS`, `MEMORY_RATER_MODEL`), and a search of swarm config for the
   key itself. Record the answers wherever step 7's PR can cite them.

   Two findings from the pinned source are already known and must be re-checked,
   not re-derived: `internal-ai` resolves an Anthropic credential for session
   summarisation and task titles because nothing else in this secret satisfies
   its precedence list, and the `pi` readiness check does not count
   `FIREWORKS_API_KEY` for a `fireworks-us/…` override. Those two, not the
   README's sentence, decide step 7.

7. **Remove the key, or record why it stays.** Two outcomes, both acceptable, and
   the PR (or a doc-only PR) says which and why:

   - **Stays:** name the callers and the surface. The README's sentence becomes
     true and specific — the worker's session summary and the api's task titles
     resolve an Anthropic credential, and nothing else does — instead of the
     current "api service and fallback path", which points at the one caller
     that rejects it. No code changes, and the open question about how the key
     is retired later stays open.
   - **Goes:** compose (both places), `render-env.sh`'s `REQUIRED_KEYS`,
     `fill-secrets.sh`, the README's three mentions, and the assertion in
     `fireworks-residency.test.ts` — one PR. **Not** `deploy/delegate-secret.ts`,
     which is the pr-reviewer stack's key list and a different secret. Then
     deploy, confirm the stack and a worker are healthy and that a Fireworks task
     runs end to end, and only after that prune the key from `DELEGATE_SWARM`
     (`fill-secrets.sh` has the prune pattern the reverted change wrote). The
     readiness-check answer and the summarisation/title answer both ship in that
     PR, or the worker parks and two features go quiet.

## Open questions

- **Whether the two internal callers are live, and what happens to them.**
  Step 6's answer. It decides whether Part B is a deletion or a precise
  paragraph. It cannot be read from the repository: the code path is
  unconditional, so the evidence is in the swarm's own rows and log streams.
- **Whether `internal-ai` should gain a credential kind this account can reach.**
  Today it knows `openrouter`, `anthropic`, `openai`, `openai-codex` and
  `claude-cli`, and the swarm has only two credentials in play: Fireworks, which
  it does not model, and Anthropic. A Bedrock kind would let the summariser and
  the titler run on the grant this plan creates, with no new key and no lost
  feature — but it is an agent-swarm change (a pinned-tag bump, or an upstream
  PR), not an ops one, and it is the only path that satisfies both "drop the key"
  and "keep the features". Recording it here so the trade in step 7 is a real one
  rather than "the key stays, then".
- **Whether an overlay row is enough for the console picker.** Step 4's
  verification. If not, selection by id works and the rows stay as metadata; the
  question is only about the console.
- **Cost and accounting for these two models in this account.** The swarm keeps
  its own price book keyed by harness and model id, and a Bedrock session
  records what pi reports. Whether an `amazon-bedrock/…` session lands as
  `pricing-table` or `unpriced` is not established here, and it does not change
  the money — only the badge and the "trusted spend" coverage. Worth one check
  during step 5 and a paragraph afterwards, not a step.
- **Whether the Bedrock budget needs a guard of its own.** Two opt-in models are
  cheap; a task left running on one is not. The infrastructure account's budget
  (step 10 of `infrastructure-account.md`) covers the account and would fire late
  rather than early. No decision here; if per-model alarms are wanted, they are a
  component of their own.
- **Retirement path for the Anthropic key's Anthropic *workspace*.** The key is
  tied to the "agent-swarm" workspace, which carries a spend limit. Deleting it
  from the secret does not retire the key; revoking it in the console is a
  separate, human action, and worth doing once nothing reads it.
