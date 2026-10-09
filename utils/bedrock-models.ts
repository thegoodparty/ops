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
 * See `docs/workbench-account.md`, steps 11 and 15.
 */

export type BedrockModel = {
  /**
   * Base foundation-model id. This is what agreements are created against and
   * what the `foundation-model` ARN names, in every region a request can
   * route to.
   */
  id: string;
  /**
   * What the sandbox actually selects, which is not always the same thing. A
   * `us.` geo inference profile for most of these, and the bare model id for
   * the two deliberately kept in one region.
   */
  invokeId: string;
  /** True when `invokeId` is a cross-region inference profile. */
  crossRegion: boolean;
  /**
   * Extra inference profiles to permit alongside `invokeId`, and only for as
   * long as a profile change is rolling out.
   *
   * A profile change moves `invokeId` from one profile to another on the same
   * foundation model, so unlike a model replacement there is no new `id` to
   * add and no agreement to create: only the IAM resource moves. Dropping the
   * old profile's ARN in the same change that adds the new one would take
   * access away from every `gp-pi` image still selecting the old profile,
   * which is the mid-session AccessDenied the three-merge order exists to
   * avoid. So the old profile stays here until `gp-pi` has shipped the switch,
   * and is removed in a follow-up. An entry that keeps one is a permanent
   * second profile, which is a data-residency decision rather than a
   * transition. See `docs/workbench-account.md`, "Changing a model's
   * inference profile".
   */
  transitionalInvokeIds?: string[];
  note?: string;
};

export const WORKBENCH_MODELS: BedrockModel[] = [
  {
    // Sonnet 5.5's profile, not its model, changed on 2026-10-01: AWS added
    // `us.anthropic.claude-sonnet-5-5`, a geo profile that keeps data in US
    // and Canadian regions, where the model card had listed In-Region and Geo
    // as unsupported when the model was added on 2026-09-28. The account's
    // convention is to stay in the United States, so the sandbox moves to the
    // geo profile and off `global.anthropic.claude-sonnet-5-5`, which routes
    // by capacity anywhere in the world. The global profile stays permitted
    // through `transitionalInvokeIds` until `gp-pi` has shipped the same
    // switch, then comes out. See `docs/workbench-account.md` under "Changing
    // a model's inference profile".
    id: "anthropic.claude-sonnet-5-5",
    invokeId: "us.anthropic.claude-sonnet-5-5",
    crossRegion: true,
    transitionalInvokeIds: ["global.anthropic.claude-sonnet-5-5"],
    note: "the US geo profile was added after launch, replacing the global-only profile this entry was created with; it keeps data in US and Canadian regions",
  },
  {
    id: "anthropic.claude-opus-5-5",
    invokeId: "us.anthropic.claude-opus-5-5",
    crossRegion: true,
    note: "GetFoundationModel reports inferenceTypesSupported: [INFERENCE_PROFILE] and nothing else, so there is no in-region invocation to fall back to and the geo profile is mandatory",
  },
  { id: "xai.grok-4.6", invokeId: "us.xai.grok-4.6", crossRegion: true },
  {
    id: "openai.gpt-5.6-sol",
    invokeId: "us.openai.gpt-5.6-sol",
    crossRegion: true,
  },
  {
    id: "openai.gpt-5.6-terra",
    invokeId: "us.openai.gpt-5.6-terra",
    crossRegion: true,
  },
  {
    id: "moonshotai.kimi-k3",
    invokeId: "us.moonshotai.kimi-k3",
    crossRegion: true,
    note: "no in-region support in any region, so the geo profile is mandatory",
  },
  {
    id: "openai.gpt-6.1-sol",
    invokeId: "us.openai.gpt-6.1-sol",
    crossRegion: true,
    note: "Marketplace product prod-qco655ut2vn54; replaces gpt-5.6-sol and gpt-5.6-terra in gp-pi, which stay permitted until that ships",
  },
  {
    id: "anthropic.claude-haiku-5-5",
    invokeId: "us.anthropic.claude-haiku-5-5",
    crossRegion: true,
    note: "Marketplace product prod-6cyn7tgqazjhu",
  },
  {
    id: "xai.grok-4.7",
    invokeId: "us.xai.grok-4.7",
    crossRegion: true,
    note: "not sold through Marketplace, IAM only; replaces grok-4.6, which stays permitted until gp-pi ships",
  },
  {
    id: "zai.glm-5.3",
    invokeId: "us.zai.glm-5.3",
    crossRegion: true,
    note: "us. profile only; access in this account is unverified when granted; replaces glm-5, which stays permitted until gp-pi ships",
  },
  { id: "zai.glm-5", invokeId: "zai.glm-5", crossRegion: false },
  {
    id: "deepseek.v3.2",
    invokeId: "deepseek.v3.2",
    crossRegion: false,
    note: "AWS lists DeepSeek among the providers not sold through Marketplace, so expect no agreement offer and nothing to subscribe to",
  },
];

/**
 * The resource ARNs that allow invoking exactly these models and nothing else.
 *
 * Two kinds, because cross-region inference needs both. The request names an
 * inference profile in the account, and Bedrock then invokes the underlying
 * foundation model in whichever region it routes to, so a grant covering only
 * the profile fails the moment routing leaves home.
 *
 * The region is wildcarded on purpose, and this is the part worth reading
 * twice. Enumerating regions was the original objection to narrowing this
 * policy at all, and it was right: the destination set differs per model,
 * `us.moonshotai.kimi-k3` spans five regions where the Anthropic profiles
 * span three, and `ca-central-1` is still unresolved. A wrong region list
 * fails intermittently and looks identical to missing model access. Region
 * was never the control we wanted; the model is. So the model is enumerated
 * and the region is not.
 */
export const bedrockInvokeResources = (
  accountId = WORKBENCH_ACCOUNT_ID
): string[] => [
  ...WORKBENCH_MODELS.filter((m) => m.crossRegion).map(
    (m) => `arn:aws:bedrock:*:${accountId}:inference-profile/${m.invokeId}`
  ),
  ...WORKBENCH_MODELS.flatMap((m) =>
    (m.transitionalInvokeIds ?? []).map(
      (id) => `arn:aws:bedrock:*:${accountId}:inference-profile/${id}`
    )
  ),
  ...WORKBENCH_MODELS.map(
    (m) => `arn:aws:bedrock:*::foundation-model/${m.id}`
  ),
];
