/**
 * Subscribes the workbench account to the models the coding sandbox uses, so
 * that the sandbox itself never needs permission to do it. Step 11 of
 * `docs/workbench-account.md`.
 *
 * This is not "enabling models" in the old sense. Bedrock enables every
 * foundation model by default and subscribes in the background the first time
 * you invoke one, provided the invoking role holds `aws-marketplace:Subscribe`
 * and friends. `WorkbenchAccess` deliberately holds none of those, because
 * that permission is what would let a prompt-injected agent pull in any model
 * in the catalogue. AWS documents the way out of that directly: someone with
 * marketplace permissions subscribes once, and after that invoking needs no
 * marketplace permission at all. This script is that someone.
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
 * Why it still walks regions. AWS says a subscription in one region makes the
 * model available in all of them, and also that access is enabled by default
 * in all commercial regions, so one region is probably enough. "Probably" is
 * doing work there, and the cost of being wrong is the intermittent
 * AccessDenied above. The per-region check is a handful of reads and creates
 * nothing where a subscription already exists, so it is cheap insurance
 * rather than a claim that per-region subscription is required.
 *
 * Reports by default and changes nothing. Set `APPLY=1` to create the missing
 * agreements. The script runner takes no arguments, so this is an env var.
 *
 * Credentials, from either direction. Already inside the workbench account,
 * as a human with `AdministratorAccess`, the ambient credentials are used as
 * they are:
 *
 *   aws sso login --profile gp-admin
 *   AWS_PROFILE=gp-admin npm run script enable-bedrock-models
 *   AWS_PROFILE=gp-admin APPLY=1 npm run script enable-bedrock-models
 *
 * Anywhere else, including as `github-actions-workbench-deploy` in CI, it
 * assumes `OrganizationAccountAccessRole` the same way
 * `deploy-workbench/index.ts` configures its provider to. That grant already
 * exists: `AssumeWorkbenchBootstrapRole` in `ci-roles/policies.ts`, landed by
 * step 7. So nothing new is needed on the IAM side, and step 10 moving that
 * role will move this with it.
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
import {
  WORKBENCH_ACCOUNT_ID,
  WORKBENCH_MODELS,
} from "../utils/bedrock-models";

/**
 * The same role `deploy-workbench/index.ts` has its provider assume, for the
 * same reason: it is the only way into the account from CI credentials, and
 * it is effectively administrator there. Step 10 replaces it with a scoped
 * in-account role, at which point this moves with the provider rather than
 * being left behind.
 */
const BOOTSTRAP_ROLE = `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/OrganizationAccountAccessRole`;

/**
 * Every region a `us.` geo profile can route to, per the model cards.
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
 * Regions for the models pinned to a single region rather than a geo profile.
 * Matches `region` in `gp-pi`'s `etc/aws-config`; if that moves, this moves.
 */
const PINNED_REGIONS = ["us-west-2"];

/**
 * Subscription is per foundation model, so this works from `id` rather than
 * the `us.` profile the sandbox selects: the prefix is routing, and asking
 * about a profile would be asking the wrong question.
 *
 * Models that are not cross-region only ever run where the sandbox points, so
 * they are handled separately below rather than walked across the geo set.
 */
const MODELS = WORKBENCH_MODELS;

type Outcome =
  | "already-entitled"
  | "created"
  | "would-create"
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
  models: typeof MODELS,
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

    if (agreement === "PENDING") {
      record(region, model.id, "would-create", `pending, wait: ${state}`);
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
        // offer. `deepseek.v3.2` is on our list and is expected to land here.
        //
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
 * Resolves credentials that act inside the workbench account, and fails once
 * rather than producing one misleading error per model/region pair.
 *
 * Two callers, two paths. A human who has already logged in to the workbench
 * account keeps their ambient credentials. Anything else, CI included,
 * assumes into the account, which is what makes this runnable by
 * `github-actions-workbench-deploy` without a new grant.
 *
 * Returns the provider to hand to each client, or undefined to mean the
 * default chain is already correct.
 *
 * The account check is not ceremony either way. This creates agreements, the
 * organization has more than one account, and `AWS_PROFILE` is easy to get
 * wrong. Acting on the management account would be a real mistake and the
 * error it produced would not say so.
 */
async function resolveWorkbenchCredentials(): Promise<
  AwsCredentialIdentityProvider | undefined
> {
  let ambient;
  try {
    ambient = await new STSClient({ region: REGIONS[0] }).send(
      new GetCallerIdentityCommand({})
    );
  } catch (err) {
    throw new Error(
      "Could not resolve AWS credentials. Log in to the workbench account " +
        `${WORKBENCH_ACCOUNT_ID} with AdministratorAccess, or run this as ` +
        `a role that can assume ${BOOTSTRAP_ROLE}. WorkbenchAccess cannot ` +
        `do it: enabling models is a mutation it deliberately lacks.\n  ${
          (err as Error).message
        }`
    );
  }

  if (ambient.Account === WORKBENCH_ACCOUNT_ID) {
    console.log(`Account ${ambient.Account} as ${ambient.Arn}`);
    return undefined;
  }

  // Session name shows up in the workbench account's CloudTrail, which is
  // worth setting for an assume this privileged: it separates this script
  // from a Pulumi apply and from a human who assumed the same role by hand.
  const credentials = fromTemporaryCredentials({
    params: {
      RoleArn: BOOTSTRAP_ROLE,
      RoleSessionName: "enable-bedrock-models",
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
        `assuming ${BOOTSTRAP_ROLE} failed. Either those credentials are not ` +
        "allowed to assume it, or you are in the wrong account entirely.\n" +
        `  ${(err as Error).message}`
    );
  }

  // Belt and braces: the assume could in principle resolve somewhere
  // unexpected, and this script is about to create agreements.
  if (assumed.Account !== WORKBENCH_ACCOUNT_ID) {
    throw new Error(
      `Assumed into ${assumed.Account}, expected ${WORKBENCH_ACCOUNT_ID}.`
    );
  }
  console.log(`Assumed ${assumed.Arn} from ${ambient.Arn}`);
  return credentials;
}

export default async function main() {
  const credentials = await resolveWorkbenchCredentials();
  const applying = Boolean(process.env.APPLY);
  console.log(
    applying
      ? "APPLY is set: missing agreements will be created."
      : "Reporting only. Set APPLY=1 to create missing agreements."
  );

  const geoModels = MODELS.filter((m) => m.crossRegion);
  const pinnedModels = MODELS.filter((m) => !m.crossRegion);

  for (const region of REGIONS) {
    await enableInRegion(region, geoModels, credentials);
  }
  // The region-pinned models are deliberately not walked across the geo
  // set: they are selected by bare model id, so they never route elsewhere.
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

  const notes = MODELS.filter((m) => m.note);
  if (notes.length) {
    console.log("\nNotes");
    for (const m of notes) console.log(`  ${m.id}: ${m.note}`);
  }

  // Non-zero on anything that needs a human, so this is usable from CI later
  // without someone having to read the log to find out it half-worked.
  const blocked = results.filter(
    (r) => r.outcome === "failed" || r.outcome === "needs-use-case-form"
  );
  const unoffered = results.filter((r) => r.outcome === "no-agreement-offered");
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
