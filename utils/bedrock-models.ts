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

/** The workbench account. Step 6 of `docs/workbench-account.md`. */
export const WORKBENCH_ACCOUNT_ID = "024901689212";

/**
 * Where the delegate cluster runs: 333022194791, the management account, not
 * the workbench. The `pr-reviewer` agent's second-opinion pass is the one
 * thing outside the sandbox that invokes Bedrock, so this file now describes
 * two accounts rather than one.
 */
export const DELEGATE_ACCOUNT_ID = "333022194791";

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
  note?: string;
};

/**
 * The model the `pr-reviewer` agent's second-opinion review pass runs on.
 *
 * Named once, here, because two unrelated things now need the same pair of
 * ids: the workbench list below (the sandbox may select it like any other
 * model) and the delegate task role's policy. Two literals of the same id is
 * how one of them quietly goes stale and produces an AccessDenied that reads
 * like an outage — the same reasoning as the one list in this file's header.
 */
export const SECOND_OPINION_MODEL: BedrockModel = {
  id: "openai.gpt-5.6-sol",
  invokeId: "us.openai.gpt-5.6-sol",
  crossRegion: true,
};

export const WORKBENCH_MODELS: BedrockModel[] = [
  {
    id: "anthropic.claude-opus-5-5",
    invokeId: "us.anthropic.claude-opus-5-5",
    crossRegion: true,
    note: "GetFoundationModel reports inferenceTypesSupported: [INFERENCE_PROFILE] and nothing else, so there is no in-region invocation to fall back to and the geo profile is mandatory",
  },
  {
    id: "anthropic.claude-sonnet-5",
    invokeId: "us.anthropic.claude-sonnet-5",
    crossRegion: true,
  },
  { id: "xai.grok-4.6", invokeId: "us.xai.grok-4.6", crossRegion: true },
  SECOND_OPINION_MODEL,
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
  ...WORKBENCH_MODELS.map(
    (m) => `arn:aws:bedrock:*::foundation-model/${m.id}`
  ),
];

/**
 * The resource ARNs the delegate task role needs to run one model — the
 * `pr-reviewer`'s second-opinion review pass — and nothing else.
 *
 * Deliberately not `bedrockInvokeResources`. That helper hands the workbench
 * sandbox its whole catalogue, which is the right grant for a developer's
 * inner loop and the wrong one for an agent that reads untrusted PR content:
 * a second reviewer needs exactly one model.
 *
 * Three ARNs, because the Responses API needs all three:
 *
 * - the inference profile, which is what the request names;
 * - the foundation model, account-less and region-wildcarded, because
 *   cross-region inference invokes it in whichever region it routes to — the
 *   same shape and the same reasoning as `bedrockInvokeResources` above, and
 *   the region is wildcarded here for the same reason: the destination set is
 *   per-model and a wrong region list fails intermittently in a way that looks
 *   identical to missing model access;
 * - `project/default`, which is the non-obvious one. Bedrock's
 *   OpenAI-compatible Responses API requires `bedrock:InvokeModel` on the
 *   account's default project in addition to the profile, and the default
 *   project is the only one that API supports — application inference
 *   profiles and an `OpenAI-Project` header are not options, so there is
 *   nothing narrower to name.
 */
export const secondOpinionInvokeResources = (
  accountId = DELEGATE_ACCOUNT_ID
): string[] => [
  `arn:aws:bedrock:*:${accountId}:inference-profile/${SECOND_OPINION_MODEL.invokeId}`,
  `arn:aws:bedrock:*::foundation-model/${SECOND_OPINION_MODEL.id}`,
  `arn:aws:bedrock:*:${accountId}:project/default`,
];
