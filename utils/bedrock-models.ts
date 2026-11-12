import { INFRASTRUCTURE_ACCOUNT_ID, WORKBENCH_ACCOUNT_ID } from "./accounts";

/**
 * The Bedrock models the coding sandbox may use.
 *
 * One list, imported by both the IAM policy that permits them and the script
 * that subscribes to them. Those were briefly separate lists, which is two
 * sources of truth for one decision and a way to produce an AccessDenied that
 * reads like an outage.
 *
 * Why an explicit list is the control. Bedrock enables every foundation model
 * by default, subscribing in the background on first invocation, so there is
 * no account-level allowlist to rely on. AWS's own guidance is that blocking
 * model access means IAM or SCP policy on `bedrock:InvokeModel`, not
 * withholding a subscription. So this list, expressed as resource ARNs on the
 * permission set, is what decides which models an agent can reach.
 *
 * Every entry is a `global.` cross-region inference profile, and that is a
 * decision rather than a default: the global profile is about 10% cheaper than
 * the geographic one, and the workbench account is scoped to coding traffic,
 * which carries no product or voter data. The residency reasoning, and what it
 * costs, is in `docs/bifrost-gateway.md` under "Inference residency" and in
 * `docs/workbench-account.md` under "Changing a model's inference profile".
 *
 * No `us.` geo profile is permitted any more, by any principal. The 2026-11-04
 * move to `global.` carried each entry's outgoing `us.` profile in
 * `transitionalInvokeIds` so a `gp-pi` image built before the switch would not
 * fail mid-session, and that rollover has finished: the field is gone, so the
 * policy names one profile per model. The half of that switch worth keeping in
 * mind is who held the grant. `WorkbenchAccess` — every engineer's own
 * session — used to name these models too; it does not now. In the workbench
 * account Bifrost's task role is the only principal that may invoke a Bedrock
 * model, and the model list is what its policy is built from. That is why this
 * file reads as *the* allowlist rather than as one of several.
 *
 * Two principals now, in two accounts, and both are built from this list:
 * Bifrost's task role for all eight entries in the workbench account, and
 * `delegate-swarm-bedrock` in the infrastructure account for the two-entry
 * `SWARM_MODELS` subset below. The swarm is not a gateway: it is one host
 * role, and its grant is the whole of what it may reach. That second principal
 * is why `bedrockInvokeResourcesFor` takes a model list and an account id
 * rather than reading this one, and why the subset is derived from these
 * entries instead of restated — an id added to the swarm is a model that has
 * to exist here first.
 *
 * See `docs/workbench-account.md`, steps 11 and 15,
 * `docs/bifrost-gateway.md`, "Direct Bedrock access is gone", and
 * `docs/swarm-bedrock.md` for the second principal.
 */

export type BedrockModel = {
  /**
   * Base foundation-model id. This is what agreements are created against and
   * what the `foundation-model` ARN names, in every region a request can
   * route to.
   */
  id: string;
  /**
   * What the sandbox actually selects: a `global.` cross-region inference
   * profile for every entry. The bare foundation-model id is never selected,
   * and several of these models have no in-region invocation at all.
   */
  invokeId: string;
  /** True when `invokeId` is a cross-region inference profile. */
  crossRegion: boolean;
  note?: string;
};

/**
 * Where the 2026-11-04 rollover used to live, and why it is gone.
 *
 * A profile change moves `invokeId` from one profile to another on the same
 * foundation model, so unlike a model replacement there is no new `id` to add
 * and no agreement to create: only the IAM resource moves. Dropping the old
 * profile's ARN in the same change that added the new one would take access
 * away from every `gp-pi` image still selecting the old profile, which is the
 * mid-session AccessDenied the three-merge order exists to avoid. So the
 * outgoing `us.` profile stayed permitted through a `transitionalInvokeIds`
 * field on each entry until `gp-pi` shipped the switch, and this is the
 * follow-up that removes it.
 *
 * Restated here rather than deleted, because the shape comes back every time a
 * profile moves: add the new profile, list the old one somewhere, delete the
 * old one when nothing selects it. The follow-up is the step that is easy to
 * forget, and leaving a `transitionalInvokeIds` field in the type is what made
 * forgetting it silent. It is not coming back as a field: a second profile on
 * an entry is now a data-residency decision, and this account has made its
 * peace with `global.` (`docs/bifrost-gateway.md`, "Inference residency").
 */

export const WORKBENCH_MODELS: BedrockModel[] = [
  {
    // Sonnet 5.5 has moved twice, which is why its history is the longest.
    // It launched on 2026-09-28 with only `global.anthropic.claude-sonnet-5-5`
    //; AWS added `us.anthropic.claude-sonnet-5-5` on 2026-10-01 and the entry
    // moved to the geo profile for residency, keeping `global.` transitional.
    // On 2026-11-04 the account moved every Bedrock model back to its
    // `global.` profile to stop paying the geo premium, so the pair swapped
    // again: `invokeId` is `global.`, and the `us.` rollover that kept the
    // old images working has since been removed.
    id: "anthropic.claude-sonnet-5-5",
    invokeId: "global.anthropic.claude-sonnet-5-5",
    crossRegion: true,
    note: "moved to the global profile on 2026-11-04, about 10% cheaper than the geo profile; the us. profile was added 2026-10-01 and removed with the rollover",
  },
  {
    id: "anthropic.claude-opus-5-5",
    invokeId: "global.anthropic.claude-opus-5-5",
    crossRegion: true,
    note: "GetFoundationModel reports inferenceTypesSupported: [INFERENCE_PROFILE] and nothing else, so there is no in-region invocation to fall back to and a cross-region profile is mandatory",
  },
  {
    // Moonshot's successor to Kimi K3, swapped in on 2026-11-10. The model id
    // is `k3.1` with a dot, which is Moonshot's spelling and not a version of
    // ours to normalise. The model card names `global.moonshotai.kimi-k3.1` as
    // the Global inference ID, alongside `us.` and `in.` geo profiles, and
    // quotes $4.00 / $20.00 per 1M tokens on the global one. It lists no
    // Marketplace product id, so `enable-bedrock-models` reports no agreement
    // to create for it, which is the same shape as `kimi-k3` had.
    id: "moonshotai.kimi-k3.1",
    invokeId: "global.moonshotai.kimi-k3.1",
    crossRegion: true,
    note: "replaced kimi-k3 on 2026-11-10; open weight; the model card documents US, India and Global cross-region profiles, and this account selects the global one as it does for every entry",
  },
  {
    id: "openai.gpt-6.1-sol",
    invokeId: "global.openai.gpt-6.1-sol",
    crossRegion: true,
    note: "Marketplace product prod-qco655ut2vn54; replaced gpt-5.6-sol and gpt-5.6-terra",
  },
  {
    id: "openai.gpt-6.1-terra",
    invokeId: "global.openai.gpt-6.1-terra",
    crossRegion: true,
    note: "added alongside gpt-6.1-sol; the Marketplace agreement is created by enable-bedrock-models, so the product id is not recorded here until that run reports it",
  },
  {
    id: "anthropic.claude-haiku-5-5",
    invokeId: "global.anthropic.claude-haiku-5-5",
    crossRegion: true,
    note: "Marketplace product prod-6cyn7tgqazjhu",
  },
  {
    id: "xai.grok-4.7",
    invokeId: "global.xai.grok-4.7",
    crossRegion: true,
    note: "not sold through Marketplace, IAM only; replaced grok-4.6; the us. profile existed and was never used",
  },
  {
    id: "zai.glm-5.3",
    invokeId: "global.zai.glm-5.3",
    crossRegion: true,
    note: "global. and us. profiles both exist; access in this account is unverified when granted; replaced glm-5",
  },
];

/**
 * The resource ARNs that allow invoking exactly these models and nothing else.
 *
 * Two kinds, because cross-region inference needs both. The request names an
 * inference profile in the account, and Bedrock then invokes the underlying
 * foundation model in whichever region it routes to, so a grant covering only
 * the profile fails the moment routing leaves home. That is more true of a
 * `global.` profile, not less: its destination set is every commercial region
 * AWS chooses, and AWS may add to it.
 *
 * The region is wildcarded on purpose, and this is the part worth reading
 * twice. Enumerating regions was the original objection to narrowing this
 * policy at all, and it was right: the destination set differs per model, it
 * is not frozen, and AWS's documentation says a request fails if any single
 * destination region is blocked, so a "global but US-only" middle setting does
 * not exist. A wrong region list fails intermittently and looks identical to
 * missing model access. Region was never the control we wanted; the model is.
 * So the model is enumerated and the region is not.
 */
export const bedrockInvokeResourcesFor = (
  models: BedrockModel[],
  accountId: string
): string[] => [
  ...models
    .filter((m) => m.crossRegion)
    .map(
      (m) => `arn:aws:bedrock:*:${accountId}:inference-profile/${m.invokeId}`
    ),
  ...models.map((m) => `arn:aws:bedrock:*::foundation-model/${m.id}`),
];

/**
 * The workbench account's grant: every entry, in that account. Unchanged in
 * behaviour and in its default; it is now the one-model-list call into the
 * composer above, so a second principal could not fork the ARN shapes.
 */
export const bedrockInvokeResources = (
  accountId = WORKBENCH_ACCOUNT_ID
): string[] => bedrockInvokeResourcesFor(WORKBENCH_MODELS, accountId);

/**
 * The two models the Delegate swarm may invoke, by id.
 *
 * A subset of `WORKBENCH_MODELS` rather than its own list of entries, and that
 * is the decision worth recording. The swarm runs on one EC2 host in the
 * infrastructure account (`deploy-infrastructure/agent-swarm.ts`) and its
 * container's model traffic is the agent's own, so the question this answers
 * is "which models may that host reach", not "which models does the fleet
 * serve". Ids only: the profile, the region and the note stay in the one list
 * above, so a profile move is still a one-line edit there and the swarm's ARNs
 * follow it. `SWARM_MODELS` throws if an id here is missing from
 * `WORKBENCH_MODELS`, which makes a removal from that list a failing import
 * rather than a policy that silently grants nothing.
 *
 * Two, not eight, because the swarm is a different audience from the coding
 * sandbox: it runs the Delegate agents in Slack, not a developer's editor. The
 * reasoning is in `docs/swarm-bedrock.md`. Beside these two, the role also
 * holds the two control-plane reads its worker's `BEDROCK_AUTH_MODE=sdk` probe
 * makes (`bedrock:ListFoundationModels`, `bedrock:ListInferenceProfiles` —
 * see `delegateSwarmBedrockPolicy`), but those are not model entries and do not
 * belong in this list: this list is what an invoke grant is composed from, and
 * a read takes `Resource: "*"` because IAM defines no resource type for it.
 */
export const SWARM_MODEL_IDS = [
  "openai.gpt-6.1-sol",
  "anthropic.claude-haiku-5-5",
] as const;

export const SWARM_MODELS: BedrockModel[] = SWARM_MODEL_IDS.map((id) => {
  const model = WORKBENCH_MODELS.find((m) => m.id === id);
  if (!model) {
    throw new Error(
      `SWARM_MODEL_IDS names ${id}, which is not in WORKBENCH_MODELS. The swarm's subset derives from that list, so the model has to be added there first.`
    );
  }
  return model;
});

/**
 * The infrastructure account's grant: the two swarm models, in that account.
 *
 * A separate function rather than `bedrockInvokeResources(INFRASTRUCTURE_ACCOUNT_ID)`,
 * which would grant all eight. The account id is passed rather than defaulted,
 * so a caller that means the swarm cannot get the workbench account by
 * omission.
 */
export const swarmBedrockInvokeResources = (): string[] =>
  bedrockInvokeResourcesFor(SWARM_MODELS, INFRASTRUCTURE_ACCOUNT_ID);

/**
 * The AWS Marketplace product id of each swarm model, as AWS records it.
 *
 * Both entries are Marketplace products, and that is why the swarm is not
 * finished by an IAM grant: a Marketplace model needs an agreement in the
 * account before its first invoke, or the first calls succeed for up to ~15
 * minutes and then fail with `AccessDeniedException` (the docstring of
 * `scripts/enable-bedrock-models.ts` explains the mechanism). So the
 * subscription step in `.github/workflows/deploy-infrastructure.yml` is part of
 * this change rather than an optional extra, and these ids are here rather
 * than in a runbook so a test can assert that the set needing an agreement and
 * the set the role may invoke are the same set. The values are the ones on
 * record for each entry; a product id is per model, not per region, so one
 * row per model is the whole list.
 */
export const SWARM_MARKETPLACE_PRODUCTS: Record<string, string> = {
  "openai.gpt-6.1-sol": "prod-qco655ut2vn54",
  "anthropic.claude-haiku-5-5": "prod-6cyn7tgqazjhu",
};
