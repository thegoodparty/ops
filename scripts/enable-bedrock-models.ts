/**
 * Subscribes an account to the Bedrock models it is allowed to invoke, so the
 * caller never needs the marketplace permission that would let it subscribe a
 * model nobody chose. Step 11 of `docs/workbench-account.md`; the second
 * account it serves is step 1 of `docs/swarm-bedrock.md`.
 *
 * Two accounts, one script, selected by `BEDROCK_SCOPE`:
 *
 * - `workbench` (the default, and what CI runs today) subscribes the workbench
 *   account to every entry in `WORKBENCH_MODELS`, which is the Bifrost
 *   gateway's model list.
 * - `swarm` subscribes the infrastructure account to `SWARM_MODELS`, the
 *   two-model subset the Delegate swarm's `delegate-swarm-bedrock` role may
 *   invoke (`deploy-infrastructure/agent-swarm.ts`).
 *
 * The scope carries the account, the role to assume and the model list
 * together, rather than three independent env vars, because the three are one
 * decision: a script pointed at the infrastructure account with the workbench
 * model list would subscribe eight models there, and a script pointed at the
 * workbench account with the swarm's list would create two agreements and
 * report the other six as missing. Named scopes make the mismatched
 * combinations unrepresentable. The default is the workbench scope, so
 * `deploy-workbench.yml`'s unqualified `APPLY=1 npm run script
 * enable-bedrock-models` keeps meaning exactly what it did.
 *
 * This is not "enabling models" in the old sense. Bedrock enables every
 * foundation model by default and subscribes in the background the first time
 * you invoke one, provided the invoking role holds `aws-marketplace:Subscribe`
 * and friends. Neither grant this script serves implies those: `WorkbenchAccess`
 * deliberately holds none of them, because that permission is what would let a
 * prompt-injected agent pull in any model in the catalogue, and
 * `delegate-swarm-bedrock` holds only four invoke actions. AWS documents the
 * way out of that directly: someone with marketplace permissions subscribes
 * once, and after that invoking needs no marketplace permission at all. This
 * script is that someone.
 *
 * It also removes a failure that is hard to read. With no marketplace
 * permission, the first invocation of an unsubscribed model succeeds for up
 * to fifteen minutes while the background subscription is attempted, then
 * fails with AccessDeniedException once that attempt gives up. Working for a
 * few calls and then refusing looks like an outage or a broken login rather
 * than like missing setup.
 *
 * Why a script rather than Pulumi. There is no resource for this: the AWS
 * provider's `bedrock` namespace covers agents, guardrails, custom models and
 * provisioned throughput, and nothing for model agreements. The API exists,
 * but `CreateFoundationModelAgreement` needs an `offerToken` fetched at
 * request time, so a declarative resource would have to do a lookup before it
 * could construct itself. A dynamic provider is the honest alternative if a
 * second workbench-style account ever appears.
 *
 * Why it still walks regions, now that we know it does not have to.
 * Subscription propagates: the 2026-09-22 run created four agreements in
 * us-east-1 and the same four models turned PENDING in the other three
 * regions without being touched, which is what AWS's "available in all
 * regions" wording means in practice. So the walk is not how models get
 * subscribed.
 *
 * It stays because it is how we find out. Each region is a handful of reads
 * that create nothing where an agreement already exists, and the per-region
 * report is what would show propagation failing to reach somewhere. Dropping
 * to a single region would trade that visibility for a second or two.
 *
 * Reports by default and changes nothing. Set `APPLY=1` to create the missing
 * agreements. Set `BEDROCK_SCOPE=swarm` (see `BEDROCK_SCOPES`) to run for the
 * infrastructure account instead of the workbench one. The script runner takes
 * no arguments, so these are env vars, and CI sets them on the step.
 *
 * Credentials, from either direction. Already inside the scope's account, as a
 * human with `AdministratorAccess`, the ambient credentials are used as they
 * are:
 *
 *   aws sso login --profile gp-admin
 *   AWS_PROFILE=gp-admin npm run script enable-bedrock-models
 *   AWS_PROFILE=gp-admin APPLY=1 npm run script enable-bedrock-models
 *
 * Anywhere else, including as `github-actions-workbench-deploy` in CI, it
 * assumes the scope's deploy role: `pulumi-deploy` in that account, the same
 * role `deploy-workbench/index.ts` and `deploy-infrastructure/index.ts`
 * configure their providers to assume. In the workbench account that grant is
 * `AssumeWorkbenchDeployRole` in `ci-roles/policies.ts`; in the infrastructure
 * account it is the provider hop the infrastructure workflow already makes,
 * because `BEDROCK_SCOPE=swarm` runs in `deploy-infrastructure.yml`. Until step
 * 10's cutover this assumed `OrganizationAccountAccessRole`, the
 * Organizations-planted admin role; the script moved with the provider, as
 * this header always said it would.
 *
 * Note `ReadOnlyAccess` cannot run it: that set has no `sts:AssumeRole`, so
 * the hop into the account is refused. Verified, not assumed.
 */
import {
  BedrockClient,
  CreateFoundationModelAgreementCommand,
  GetFoundationModelAvailabilityCommand,
  ListFoundationModelAgreementOffersCommand,
} from "@aws-sdk/client-bedrock";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { INFRASTRUCTURE_ACCOUNT_ID, WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import {
  BedrockModel,
  SWARM_MARKETPLACE_PRODUCTS,
  SWARM_MODELS,
  WORKBENCH_MODELS,
} from "../utils/bedrock-models";

/**
 * One account, the role that reaches it, and the models it may invoke.
 *
 * The role is `pulumi-deploy` in both accounts, and that is not a coincidence
 * worth de-duplicating into a name: the two ARNs differ by account and each is
 * the role that account's own Pulumi project already assumes, so a grant to run
 * this script is a grant the deploy path needs anyway.
 */
export type BedrockScope = {
  /** What `BEDROCK_SCOPE` calls it, and the name it prints. */
  name: string;
  accountId: string;
  deployRoleArn: string;
  models: BedrockModel[];
  /**
   * Model id to AWS Marketplace product id, for the models whose product is on
   * record. The closing check asserts an agreement exists for each one, and
   * fails the run if not.
   *
   * Empty for the workbench scope, because the workbench run's job is to
   * subscribe eight models across four regions and report — a report that is
   * already part of that workflow's contract. Turning its `xai` row into a red
   * run would be a new failure mode for a workflow this change is not about.
   * The swarm scope populates it, which is what makes the subscription step in
   * `deploy-infrastructure.yml` prove that the two models are actually entitled
   * in the infrastructure account rather than merely offered.
   */
  expectedMarketplaceAgreements: Record<string, string>;
};

const deployRoleArn = (accountId: string) =>
  `arn:aws:iam::${accountId}:role/pulumi-deploy`;

export const BEDROCK_SCOPES: Record<string, BedrockScope> = {
  /** The default: the Bifrost gateway's model list, in the workbench account. */
  workbench: {
    name: "workbench",
    accountId: WORKBENCH_ACCOUNT_ID,
    deployRoleArn: deployRoleArn(WORKBENCH_ACCOUNT_ID),
    models: WORKBENCH_MODELS,
    expectedMarketplaceAgreements: {},
  },
  /**
   * The Delegate swarm host's two models, in the infrastructure account.
   *
   * The same two-model subset the swarm's IAM policy is built from, not a list
   * of its own: subscribing a model the role cannot invoke is a no-op, and
   * granting a model nothing subscribed is the fifteen-minute failure this
   * script exists to prevent.
   */
  swarm: {
    name: "swarm",
    accountId: INFRASTRUCTURE_ACCOUNT_ID,
    deployRoleArn: deployRoleArn(INFRASTRUCTURE_ACCOUNT_ID),
    models: SWARM_MODELS,
    expectedMarketplaceAgreements: SWARM_MARKETPLACE_PRODUCTS,
  },
};

/**
 * The scope `BEDROCK_SCOPE` names, or the workbench one.
 *
 * An unknown name throws rather than falling back, because a typo that silently
 * subscribed the workbench account would look like success.
 */
export const resolveScope = (name?: string): BedrockScope => {
  const requested = (name ?? process.env.BEDROCK_SCOPE ?? "workbench").trim();
  const scope = BEDROCK_SCOPES[requested];
  if (!scope) {
    throw new Error(
      `Unknown BEDROCK_SCOPE "${requested}". Known scopes: ${Object.keys(
        BEDROCK_SCOPES
      ).join(", ")}.`
    );
  }
  return scope;
};

/**
 * Every region a `us.` geo profile can route to, per the model cards.
 *
 * Every entry in `utils/bedrock-models.ts` selects a `global.` profile, and the
 * `transitionalInvokeIds` rollover that kept each entry's outgoing `us.`
 * profile permitted has been removed, so nothing selects a `us.` profile any
 * more. The walk is unchanged and still correct: the agreement is on the
 * foundation model, which is the same one either profile routes to, so
 * subscribing is per model and not per profile. The region list is kept because
 * the rollover was the last reason to walk it and removing the walk would make
 * the next profile change a code change rather than a list edit.
 *
 * `ca-central-1` is the open question and is left out on purpose. Kimi K3's
 * card lists it as geo-supported while its prose says the `us.` profile
 * "routes requests only among US-geography Regions to respect US data
 * residency". Those two statements disagree, and given what GoodParty holds,
 * the resolution should be checked rather than assumed. If routing does reach
 * it, K3 will fail intermittently until it is added here, which is one line.
 */
const REGIONS = ["us-east-1", "us-east-2", "us-west-1", "us-west-2"];

/**
 * Regions for models invoked in one region only, matching `region` in
 * `gp-pi`'s `etc/aws-config`; if that moves, this moves. Empty in practice:
 * `deepseek.v3.2` was the last entry with `crossRegion: false` and was removed
 * on 2026-11-04 for having no inference profile at all. The walk stays, so the
 * next region-pinned model is a list edit rather than a code change.
 */
const PINNED_REGIONS = ["us-west-2"];

/**
 * Subscription is per foundation model, so this works from `id` rather than
 * the inference profile the sandbox selects: the prefix is routing, and asking
 * about a profile would be asking the wrong question. That is unchanged by the
 * 2026-11-04 move from `us.` to `global.` profiles.
 *
 * Models that are not cross-region only ever run where the sandbox points, so
 * they are handled separately below rather than walked across the profile set.
 * The list itself comes from the scope: `scope.models`. A named scope is
 * strongly preferred over an ad-hoc `--account` flag, because it makes the
 * matched triple the only expressible thing, which is the same property the
 * grants have. For a one-off run against a third account, add a scope; do not
 * add a flag that lets the account, the role and the model list disagree.
 */

type Outcome =
  | "already-entitled"
  | "created"
  | "would-create"
  | "pending"
  | "not-in-region"
  | "no-agreement-offered"
  | "needs-use-case-form"
  | "failed";

const results: {
  region: string;
  model: string;
  outcome: Outcome;
  detail?: string;
}[] = [];

const record = (
  region: string,
  model: string,
  outcome: Outcome,
  detail?: string
) => {
  results.push({ region, model, outcome, detail });
  const suffix = detail ? `  (${detail})` : "";
  console.log(`  ${outcome.padEnd(19)} ${model}${suffix}`);
};

/**
 * AWS returns AccessDenied for an Anthropic model whose first-time-use form
 * has not been submitted for the account.
 *
 * Detected rather than submitted, on the assumption that the form is already
 * in place: it is required once per account or once at the organization's
 * management account, a submission at the root is inherited org-wide, and the
 * management account has been using Bedrock for a while. That is an
 * assumption, so this reports clearly if it turns out to be wrong.
 *
 * Submitting it would be possible now. The schema is documented, unlike the
 * service model's untyped blob: `companyName`, `companyWebsite`,
 * `intendedUsers`, `industryOption`, `otherIndustryOption`, `useCases`. It
 * needs real company details, which is a decision rather than a lookup, so it
 * stays out until someone confirms the assumption is false.
 */
const looksLikeUseCaseForm = (err: unknown) => {
  const name = (err as { name?: string })?.name ?? "";
  const message = (err as { message?: string })?.message ?? "";
  return (
    name === "AccessDeniedException" &&
    /use case|acknowledge|terms|eula/i.test(message)
  );
};

async function enableInRegion(
  region: string,
  models: BedrockModel[],
  credentials: AwsCredentialIdentityProvider | undefined
) {
  const client = new BedrockClient({ region, credentials });
  console.log(`\n${region}`);

  for (const model of models) {
    let availability;
    try {
      availability = await client.send(
        new GetFoundationModelAvailabilityCommand({ modelId: model.id })
      );
    } catch (err) {
      // A model this region has never heard of is a fact worth reporting, not
      // a failure: the model lists differ by region and by launch date.
      const name = (err as { name?: string })?.name;
      if (name === "ResourceNotFoundException" || name === "ValidationException") {
        record(region, model.id, "not-in-region", name);
        continue;
      }
      record(region, model.id, "failed", `${name}: ${(err as Error).message}`);
      continue;
    }

    // Every record carries the raw quartet from here on. The first version
    // printed only its own verdict, which is how "already-entitled" stood
    // next to a sandbox being refused for 26 model/region pairs without
    // anyone being able to see the disagreement. If the verdict is ever wrong
    // again, the numbers behind it are in the log.
    const state = [
      `agreement=${availability.agreementAvailability?.status}`,
      `entitlement=${availability.entitlementAvailability}`,
      `auth=${availability.authorizationStatus}`,
      `region=${availability.regionAvailability}`,
    ].join(" ");

    if (availability.regionAvailability !== "AVAILABLE") {
      record(region, model.id, "not-in-region", state);
      continue;
    }

    // The idempotency check, and the one field that actually answers the
    // question. AWS documents `agreementAvailability` as AVAILABLE when
    // access exists and NOT_AVAILABLE when it does not.
    //
    // This first gated on `entitlementAvailability` and `authorizationStatus`
    // instead, which reported 26 of 26 already-entitled while nothing was
    // subscribed and the sandbox was being refused. `authorizationStatus`
    // appears to describe the caller rather than the account, so running as
    // an administrator made every model look fine from CI and none of them
    // work from `WorkbenchAccess`. A check that passes because of who is
    // asking is worse than no check.
    const agreement = availability.agreementAvailability?.status;

    if (agreement === "AVAILABLE") {
      record(region, model.id, "already-entitled", state);
      continue;
    }

    // Its own outcome rather than would-create, which is what this said
    // first and was wrong in a way worth avoiding. Nothing is waiting on us
    // here: creating an agreement in one region propagates to the others as
    // PENDING, observed on the 2026-09-22 run where four creates in
    // us-east-1 turned into twelve PENDING elsewhere. Labelling that
    // "would-create" made a summary of twelve outstanding items out of
    // nothing outstanding at all, and would have hidden a PENDING that
    // genuinely never resolved.
    if (agreement === "PENDING") {
      record(region, model.id, "pending", state);
      continue;
    }

    if (!process.env.APPLY) {
      record(region, model.id, "would-create", state);
      continue;
    }

    try {
      const offers = await client.send(
        new ListFoundationModelAgreementOffersCommand({ modelId: model.id })
      );
      const offerToken = offers.offers?.[0]?.offerToken;
      if (!offerToken) {
        // Not necessarily wrong. AWS names Amazon, DeepSeek, Mistral AI, Meta
        // and Qwen as providers not sold through AWS Marketplace, with no
        // product ids, so there is no subscription to create and nothing to
        // offer. `xai.grok-4.7` is on our list and is expected to land here.
        //
        // `deepseek.v3.2` was the example here until 2026-11-04, when it left
        // the list: it has no `global.` inference profile and no `us.` one, so
        // there is nothing left to subscribe to.
        // Reported rather than failed for that reason, but reported loudly:
        // the alternative reading is that a model which does need an
        // agreement could not be offered one, and the two look identical from
        // here. The first run on a new model is worth a human glance.
        record(
          region,
          model.id,
          "no-agreement-offered",
          `not a Marketplace product? ${state}`
        );
        continue;
      }
      await client.send(
        new CreateFoundationModelAgreementCommand({
          modelId: model.id,
          offerToken,
        })
      );
      // The state shown is the one from before the create, which is the
      // useful half: it says what was missing that this just fixed.
      record(region, model.id, "created", `was: ${state}`);
    } catch (err) {
      if (looksLikeUseCaseForm(err)) {
        record(region, model.id, "needs-use-case-form", (err as Error).message);
        continue;
      }
      // An agreement that already exists is a success for our purposes.
      if ((err as { name?: string })?.name === "ConflictException") {
        record(region, model.id, "already-entitled", "ConflictException");
        continue;
      }
      record(
        region,
        model.id,
        "failed",
        `${(err as { name?: string })?.name}: ${(err as Error).message}`
      );
    }
  }
}

/**
 * Resolves credentials that act inside the scope's account, and fails once
 * rather than producing one misleading error per model/region pair.
 *
 * Two callers, two paths. A human who has already logged in to the account
 * keeps their ambient credentials. Anything else, CI included, assumes into
 * the account, which is what makes this runnable by
 * `github-actions-workbench-deploy` and by `deploy-infrastructure.yml` without
 * a new grant: both workflows already assume that account's `pulumi-deploy`.
 *
 * Returns the provider to hand to each client, or undefined to mean the
 * default chain is already correct.
 *
 * The account check is not ceremony either way. This creates agreements, the
 * organization has more than one account, and `AWS_PROFILE` is easy to get
 * wrong. Acting on the management account would be a real mistake and the
 * error it produced would not say so.
 */
async function resolveCredentials(
  scope: BedrockScope
): Promise<AwsCredentialIdentityProvider | undefined> {
  let ambient;
  try {
    ambient = await new STSClient({ region: REGIONS[0] }).send(
      new GetCallerIdentityCommand({})
    );
  } catch (err) {
    throw new Error(
      `Could not resolve AWS credentials. Log in to the ${scope.name} account ` +
        `${scope.accountId} with AdministratorAccess, or run this as ` +
        `a role that can assume ${scope.deployRoleArn}. Neither principal this ` +
        `script serves can do it: enabling models is a mutation they ` +
        `deliberately lack.\n  ${(err as Error).message}`
    );
  }

  if (ambient.Account === scope.accountId) {
    console.log(`Account ${ambient.Account} as ${ambient.Arn}`);
    return undefined;
  }

  // Session name shows up in the account's CloudTrail, which is
  // worth setting for an assume this privileged: it separates this script
  // from a Pulumi apply and from a human who assumed the same role by hand.
  // The scope is in it because two accounts' CloudTrails are now readable
  // side by side and the session name is what tells the runs apart.
  const credentials = fromTemporaryCredentials({
    params: {
      RoleArn: scope.deployRoleArn,
      RoleSessionName: `enable-bedrock-models-${scope.name}`,
    },
  });

  let assumed;
  try {
    assumed = await new STSClient({ region: REGIONS[0], credentials }).send(
      new GetCallerIdentityCommand({})
    );
  } catch (err) {
    throw new Error(
      `Credentials are in account ${ambient.Account} as ${ambient.Arn}, and ` +
        `assuming ${scope.deployRoleArn} failed. Either those credentials are ` +
        "not allowed to assume it, or you are in the wrong account entirely.\n" +
        `  ${(err as Error).message}`
    );
  }

  // Belt and braces: the assume could in principle resolve somewhere
  // unexpected, and this script is about to create agreements.
  if (assumed.Account !== scope.accountId) {
    throw new Error(
      `Assumed into ${assumed.Account}, expected ${scope.accountId}.`
    );
  }
  console.log(`Assumed ${assumed.Arn} from ${ambient.Arn}`);
  return credentials;
}

export default async function main() {
  const scope = resolveScope();
  console.log(
    `Scope ${scope.name}: account ${scope.accountId}, ${scope.models.length} ` +
      `model(s): ${scope.models.map((m) => m.id).join(", ")}`
  );
  const credentials = await resolveCredentials(scope);
  const applying = Boolean(process.env.APPLY);
  console.log(
    applying
      ? "APPLY is set: missing agreements will be created."
      : "Reporting only. Set APPLY=1 to create missing agreements."
  );

  const geoModels = scope.models.filter((m) => m.crossRegion);
  const pinnedModels = scope.models.filter((m) => !m.crossRegion);

  // `geoModels` is every entry in practice: `crossRegion` means "invoked through
  // an inference profile", and since 2026-11-04 every entry is a `global.` one.
  // The variable name is the older, narrower reading of the same flag.
  for (const region of REGIONS) {
    await enableInRegion(region, geoModels, credentials);
  }
  // The region-pinned models are deliberately not walked across that set: they
  // are selected by bare model id, so they never route elsewhere. No entry has
  // `crossRegion: false` today, so this loop is empty and kept for the next
  // region-pinned model.
  for (const region of PINNED_REGIONS) {
    await enableInRegion(region, pinnedModels, credentials);
  }

  const tally = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  console.log("\nSummary");
  for (const [outcome, count] of Object.entries(tally).sort()) {
    console.log(`  ${outcome.padEnd(19)} ${count}`);
  }

  const notes = scope.models.filter((m) => m.note);
  if (notes.length) {
    console.log("\nNotes");
    for (const m of notes) console.log(`  ${m.id}: ${m.note}`);
  }

  // Non-zero on anything that needs a human, so this is usable from CI later
  // without someone having to read the log to find out it half-worked.
  const blocked = results.filter(
    (r) => r.outcome === "failed" || r.outcome === "needs-use-case-form"
  );
  const pending = results.filter((r) => r.outcome === "pending");
  if (pending.length) {
    console.log(
      `\n${pending.length} subscription(s) still propagating. Normal right ` +
        "after a create, since one region's agreement reaches the others on " +
        "its own. Re-run in a few minutes; anything still pending long after " +
        "that is worth looking at."
    );
  }

  const unoffered = results.filter((r) => r.outcome === "no-agreement-offered");
  // A model this scope expects a Marketplace agreement for, and where the
  // report does not show one. It matters because both ends of the mistake look
  // the same from the report: `no-agreement-offered` is the expected outcome for
  // a provider AWS does not sell through Marketplace, and also what an
  // unentitled product looks like. For a model whose product id is on record
  // there is no ambiguity, so an account that cannot be offered an agreement on
  // it fails the run: the alternative is the fifteen-minute AccessDenied this
  // script exists to move out of the first invocation.
  //
  // Driven by the scope rather than by the model list, so the workbench run's
  // reporting contract is untouched (see `expectedMarketplaceAgreements`).
  const expected = scope.models.filter(
    (m) => scope.expectedMarketplaceAgreements[m.id]
  );
  const unentitled = expected.filter(
    (m) =>
      !results.some(
        (r) =>
          r.model === m.id &&
          (r.outcome === "created" ||
            r.outcome === "already-entitled" ||
            r.outcome === "pending")
      )
  );
  for (const model of expected) {
    console.log(
      `  ${model.id} ${scope.expectedMarketplaceAgreements[model.id]}: ${
        unentitled.includes(model) ? "NO AGREEMENT" : "entitled"
      }`
    );
  }
  if (unentitled.length) {
    console.error(
      `\n${unentitled.length} Marketplace model(s) have a product id on ` +
        "record but no agreement in this account. Either the subscription " +
        "failed above, or the model is not offered to this account at all."
    );
    process.exitCode = 1;
  }

  if (unoffered.length) {
    console.log(
      `\n${unoffered.length} model/region pair(s) had no agreement offer. ` +
        "Expected for providers AWS does not sell through Marketplace, " +
        "DeepSeek among them, where there is no subscription to create. " +
        "Worth confirming by invocation the first time a model lands here."
    );
  }
  if (blocked.length) {
    console.error(
      `\n${blocked.length} model/region pair(s) need attention. ` +
        "needs-use-case-form means accepting the model's terms once in the " +
        "Bedrock console; the API for it takes an undocumented blob."
    );
    process.exitCode = 1;
  }
}
