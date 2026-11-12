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

- **Part A, steps 1 to 6** — the two-model grant. Model subscriptions, the
  dedicated role with its control-plane reads, the credential switch, the
  readiness gate, the model-tier mapping, and the proof.
- **Part B, steps 7 to 9** — the Anthropic key. Turn the two `internal-ai` features
  off, remove the key from every surface including the secret, and correct the
  README. The decision is made; these steps execute it.

- [ ] 1. Subscribe `394495727159` to the two models. Reporting first, then
      `APPLY=1`, and the account id and agreement outcomes recorded.
- [ ] 2. Create `delegate-swarm-bedrock` in `deploy-infrastructure/`, with an
      invoke grant scoped to those two models, the two control-plane reads the
      readiness probe needs, and nothing else; trusted by the swarm host role,
      which is given `sts:AssumeRole` on it.
- [ ] 3. Point `agent-swarm/host/aws-config` at the new role as `[default]` and
      demote `delegate-swarm-prod-read` to `[profile prod-read]`, after auditing
      what reaches for `[default]` today.
- [ ] 4. Set `BEDROCK_AUTH_MODE=sdk` and `AWS_REGION` in the worker and api
      environments, so the readiness check is satisfied by the AWS credential
      rather than by an API key.
- [ ] 5. Prove it: an invocation of each model from a worker container, with the
      ARNs and the refusal shape recorded, the model list the probe enumerated,
      and the Fireworks default re-checked in the same session. Operational, no
      PR.
- [ ] 6. Propose the `MODEL_TIER_PI_*` mapping, so "hard" tasks can be routed to
      a Bedrock model while `smol` and `regular` stay on Fireworks. A proposal for
      the engineer to confirm, applied through swarm config.
- [ ] 7. Turn the two `internal-ai` features off: `SKIP_SESSION_SUMMARY=1` on the
      workers and `TASK_AUTO_TITLE_ENABLED=false` on the api, both with the reason
      recorded. This is what leaves the key with no consumer.
- [ ] 8. Remove `ANTHROPIC_API_KEY` from every surface — compose (worker **and**
      api), `render-env.sh`'s `REQUIRED_KEYS`, `fill-secrets.sh`, the README, the
      residency test — and then prune it from the `DELEGATE_SWARM` secret. Lands
      after #523, whose api line and "stays here and only here" comment this step
      reverses.
- [ ] 9. Record the gap: `agent-swarm/README.md` names the two switches that are
      off, what is lost (no session summaries, so memory and ranking degrade on
      long sessions; task titles fall back to the prompt), and that an
      `internal-ai` credential kind is the upstream fix. Unowned follow-up.

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

Four invariants, stated as properties rather than features:

- **Two models are reachable from a worker container, through the AWS credential
  chain, and no other model is.** Not "Bedrock works": a named pair, invoked by a
  role whose only other Bedrock permissions are the two reads the readiness probe
  calls.
- **The default does not move.** A task that names no model and no tier still runs
  Fireworks, on the same router id. A change here that risks the default is a
  change that is wrong.
- **No new key.** Bedrock authenticates through the AWS SDK's chain, which in
  that container means the instance role from IMDS. Nothing is added to
  `DELEGATE_SWARM` to enable this.
- **The swarm has no explicit Anthropic dependency.** Not "the key is justified
  if it turns out to be used": it goes, and the two `internal-ai` features that
  read it are turned off rather than the key being kept alive for them. The
  readiness job it also did — satisfying the worker's `pi` credential check — is
  taken over by the Bedrock probe (decision 3), which is what makes the removal
  possible at all. Steps 7 to 9 execute this; none of them is optional.

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
| Bedrock reads it also holds | `bedrock:ListFoundationModels`, `bedrock:ListInferenceProfiles` (the probe) |
| Readiness satisfier | `BEDROCK_AUTH_MODE=sdk`, region us-west-2, on the worker env |
| Tier mapping (proposed) | `MODEL_TIER_PI_SMART` → `amazon-bedrock/global.openai.gpt-6.1-sol` |
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

## Decision 3: `BEDROCK_AUTH_MODE=sdk` is set, deliberately

**Decision: `BEDROCK_AUTH_MODE=sdk` is set on the pi workers' environment, and
`AWS_REGION` with it. The Bedrock readiness probe becomes the thing that satisfies
the `pi` credential check, which is what lets `ANTHROPIC_API_KEY` leave the
swarm.** The api container is deliberately not included: it has no AWS access at
all today, so a Bedrock auth mode there would only park it.

**This reverses what this plan first said**, and the reasoning that replaces it
came from review of PR #524 rather than from the first draft. The original
decision was to leave the variable unset so the gate would never be entered,
because the gate is hard. That was correct about the mechanism and wrong about
the trade: leaving it unset keeps a key nobody wants and forces a picker
workaround, so the plan paid two prices to avoid one coupling it was going to
accept anyway. Both halves of that are recorded below.

What the pin does, verified in agent-swarm v2.10.0
(`src/providers/pi-mono-adapter.ts`, `checkPiMonoCredentials`):

- **The Bedrock branch is evaluated first, and it does not depend on
  `MODEL_OVERRIDE`.** `isBedrockSdk` is true when `BEDROCK_AUTH_MODE=sdk`, full
  stop; the `MODEL_OVERRIDE` prefix check is the *fallback* for when the variable
  is absent. So a worker with the variable set takes the Bedrock branch no matter
  which model its agent runs, including a `fireworks-us/…` one.
- **On a successful probe it returns `{ ready: true, satisfiedBy: "sdk-delegated" }`.**
  That is the whole point: the `pi` readiness check is satisfied by an AWS
  credential, and no `ANTHROPIC_API_KEY` is involved. This is what makes Part B's
  removal possible at all — see the reversal recorded there.
- **The probe is what enumerates the models.** It calls `ListFoundationModels`
  and `ListInferenceProfiles`, intersects the result with the ids pi-ai can
  drive, and returns them as `bedrockModels`. The worker reports that list, and
  the console's Bedrock group goes `enabled: true` with those two models in it
  (`apps/ui/src/lib/agent-runtime-models.ts` prefers `liveBedrockStatus` when it
  is present). **So the overlay rows this plan first proposed to work around the
  picker are no longer needed** — the probe supplies the list, and "The model
  catalogue overlay" keeps them only as optional metadata for a fact the probe
  does not carry; if no such fact survives, they are dropped. This is a cost
  *removed*, not added.
- **`AWS_REGION` becomes load-bearing, not a question.** The probe reads
  `env.AWS_REGION` and, when it is absent, returns `ready: false` with "set it to
  the region where your Bedrock models are accessible" rather than guessing. The
  containers did not receive `AWS_REGION` when this plan was written
  (`agent-swarm/host/docker-compose.yml` enumerates them, and the systemd unit
  sets it for the compose process only); sibling PR #523 adds it to
  `x-worker-env`, so by the time this lands the variable should be there and step
  4's job is only `BEDROCK_AUTH_MODE`. Treat it as a requirement either way — see
  "Region".

**The cost, which the engineer has explicitly accepted: a failed probe parks the
whole worker, Fireworks tasks included.** In `sdk` mode a probe failure returns
`ready: false` with a classified hint, and the boot path parks in the credential
wait loop (`src/commands/credential-wait.ts`) — `BOOT_MAX_WAIT_SECONDS` defaults
to "forever". So a missing agreement, a region that has not propagated, a trust
change, or an IAM edit that drops a read takes the worker out of service even
though its Fireworks credential is fine.

Why that is the right trade now, in the order that decided it:

1. **It removes a long-lived API key.** The worker's readiness no longer depends
   on a credential nobody wants to keep, which is Part B's whole goal.
2. **It removes the picker workaround.** The probe is the enumeration the overlay
   rows existed to imitate badly.
3. **It is the same credential the Bedrock path will use anyway.** The invoke
grant and the probe read sit on one role assumed from the instance, so the check
is testing the exact path a Bedrock task will take — unlike the permissive-key
branch, which tests for `ANTHROPIC_API_KEY` while a Fireworks task uses
`FIREWORKS_API_KEY` it never looks at.
4. **The coupling is already load-bearing.** A worker that cannot reach the AWS
   credential chain has no Bedrock path at all; the probe merely says so at boot
   instead of at the first task.

**Rollback, recorded so a park is not a dead end.** Unset `BEDROCK_AUTH_MODE` and
the old permissive-key branch returns: the worker boots on whatever API key it
holds, at the cost of needing some other readiness satisfier — which, for a
`fireworks-us/…` `MODEL_OVERRIDE`, means an `ANTHROPIC_API_KEY` in the secret
again, because `FIREWORKS_API_KEY` is not in `modelToCredKeys`' permissive list.
That is the state this plan is leaving, and the price of going back to it is
reinstating the key. It also means the interactive escape hatch for a parked
worker is one variable, not a redeploy.

**What does not change.** Per-task and per-agent model selection is untouched.
A task or an agent whose model is `amazon-bedrock/<profile-id>` runs on Bedrock
because `amazon-bedrock` is a built-in pi provider (`bedrock-converse-stream`,
via pi-ai's `amazon-bedrock` provider and `ConverseStream`), and per-task model
resolution outranks `MODEL_OVERRIDE` on the claim path
(`src/be/model-tier-resolution.ts`; the runner uses the server's
`resolvedModel`). The agents' default stays `fireworks-us/…`, and the probe
being on does not move a Fireworks task onto Bedrock.

## Decision 4: the two control-plane reads belong on this role

**Decision: `delegate-swarm-bedrock` holds `bedrock:ListFoundationModels` and
`bedrock:ListInferenceProfiles` on `*`, in addition to the two models' invoke
grant.**

**This also reverses the first draft**, and it reverses as a consequence rather
than a second judgement: the reads exist to serve the probe, the probe is now on
(decision 3), so the reads have a caller. A permission that serves a stated,
enabled mechanism is the kind of grant this plan should be making; the first
draft's rule was not "no reads", it was "no reads without a caller", and the
caller has arrived.

Where they come from, exactly. `runBedrockSdkProbeAndEnumerate`
(`src/providers/pi-mono-adapter.ts`) imports `BedrockClient` and calls
`ListFoundationModelsCommand` with `byInferenceType: "ON_DEMAND"`,
`byOutputModality: "TEXT"`, and then `ListInferenceProfilesCommand`. Two reads,
both of them, plus nothing else. The intersect-with-pi-ai step is client-side, so
it needs no further AWS call.

Both resources are `*`, and that is not laziness. Bedrock's service authorization
reference defines no resource type for either action — no model ARN, no profile
ARN — so a narrower `Resource` fails rather than scoping the call. This is the
same fact `deploy-workbench/ecs.ts` records for `ListFoundationModels` in
`TASK_BEDROCK_READ_ACTIONS`, and it is why the wildcard here is named and
commented rather than dropped into the invoke statement.

**The asymmetry with `deploy-workbench/ecs.ts` is now the reverse, and worth
stating because a reviewer will notice.** That role grants `ListFoundationModels`
and deliberately not `ListInferenceProfiles`, because Bifrost at `v2.3.0` never
calls the latter: it lists inference profiles from its own key allowlist. The
probe here is agent-swarm's, not Bifrost's, and agent-swarm calls both — the
gateway's reading of "the model list" does not carry over, and copying its
narrower grant would fail the probe on the second call. So this role holds one
read Bifrost does not need, for a reason recorded in agent-swarm's code rather
than inferred.

The invoke actions are unchanged by this: the harness calls the Converse API
(`ConverseStreamCommand` from `@aws-sdk/client-bedrock-runtime`, via pi-ai's
`bedrock-converse-stream`), so the invoke grant is `bedrock:Converse` and
`bedrock:ConverseStream`. `InvokeModel` and `InvokeModelWithResponseStream` are
*not* granted. Step 5 records whatever the invocation proves, and widening to the
invoke pair afterwards is a one-line change with a reason.

Invoke resources keep the shape `bedrockInvokeResources()` in
`utils/bedrock-models.ts` already uses, restricted to two models: each model's
`global.` inference-profile ARN in this account, plus the foundation-model ARN
(which carries no account) for routing outside the home region. Both are needed
and neither alone is enough — the request names the profile, and Bedrock then
invokes the foundation model wherever the global profile routes — and the region
is wildcarded on purpose, for the reasons that file records.

**What the reads do not buy.** They enumerate models the account can *see*, not
models this role can *invoke*: `ListFoundationModels` reports what exists in a
region, so the probe's list is wider than the two-model grant and a model picked
from it that is not one of the two fails at invocation with an AccessDenied. That
is the correct failure — the grant is the allowlist, and it stays two models —
but it means the picker can offer a model that will not run, and step 5 should
record what the list actually returns so the size of that gap is known rather
than guessed. Narrowing the *list* would mean filtering it client-side, which is
an agent-swarm change; narrowing the picker is not this plan's job.

## Model tiers: routing "hard" tasks to a Bedrock model

**This is what makes the two models useful rather than merely present.** A tier is
a per-task hint — `modelTier: smol | regular | smart | ultra` — that the API
resolves at claim time to a concrete model. Because the tier map is swarm config,
the swarm can route work by difficulty without every task naming a model and
without a code change.

**Today tiering does not work in this swarm at all, and that is not this plan's
fault.** `DEFAULT_MODEL_TIER_MAP.pi` (`src/types.ts`) points all four tiers at
`openrouter/…` ids — `openrouter/deepseek/deepseek-v4.1-flash` for `smol` and
`regular`, `openrouter/deepseek/deepseek-v4-pro-0813` for `smart`,
`openrouter/anthropic/claude-opus-5.5` for `ultra` — and the swarm holds no
OpenRouter credential. So a tiered task already resolves to a model with no key
and fails. Adding tier-config rows is what turns tiering *on*; Bedrock is what
makes it possible to turn on usefully. Nothing here regresses: a tiered task does
not work less well after this change than before it.

The precedence, first hit wins, verified at v2.10.0 in
`src/be/model-tier-resolution.ts` (`taskModelCandidates`) and `src/types.ts`:

1. the task's `model` — an explicit pin;
2. the task's `profile` — a named model profile;
3. the claiming worker's `MODEL_TIER_<PROV>_<TIER>` (worker-env);
4. `swarm_config` `MODEL_TIER_<PROV>_<TIER>` (tier-config);
5. `DEFAULT_MODEL_TIER_MAP` (tier-default), or the seeded `<harness>-<tier>`
   profile when one exists;
6. the agent's default profile.

**Layer 4 is the one to set.** It outranks the seeded default map, it is
`swarm_config` rather than code, and for the `pi` harness the key form is
`MODEL_TIER_PI_<TIER>` — `tierConfigKey` upper-cases the provider and replaces
dashes, so `pi` gives `MODEL_TIER_PI_SMOL` and so on. Setting those four keys is
the whole change; no deploy, no code.

### The mapping, as a proposal

The plan proposes this and **the engineer confirms it**; it is not a decision this
plan makes on their behalf, because which model a `smart` task should get is a
judgement about cost and quality that belongs with whoever pays for it.

| Tier | Model | Why |
|---|---|---|
| `smol` | Fireworks DeepSeek router (unchanged) | the default, and the cheapest thing that works |
| `regular` | Fireworks DeepSeek router (unchanged) | ditto — most tasks live here |
| `smart` | `amazon-bedrock/global.openai.gpt-6.1-sol` | the reason this plan exists: a stronger model on hard work |
| `ultra` | the engineer's call, possibly Sol as well | there is no third Bedrock model, so "ultra" is either Sol again or the Fireworks default |

Two honest notes about it:

- **`ULTRA` has no distinct answer**, because the grant is two models and one of
them is the `smart` choice. Pointing `ultra` at Sol makes it identical to `smart`,
which is harmless but means the tier carries no information; pointing it back at
Fireworks would make `ultra` *weaker* than `smart`, which is worse. Two ways out,
neither in this plan: a third Bedrock model (costs an edit to this plan and to
`utils/bedrock-models.ts`), or leaving `MODEL_TIER_PI_ULTRA` unset so it falls
through to the seeded default — which is an `openrouter/…` id and therefore fails,
so that is not really a way out either. Recorded so `ultra` is a known gap rather
than an oversight.
- **The validation is real.** `validateTierConfigValue` (`src/be/model-tier-keys.ts`)
  rejects whitespace, over-long values and — relevant here — a model that
  `harnessModelMismatch` says does not run on the `pi` harness. A
  `MODEL_TIER_PI_SMART` of `amazon-bedrock/global.openai.gpt-6.1-sol` passes,
  because the `pi` harness is not one of the section-pinned harnesses and an
  uncatalogued id defers to the caller's custom-model check. The tier rows
  therefore need no `allow_custom_model` dance of their own; the agent runtime
  PATCH in `sync-agent-config.sh` is a different route with a different rule.

Step 6 is where these are set, and where the console's tier preview
(`GET /api/models-catalog/tiers`, `previewModelTiers`) is read to prove each tier
resolves to what the table says.

## The model catalogue overlay: now optional, and probably not needed

**This section is what is left of a workaround that decision 3's reversal made
unnecessary.** It stays in the document because the rows may still be worth
having, and because deleting the reasoning would lose why.

The first draft needed overlay rows because nothing enumerated the models: with
no probe the console's Bedrock group stayed at `enabled: false` and the models
were unpickable. With `BEDROCK_AUTH_MODE=sdk` the worker runs the probe, reports
`bedrockModels`, and the group goes `enabled: true` with the live list
(`apps/ui/src/lib/agent-runtime-models.ts`, `liveBedrockStatus`). The picker
problem is solved by the mechanism that was already there.

So the rows are `agent-swarm/host/sync-agent-config.sh` rows the plan proposes
rather than requires — `PUT /api/models-catalog/overlay`, keyed on provider and
model id, the same path the `fireworks-us` row uses. What they would still add is
facts the probe does not carry: the probe returns `{ id, name }` only, and the
picker cross-references the static snapshot *best-effort* for reasoning levels
and context window, treating a miss as unrestricted. Both these models are in
that snapshot at v2.10.0, so the cross-reference should hit and the rows buy
nothing. **Propose them only if step 5 shows a fact the console gets wrong**, and
otherwise drop them — a row written for a reason that has gone is exactly the
kind of thing that is never removed later.

If a row is written anyway, two things to get right, both learned from the
`fireworks-us` row:

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
  should be allowed to delete itself.

Either way these rows are display metadata. They never touch the swarm's price
book, so they do not change what a session is charged — the same caveat the
README's "Models" section records at length for `fireworks-us`.

## Region: a required setting, not a question

`docker-compose.yml` enumerates every environment variable a container receives,
and `AWS_REGION` is not among them; the systemd unit sets `AWS_REGION=us-west-2`
for the compose process, not for the containers. That was harmless while nothing
in a container picked a region. It is not harmless any more: **the Bedrock probe
reads `env.AWS_REGION` and refuses to run without it.**

`checkPiMonoCredentials` returns `ready: false` with "AWS_REGION is not set — set
it to the region where your Bedrock models are accessible so model enumeration
matches the inference region" rather than guessing a region, and the comment in
that branch is explicit about why: a guessed `us-east-1` can enumerate the wrong
region's models. With decision 3 in force that is a **boot-blocking** condition,
not a warning — a worker without `AWS_REGION` parks. So step 4 sets it in
`x-worker-env` alongside `BEDROCK_AUTH_MODE`, and the two travel together.

us-west-2, and the reasons stack up rather than being arbitrary:

- it is the account's and the host's region (`utils/accounts.ts`,
  `deploy-infrastructure/agent-swarm.ts`);
- the probe enumerates the region it will be asked to infer in, which is the
  property that branch exists to preserve;
- pi-ai's own resolution order is ARN-embedded region, then an explicit option,
  then `AWS_REGION`, then `AWS_DEFAULT_REGION`, then the model's `baseUrl`, then
  `us-east-1`. Both these models' bundled `baseUrl` is the us-east-1 endpoint, so
  without `AWS_REGION` the endpoint path would win and the call would go to
  us-east-1 while the probe enumerated us-west-2. Setting the variable makes the
  two agree.

Two things that follow and are worth stating:

- The IAM grant wildcards region and a `global.` profile routes wherever AWS
  chooses, so us-west-2 is not an authorization boundary and a us-east-1 call
  would not have been *refused*. It is a "which endpoint did we actually talk to"
  fact, which decides what CloudTrail and VPC flow logs show — and now also what
  the probe enumerated, so getting it wrong is visible as a mismatch between the
  picker's list and a working invocation.
- `AWS_PROFILE` must stay unset in the container env, and the probe is why it
  matters more now. pi-ai treats a set `AWS_PROFILE` as a reason *not* to pin the
  model's endpoint, and it resolves `AWS_PROFILE` ahead of the ambient chain. This
  plan's aws-config change makes `[default]` the Bedrock role, so an empty
  `AWS_PROFILE` is what the probe and the invoke path both use; a `prod-read`
  value here would fail the probe on the read actions and fail every invocation
  on the invoke ones.

## Part B: removing the Anthropic key

**The engineer has decided this: the swarm carries no explicit Anthropic
dependency.** `agent-swarm/README.md` says today that `ANTHROPIC_API_KEY` "stays in
the secret and in the worker env for the api service and as a fallback path, but no
agent runs an Anthropic model". That sentence is two claims, and only the second is
one anybody had checked. What the pinned source shows is that the first is wrong in
an interesting way: the "api service and fallback path" it names is the one caller
that *rejects* an Anthropic credential, while two other callers resolve one
silently. The decision below is the consequence — the key goes, and the two callers
that needed it are turned off, because there is no supported way to run them on
this plan's Bedrock models.

### What the pinned source says

Everything here was read in agent-swarm v2.10.0, the tag
`agent-swarm/host/render-env.sh` pins, not recalled.

- **Verified: no agent needs it.** Every agent runs `pi` against `fireworks-us/…`
  (`HARNESS_PROVIDER=pi`, both `*_MODEL_OVERRIDE`s), and pi has no
  cross-provider fallback. Bedrock needs nothing from it either: Bedrock
  authenticates through the AWS credential chain, which is the whole point of
  Part A.
- **Verified: two internal callers do, and neither is the "fallback path".**
  agent-swarm's `internal-ai` layer resolves a credential by
  walking `openrouter → anthropic → openai → openai-codex → claude-cli`
  (`src/utils/internal-ai/credentials.ts`, `CREDENTIAL_KIND_PRECEDENCE`), and
  this swarm's secret has none of `OPENROUTER_API_KEY`, `OPENAI_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN`. So Anthropic is the only kind it can satisfy. Two
  callers reach that path:
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
  deleting the key does not break anything loudly — it silently stops writing
  session summaries and stops titling new tasks, which is why step 7 flips the
  switches *first*: an intended stop is a decision, and the same stop by accident
  is a bug that takes a day to find.

  Note what is *not* a consumer: **workflow LLM nodes reject an Anthropic
  credential outright** — `resolveWorkflowLlmConfig` accepts only `openrouter`
  and `openai` kinds and throws otherwise (`src/workflows/executors/workflow-llm.ts`).
  So the README's "api service … fallback path" is neither of the two real
  callers, and correcting that sentence is part of step 9.
- **Verified, and until decision 3 was reversed it was the reason this looked
  blocked:** the key is load-bearing for the *credential check* even though no
  agent uses an Anthropic model. `checkPiMonoCredentials` maps `MODEL_OVERRIDE` to required
  keys, and `fireworks-us/…` is not a provider it recognises: `modelToCredKeys`
  returns `null` for it, which selects the permissive case — "any one of
  `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `OPENAI_API_KEY`"
  (`src/providers/pi-mono-adapter.ts`). `FIREWORKS_API_KEY` is not in that list
  and no `~/.pi/agent/auth.json` exists in the worker, so on the permissive path
  a key-less secret fails the readiness check and the boot loop parks. This is not
  a theory: PR #491 removed the key for the right reason (a stray Anthropic model
  pin would bill about 9× the Fireworks price) and the swarm stopped detecting a
  valid credential in production, and it was reverted in `88a5a1f`. That commit
  and its revert are the record.

  **`BEDROCK_AUTH_MODE=sdk` retires this problem rather than working around it.**
  The Bedrock branch is checked above the permissive one and returns
  `satisfiedBy: "sdk-delegated"` on a successful probe, so the readiness check is
  answered by the AWS credential and never reaches the list that names
  `ANTHROPIC_API_KEY`. That is why step 4 comes before the key's removal: the
  key's last load-bearing job in the worker is discharged by an IAM role, and the
  fix for #491 is the same change that lets the key go.

So removing the key is two problems. The readiness half is solved by Part A. The
other half is the two `internal-ai` callers, and it is solved by turning them off
rather than by re-pointing them: `internal-ai` has no credential kind this
account can satisfy, and the api container has no AWS access at all
([`../agent-swarm/README.md`](../agent-swarm/README.md), "AWS access from inside
the swarm"), so a Bedrock model is not reachable from either caller. Part A makes
the removal *possible*; the decision below makes it complete.

### The surfaces that carry it

Every one of these goes. The key is being removed, not re-pointed, so there is no
surface that keeps it.

| Surface | What it does | What removal means |
|---|---|---|
| `agent-swarm/host/docker-compose.yml` | `ANTHROPIC_API_KEY` in `x-worker-env` (all three agents) **and** in the `api` service env | drop both. The api line is the one PR #523 argued to keep; see below |
| `agent-swarm/host/render-env.sh` | `ANTHROPIC_API_KEY` in `REQUIRED_KEYS`, and the render flushes *every* secret key into `.env` | drop it from `REQUIRED_KEYS`; the flush then has nothing to flush |
| `agent-swarm/fill-secrets.sh` | asks for it ("3/5 Anthropic key"), and lists it in the final missing-key report | stop asking, stop listing, and prune it from an older secret the way the reverted change did |
| `agent-swarm/README.md` | the "Where it runs" key list, the "Models" paragraph quoted above, and the "Bringing it up" step 2 | correct all three, and **name the two switches now off and why**, in the same PR |
| `agent-swarm/host/scripts/fireworks-residency.test.ts` | asserts the key's presence in compose | invert the assertion; it is the test that will fail otherwise |
| `DELEGATE_SWARM` secret | holds the value | prune it. This is the step that makes "no explicit Anthropic dependency" true rather than aspirational |

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
  the Anthropic key" by editing it is wrong. This is the one Anthropic dependency
  in the repository that stays, and it belongs to a different deployment with its
  own review requirements.

### Decision: no explicit Anthropic dependency

**Decision, made by the engineer: the swarm carries no explicit Anthropic
dependency. The two `internal-ai` features that resolve an Anthropic credential are
turned off, and `ANTHROPIC_API_KEY` comes out of the secret. This is not an open
choice with a recommendation attached; it is what the plan now does.**

It supersedes an earlier draft of this section that priced three options — keep the
key, drop the features, or add an OpenRouter key — and leant towards keeping the
key. That draft was written as if "the features have no replacement" were a reason
to keep a credential. The engineer's answer is the better one: a credential the
organisation has decided it does not want is not made acceptable by the features
hanging off it, and the honest response to "there is no replacement yet" is to turn
the features off and record the gap, not to keep the key alive indefinitely.

#### Why Bedrock is not the answer here

This is the question the decision turns on, and the answer is **no**. Bedrock is
not a supported credential source for `internal-ai` at agent-swarm v2.10.0, and the
reasons are structural rather than configuration:

- **`CredentialKind` is a closed union with no Bedrock member.** It is
  `"openrouter" | "anthropic" | "openai" | "openai-codex" | "claude-cli"`
  (`src/utils/internal-ai/models.ts`). `resolveCredential` walks
  `CREDENTIAL_KIND_PRECEDENCE` and can only ever return one of those five, so it
  can never hand `completeStructured` a Bedrock credential. There is nothing to
  configure — the type has no place to put one.
- **`PROVIDER_TO_KIND` maps only those provider prefixes.** `kindForModelString`
  returns `null` for anything else, `DEFAULT_MODEL` and
  `MEMORY_RATER_DEFAULT_MODEL` are `Record<CredentialKind, string>` with an entry
  per member and no more, and `credentials.ts`'s `resolveKind` switches on exactly
  those five. An `amazon-bedrock/…` model string is not merely unwired; it has no
  kind to belong to.
- **`src/utils/internal-ai/register-bedrock.ts` looks like the missing piece and is
  not.** Its own header says what it is: a Bun `--compile` bundler workaround. pi-ai
  loads its Bedrock provider through a lazy `import("./amazon-bedrock.js")` that the
  compiled binary cannot resolve ("Cannot find module './amazon-bedrock.js' from
  '/$bunfs/root/agent-swarm'"), and the module calls `setBedrockProviderModule` to
  wire it statically. It adds no credential kind, resolves no credential, and is not
  a supported path for `internal-ai` calls. **Recorded explicitly because finding
  that file is exactly how someone concludes Bedrock *is* supported and is wrong** —
  it is a packaging fix for the harness's own model calls, one layer below the
  abstraction this section is about.

And the readiness work does not change this. `BEDROCK_AUTH_MODE=sdk` makes a
worker's `pi` credential check pass via `satisfiedBy: "sdk-delegated"` (decision
3), which is what lets the key leave the *worker*. It does not reach `internal-ai`,
which is a separate layer inside both the worker and the api with its own closed
list of credential kinds. Two different questions that happen to involve the same
account: "can this harness authenticate" is answered by the probe, "can
`internal-ai` make a structured call" is answered by `CredentialKind`.

#### What is turned off, and what it costs

Two switches, both verified at v2.10.0, both environment variables that this repo
already passes through — no agent-swarm change is needed to turn either off.

**Worker: `SKIP_SESSION_SUMMARY=1`.** Gates the shutdown summariser at
`src/providers/pi-mono-extension.ts:763-766`, which logs
`session_summary skipped (pi): SKIP_SESSION_SUMMARY is set`. It is read through
`isSessionSummarySkipped` → `parseEnvFlag`, so any of `1`/`true` works. Off, the
worker does not call `summarizeSession` at all, and with it goes the
`POST /api/memory/index` at shutdown and the `MEMORY_RATERS` ratings that ride on
the same call.

**Api: `TASK_AUTO_TITLE_ENABLED=false`.** Gates `startTaskAutoTitleListener`;
`isTaskAutoTitleEnabled` uses `parseEnvFlag(env.TASK_AUTO_TITLE_ENABLED, true)`
(`src/be/task-auto-title-listener.ts:10, 26-28`), so it defaults on and reads the
flag per event, meaning a config reload applies without a restart. This is a
swarm-config value rather than only a container env, since the api reads
`process.env` that `loadGlobalConfigsIntoEnv` hydrates.

**The cost of losing summaries, stated plainly.** The session summary is the only
record of what a long session learned: it is what lands in the memory index, and
the `MEMORY_RATERS` ratings that rank memories later are produced from the same
call. With it off, a long session leaves its transcript and nothing else, so the
memory and ranking path degrades **exactly where there is the most context to
lose** — the long, expensive sessions that most needed a summary. Re-reading the
transcript is the fallback and it is a worse one: transcripts are large, and
memory is what makes them retrievable rather than merely stored.

**Task titles cost almost nothing.** A task keeps its prompt as the display
title, which is what the sidebar already falls back to when no title was
generated (`task-auto-title-listener.ts` says so in its header: "a failed or
skipped generation changes nothing visible"). So this one is readability, not
behaviour: untitled tasks show a prompt fragment where a summary line would be.

**Both losses are silent, and that is the part to engineer around.** Neither
writes an error, because both return a graceful no-op when there is nothing to
call with; a missing summary looks like a memory feature that never fired, and an
untitled task looks like one somebody forgot to name. `agent-swarm/README.md` must
name both switches, what is off, and why, in the same PR that removes the key —
otherwise the next reader debugs a bug that is a decision.

#### The replacement that does not exist yet

The durable fix is not config: it is an `internal-ai` credential kind this account
can actually satisfy — Bedrock, or a `fireworks` kind reading `FIREWORKS_API_KEY`,
which the swarm already holds. Either way it means a member on `CredentialKind`, an
entry in `PROVIDER_TO_KIND`, a `resolveKind` branch, defaults in `DEFAULT_MODEL`
and `MEMORY_RATER_DEFAULT_MODEL`, and the tests that pin all of it
(`src/tests/internal-ai/credentials.test.ts`, the same directory's `models.test.ts`,
and `complete-structured.test.ts` / `summarize-session.test.ts` beside them).

That is an upstream agent-swarm change, not something ops can enable by config, and
**it is unowned** — no step in this plan does it, and nothing here assumes it
arrives. Recorded so the gap has a name and the next person to want summaries back
starts from a design rather than from re-adding the key. If it does land, turning
the two switches back on is the whole reversal.

#### Consequence for the key

With both consumers off, `ANTHROPIC_API_KEY` has **no remaining consumer anywhere in
the swarm**: not the workers (which run Fireworks, and whose readiness is satisfied
by the Bedrock probe), not the api (whose only use of it was task titles), not
`internal-ai` in either process. So it comes out of *the secret*, not merely out of
the container env — the difference matters, because a key left in `DELEGATE_SWARM`
is one `render-env.sh` run away from reappearing in `.env` and one revert away from
reappearing in a container.

**This reverses what PR #523 currently assumes.** #523 keeps the key on the api
service, with a comment saying it "Stays here and only here" because removing it
"silently disables generated task titles". That sentence was correct when written
and is now the *intent* rather than a hazard: titles going away is the decision, not
the accident. Steps 8 and 9 name #523 so the two changes agree, and the api's line
and that comment come out with the rest.

#### Two checks before the removal

They no longer decide anything — the decision is made — but they say what to
expect and what else might need attention:

- **Are the callers producing output today?** Rows in the memory index with
  `source: "session_summary"`, `session_summary …` in the worker streams,
  `[task-title] … via anthropic/claude-haiku-5-5` in the api stream. If they are
  already dead, the loss is smaller than this section assumes, and *why* they are
  dead is worth knowing before the key goes; if they are alive, expect both to
  stop and expect nobody to notice until somebody looks.
- **Does the swarm set the key anywhere outside the secret?** `set-config` at agent
  scope, a live script, a skill. The secret and this repository are not the whole
  surface, and a key in swarm config survives every deploy — so it has to go too,
  or the "no explicit Anthropic dependency" claim is false in a place nobody
  greps.

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
- **No new secret or API key.** Part A adds none, and Part B removes one. Adding
  an OpenRouter key to keep the two `internal-ai` features alive was considered and
  is not what the engineer decided: it would swap one long-lived credential for
  another, which is the thing this plan exists to stop.
- **No change to the default model**, to `HARNESS_PROVIDER`, or to the
  `fireworks-us` provider block and its residency rules. The tier mapping changes
  which model a *tiered* task gets; an untiered one is untouched.
- **No change to agent-swarm's code.** `BEDROCK_AUTH_MODE` is an environment
  variable this repo already passes through, the probe already exists in the
  pinned tag, and the tier keys are swarm config. Nothing here needs an upstream
  patch — including the `internal-ai` credential kind in the open questions, which
  would be one, and is therefore out of this plan.
- **`delegate/` and `deploy/`'s `DELEGATES` stack** are other deployments with
  other secrets and their own review requirements. Out of scope entirely.

## Rejected alternatives

Recorded so a later reader can tell these were considered rather than missed.
The first two are the decisions above, listed as what they reject. **The middle
three were this plan's own first answers, and review reversed them** — they are
kept, with the argument that defeated them, because the argument for leaving
`BEDROCK_AUTH_MODE` unset is genuinely tempting and will come back.

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
- **Leave `BEDROCK_AUTH_MODE` unset and reach Bedrock only by naming a
  `amazon-bedrock/…` model.** This was the first draft's decision 3, and it is
  tempting because it never enters the hard gate: the readiness check keeps
  running on the permissive-key branch, so a failing Bedrock probe cannot park a
  Fireworks worker. It loses on what it pays for that. The permissive branch needs
  `ANTHROPIC_API_KEY`, so the key can never go; there is no enumeration, so the
  picker needs overlay rows that may not even make the models selectable; and the
  readiness check then tests a key the Bedrock path does not use. Turning the
  probe on buys back both problems and costs a coupling the plan was going to
  accept anyway. (Decision 3.)
- **Withhold the control-plane reads.** The first draft's decision 4, and it was
  right *for the first draft*: the reads serve the probe, and the first draft had
  no probe, so granting them would have been a permission with no caller. Once the
  probe is on they have exactly one caller, named in the action list. The rule was
  never "no reads"; it was "no reads without a caller". (Decision 4.)
- **Overlay rows per model, to make the models pickable.** The first draft's
  answer to having no enumeration. With the probe on, the console's Bedrock group
  is `enabled: true` and lists the live result, so the rows answer a question
  nobody is asking. They stay in the document as optional metadata for a fact the
  probe does not carry, not as the plan.
- **`BEDROCK_AUTH_MODE=bearer`.** Same gate as `sdk`, plus a Bedrock API key in
  the secret — a new long-lived credential in exactly the place Part B is trying to
  empty, for a scope the AWS role already gives.
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
  and lose its catalog and pricing, and the probe already supplies the list.
- **Pin `MEMORY_RATER_MODEL` to a DeepSeek model to drop the Anthropic key.** The
  obvious first idea, and it fails structurally: `MEMORY_RATER_MODEL` overrides the
  model string, but `resolveCredential` picks the credential *kind* first, and
  `kindForModelString` maps a provider prefix through `PROVIDER_TO_KIND`, which has
  no `fireworks` entry. The swarm's `FIREWORKS_API_KEY` is invisible to
  `internal-ai`, so a DeepSeek pin changes the model asked of the Anthropic
  credential rather than replacing it. ("Why Bedrock is not the answer here".)
- **Point the two `internal-ai` callers at a Bedrock model instead.** The same
  structural wall: `CredentialKind` has no Bedrock member, so there is no path at
  all — not a misconfiguration. (Part B.)
- **Keep the key because the features have no replacement.** This was the earlier
  draft's lean, and the engineer overruled it: a credential the organisation has
  decided against is not made acceptable by the features hanging off it. Turn them
  off, record the gap. (Part B.)
- **Swap in an OpenRouter key to keep both features.** It works — `openrouter` is
  first in credential precedence and its default is a DeepSeek model — but it keeps
  a long-lived provider key in the secret, which is the thing being removed rather
  than the vendor.
- **Remove the Anthropic key now, on the strength of "no agent uses it".** That
  was PR #491, and it took the swarm's credential check down in production. The
  sentence in the README is about agents; the key also answers the `pi` readiness
  check and feeds session summarisation and task titles. Part A now fixes the first
  of those and cannot fix the second. (Part B.)
- **Treat "the api service" as the consumer and call it answered.** Workflow LLM
  nodes reject an Anthropic credential, so the README's phrase points at the one
  caller that cannot be using it. The callers are the worker's session summary
  and the api's task titles, and they are found by reading `internal-ai`'s
  credential precedence, not by reading the README. (Part B.)
- **Assume Part A solves Part B.** It solves the readiness half and nothing
  else. `internal-ai` has no Bedrock credential kind in v2.10.0 and the api
  container has no AWS access at all, so neither internal caller can be repointed
  at a Bedrock model without an upstream change.
- **`CRED_CHECK_DISABLE=1` as the answer to the readiness check.** It also
  disables the check that would tell us a Fireworks key had gone missing. The probe
  is the answer that keeps a check, which is why it was chosen over this.
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
   - An inline policy (inline, matching the other scoped roles here) with two
     statements, kept apart because they take opposite resource shapes:
     - **invoke:** `bedrock:Converse` and `bedrock:ConverseStream` on two models'
       `inference-profile` ARNs in this account and their `foundation-model` ARNs,
       region wildcarded. The ids come from `utils/bedrock-models.ts` by `id`
       lookup, not retyped, so a model's profile moving is one edit in the file
       that already owns that decision. That file is under `utils/`, which
       `.github/CODEOWNERS` keeps human-owned, so a PR touching it needs a human
       even though `deploy-infrastructure/` does not — the ids' single source of
       truth is worth that.
     - **the probe's reads:** `bedrock:ListFoundationModels` and
       `bedrock:ListInferenceProfiles` on `*`, because Bedrock defines no resource
       type for either and a narrower `Resource` fails rather than scoping
       (decision 4). Named as their own exported constant, the way
       `TASK_BEDROCK_READ_ACTIONS` is in `deploy-workbench/ecs.ts`, so a test can
       tell this deliberate wildcard from an edit that widens something else.
   - The host role's `AssumeProdRead` statement echoed for the new role: an
     `sts:AssumeRole` on its ARN added to `swarmHostPolicy` in `agent-swarm.ts`.
     Nothing else on the host role changes, and the existing `AssumeProdRead`
     stays as it is.
   - `protect` on the new role, as `pulumi-deploy` has: it is a credential path
     the containers depend on, and a replace is an outage that reads as an
     AccessDenied.

   Tests, in the style `deploy-infrastructure/agent-swarm.test.ts` already uses
   on the host policy: export the policy document as a pure function and assert
   (a) invoke is exactly the two Converse actions, (b) every invoke resource names
   one of the two models, (c) the read statement is exactly the two `List*`
   actions the probe calls and on `*`, (d) no `bedrock:*` and no
   `bedrock:Get*`, (e) the trust admits only the host role, (f) the host policy
   gained exactly one statement.

   **This is a sibling PR's file, and it already carries most of it.** PR #518
   creates the role and its policy in `deploy-infrastructure/agent-swarm.ts`, and
   its `ProbeBedrockCatalog` statement already names `bedrock:ListFoundationModels`
   and `bedrock:ListInferenceProfiles` on `*` — so the reads this plan now needs are
   in place before this document merges. Recorded so the plan does not ask for work
   that exists. Two things #518 does that this plan's text does not, both harmless
   and not worth reopening: its invoke statement also grants `bedrock:InvokeModel`
   and `bedrock:InvokeModelWithResponseStream` (this plan narrows to the two
   Converse actions, which is what the harness calls; the extras are unused rather
   than wrong), and it adds the reads because its author anticipated the probe
   rather than because this decision existed yet. Where the two documents disagree,
   #518's policy is the fact and this plan's step 5 verifies it.

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

4. **Turn the readiness gate on, and give it the region.** `agent-swarm/host/docker-compose.yml`,
   `x-worker-env` (which all three agents share):

   ```yaml
   BEDROCK_AUTH_MODE: sdk
   AWS_REGION: us-west-2
   ```

   Both, in the same change, because the probe refuses to run without the region
   (decision 3, "Region"). The **api** service needs them too if anything in it is
   ever expected to reach Bedrock; today it has no AWS access at all, so the honest
   scope is the worker env, and the api is left alone until there is a caller.
   `AWS_PROFILE` must stay unset here — the aws-config change makes `[default]` the
   Bedrock role, and a set `AWS_PROFILE` would aim the probe at whichever profile
   it names.

   **This is sibling PR #523's file, and the change is not purely additive.** That
   PR already adds `AWS_REGION: ${AWS_REGION:-us-west-2}` to `x-worker-env`, which
   step 4 needs and which this plan should treat as done. It also adds a long
   comment saying `BEDROCK_AUTH_MODE` is *deliberately absent*, because the Bedrock
   role is granted "only the four invoke actions (no bedrock:List*/Get*,
   deliberately)" and a probe would therefore "park the worker in credential-wait
   forever". **That comment is now false in both its premises:** #518 does grant the
   two reads, and this plan deliberately turns the probe on. The follow-up change is
   to set `BEDROCK_AUTH_MODE: sdk` and to replace that comment with the reasoning at
   decision 3 — not to add a variable underneath a paragraph explaining why it must
   not be there. Leaving the comment would make the next reader delete the variable
   to restore consistency.

   The proof that this landed is not the apply: it is a worker that boots with no
   `ANTHROPIC_API_KEY` in its env and reports ready, and `agent.credStatus`
   carrying a `bedrock` block with a model count. `agent-swarm/README.md`'s
   "Models" and "AWS access from inside the swarm" sections need the new variable
   explained in the same PR, since the readiness story changes.

5. **Prove it, from inside a worker container.** Operational, no PR; the record
   is the PR bodies of steps 2 to 4 and, where it is not a git fact, ClickUp.

   - `aws sts get-caller-identity` — names the bedrock role.
   - A real `Converse` call to each model via the profile id, with the region
     recorded — `aws bedrock-runtime converse --model-id
     global.openai.gpt-6.1-sol …` and the same for the haiku profile, if the CLI
     build installed by `global-setup-script.sh` has the `converse` subcommand;
     otherwise a short `@aws-sdk/client-bedrock-runtime` script. Success proves
     the agreement, the region, the trust and the policy at once.
   - The readiness path, which is the one that matters most: with
     `ANTHROPIC_API_KEY` removed from a worker's env, the worker must still report
     ready (`satisfiedBy: "sdk-delegated"`). That is the single observation that
     authorises step 8 — if it fails, stop there rather than turning features off
     for a key that cannot go.
   - **What the probe enumerated**, recorded verbatim: the model count and the ids
     it returned. It is wider than the two-model invoke grant (decision 4, "What
     the reads do not buy"), and the size of that gap decides whether the picker
     offering an uninvokable model is a real problem or a theoretical one.
   - A refusal, deliberately: the same call for a model this plan does *not*
     grant (say `global.openai.gpt-6.1-terra`) must fail with an AccessDenied
     that names `bedrock:Converse` and this role. If it succeeds, the grant is
     wider than this plan says and step 2 is wrong.
   - The default, unchanged: a task with no model named still runs Fireworks,
     and the agent's runtime model is still the `fireworks-us/…` router.

6. **Propose the tier mapping.** Set `MODEL_TIER_PI_SMOL`, `MODEL_TIER_PI_REGULAR`,
   `MODEL_TIER_PI_SMART` and `MODEL_TIER_PI_ULTRA` in `swarm_config` — through the
   dashboard or `set-config`, not a Pulumi resource, because tier config is swarm
   state and this repository has no path to it. The mapping is the proposal in
   "Model tiers", and **it needs the engineer's confirmation before it is set**, so
   this step is a question as much as a change.

   Read back `GET /api/models-catalog/tiers` (`previewModelTiers`) and check each
   row's `source` is `tier-config` and its `resolvedModel` is what the table says.
   Then create one task with `modelTier: smart` and confirm from its `resolvedModel`
   that it ran on the Bedrock model — the tier preview is a projection, and the
   claim path is what actually decides.

   Leave `MODEL_TIER_PI_ULTRA` as whatever the engineer decides, and record the
   consequence if it is left pointing at an `openrouter/…` id: an `ultra` task
   fails on a model this swarm cannot authenticate, which is the state every tier
   is in today.

7. **Turn the two `internal-ai` features off.** `SKIP_SESSION_SUMMARY=1` on the
   workers (`x-worker-env` in `agent-swarm/host/docker-compose.yml`) and
   `TASK_AUTO_TITLE_ENABLED=false` where the api reads it — swarm config, since the
   api hydrates `swarm_config` into `process.env` and `isTaskAutoTitleEnabled`
   reads the flag per event. Both land with the reason written next to them, so the
   next reader sees a decision rather than a missing feature.

   This is the step that leaves `ANTHROPIC_API_KEY` with no consumer, so it comes
   before step 8 and not with it: removing the key first would leave two callers
   resolving nothing and no explanation in the diff.

8. **Remove the key from every surface, then from the secret.** Compose — **both**
   the worker env and the api service env — `render-env.sh`'s `REQUIRED_KEYS`,
   `fill-secrets.sh` (the prompt and the final missing-key report), the README's
   three mentions, and the assertion in `fireworks-residency.test.ts`. **Not**
   `deploy/delegate-secret.ts`, which is the pr-reviewer stack's key list and a
   different secret.

   **This lands after #523 and reverses its api line.** #523 deliberately keeps
   `ANTHROPIC_API_KEY` on the api service with a comment saying it "Stays here and
   only here" because removing it "silently disables generated task titles". That
   is now the intent: titles go away, on purpose, with the switch flipped in step 7
   rather than the key simply vanishing. The comment goes with the line, and its
   replacement should say the listener is off and where the decision is recorded.

   Then deploy and confirm three things before touching the secret: the stack comes
   up, a worker reports ready with no `ANTHROPIC_API_KEY` (the probe satisfying it
   from step 4), and a Fireworks task runs end to end. Only then prune the key from
   `DELEGATE_SWARM` — `fill-secrets.sh` has the prune pattern the reverted change
   wrote. The reverse order leaves a window where the container env and the secret
   disagree and the failure looks like a credential bug.

9. **Record the gap in `agent-swarm/README.md`.** Name the two switches, what each
   was, and what is lost: no session summaries, so the memory index stops receiving
   them and the `MEMORY_RATERS` ratings that ride on the same call stop, which is
   felt on long sessions; task titles fall back to the prompt, which is visible and
   harmless. Say that the fix is an `internal-ai` credential kind in agent-swarm and
   that it is unowned — **not** that it is blocked on this plan. A reader who finds
   summaries missing should land on this paragraph, not on a bug report.

## Open questions

- **How much the loss costs in practice.** Not a blocker — the decision is made —
  but worth measuring once the switches are on: how often session summaries were
  being written, and whether memory retrieval noticeably worsens on long sessions.
  Step 9's README paragraph is where that observation would land if it turns out to
  be worth knowing.
- **Whether `internal-ai` should gain a credential kind this account can reach.**
  Today it knows `openrouter`, `anthropic`, `openai`, `openai-codex` and
  `claude-cli`, and the swarm has two credentials in play: Fireworks, which it does
  not model, and Anthropic, which is going. A kind that resolves through the AWS
  chain — or a `fireworks` kind that reads `FIREWORKS_API_KEY` — would bring both
  features back with no new key. It is an agent-swarm change (a pinned-tag bump, or
  an upstream PR), not an ops one, and it is **unowned**: no step here does it, and
  turning the two switches back on is the whole reversal when it exists.
- **Whether the probe's model list is a picker problem.** Step 5 records what the
  probe enumerated. `ListFoundationModels` reports what exists in a region, not
  what this role may invoke, so the picker can offer a model that fails at
  invocation (decision 4, "What the reads do not buy"). If the list is the whole
  catalogue, that is a real papercut; filtering it client-side is an agent-swarm
  change. The overlay rows are the local lever and this plan now treats them as
  optional.
- **What `MODEL_TIER_PI_ULTRA` should be.** The two-model grant leaves `ultra`
  with no model of its own ("Model tiers"). The engineer's call.
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
