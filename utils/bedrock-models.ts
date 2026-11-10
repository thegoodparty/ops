import { WORKBENCH_ACCOUNT_ID } from "./accounts";

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
 * session — used to name these models too; it does not now. Bifrost's task
 * role is the only principal that may invoke a Bedrock model, and the model
 * list is what its policy is built from. That is why this file reads as *the*
 * allowlist rather than as one of several.
 *
 * See `docs/workbench-account.md`, steps 11 and 15, and
 * `docs/bifrost-gateway.md`, "Direct Bedrock access is gone".
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
    // Anthropic's frontier technical model, and the one tier this set did not
    // have: above Opus 5.5 and priced at twice it. It is not a successor to
    // Opus, so an earlier reading of this file would have called it an add; it
    // took Grok 4.7's slot instead, because Grok 4.7 was measurably dominated
    // by Haiku 5.5 on both intelligence and price per task and the set is
    // meant to stay eight models.
    //
    // It is a Marketplace product (prod-m733do2vrmi3o), so unlike the Grok
    // entry it needs an agreement, which the `enable-bedrock-models` step in
    // deploy-workbench.yml creates with APPLY=1. Thinking is always on and
    // cannot be disabled (effort is configurable), so every request pays
    // reasoning tokens; cache reads are $0.20, which is what makes the price
    // workable in a long session.
    id: "anthropic.claude-fable-5-2",
    invokeId: "global.anthropic.claude-fable-5-2",
    crossRegion: true,
    note: "added 2026-11-10 in Grok 4.7's slot; Marketplace product prod-m733do2vrmi3o; no in-region invocation, so a cross-region profile is mandatory; adaptive thinking always on, effort low through max",
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
export const bedrockInvokeResources = (
  accountId = WORKBENCH_ACCOUNT_ID
): string[] => [
  ...WORKBENCH_MODELS.filter((m) => m.crossRegion).map(
    (m) => `arn:aws:bedrock:*:${accountId}:inference-profile/${m.invokeId}`
  ),
  ...WORKBENCH_MODELS.map(
    (m) => `arn:aws:bedrock:*::foundation-model/${m.id}`
  ),
];
