/**
 * Enables the Bedrock models the coding sandbox uses, in every region the
 * cross-region inference profiles route to. Step 11 of
 * `docs/workbench-account.md`.
 *
 * Why a script rather than Pulumi. There is no resource for this: the AWS
 * provider's `bedrock` namespace covers agents, guardrails, custom models and
 * provisioned throughput, and nothing for model access. The underlying API
 * exists, but `CreateFoundationModelAgreement` needs an `offerToken` fetched
 * at request time, so a declarative resource would have to do a lookup before
 * it could construct itself, and the use-case acknowledgement is an opaque
 * blob. This is also one-time-per-account work, which is the case Pulumi is
 * worst at earning its keep. A dynamic provider is the honest alternative and
 * is worth revisiting if a second workbench-style account ever appears.
 *
 * Why regions are the unit of work. The model ids the sandbox uses are `us.`
 * prefixed cross-region inference profiles, which do not stay in one region:
 * they route each request across the profile's member regions by capacity. A
 * model enabled in some member regions and not others produces AccessDenied
 * on some calls and not others, from identical input. That has already cost
 * one debugging session, because the symptom looks exactly like a broken
 * login rather than a half-finished enablement.
 *
 * Reports by default and changes nothing. Set `APPLY=1` to create the missing
 * agreements. The script runner takes no arguments, so this is an env var.
 *
 * Credentials: this needs Bedrock mutations, which `WorkbenchAccess`
 * deliberately does not grant, so run it with `AdministratorAccess` in the
 * workbench account. An engineer's day-to-day session cannot do this and
 * should not be able to.
 *
 *   aws sso login --profile workbench-admin
 *   AWS_PROFILE=workbench-admin npm run script enable-bedrock-models
 *   AWS_PROFILE=workbench-admin APPLY=1 npm run script enable-bedrock-models
 */
import {
  BedrockClient,
  CreateFoundationModelAgreementCommand,
  GetFoundationModelAvailabilityCommand,
  ListFoundationModelAgreementOffersCommand,
} from "@aws-sdk/client-bedrock";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

/** The workbench account. Step 6 of `docs/workbench-account.md`. */
const WORKBENCH_ACCOUNT_ID = "024901689212";

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
 * Base foundation-model ids, not the profile ids the sandbox selects. Access
 * is granted to the underlying model per region; the `us.` prefix is routing,
 * and asking about `us.anthropic.claude-opus-5` would be asking about a
 * profile rather than a model.
 *
 * `pinned: true` marks the two models kept region-pinned by choice, so they
 * only need their own region rather than the whole geo set.
 */
const MODELS: { id: string; pinned?: boolean; note?: string }[] = [
  { id: "anthropic.claude-opus-5" },
  { id: "anthropic.claude-sonnet-5" },
  { id: "xai.grok-4.6" },
  { id: "openai.gpt-5.6-sol" },
  { id: "openai.gpt-5.6-terra" },
  {
    id: "moonshotai.kimi-k3",
    note: "no in-region support anywhere, so a geo profile is mandatory here",
  },
  { id: "zai.glm-5", pinned: true },
  { id: "deepseek.v3.2", pinned: true },
];

type Outcome =
  | "already-entitled"
  | "created"
  | "would-create"
  | "not-in-region"
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
 * AWS returns AccessDenied for a model whose terms have not been accepted for
 * the account, and the acknowledgement form behind
 * `PutUseCaseForModelAccess` is an untyped blob with no schema in the service
 * model. Rather than guess at its contents, this reports the case and leaves
 * that one-time step to the console.
 */
const looksLikeUseCaseForm = (err: unknown) => {
  const name = (err as { name?: string })?.name ?? "";
  const message = (err as { message?: string })?.message ?? "";
  return (
    name === "AccessDeniedException" &&
    /use case|acknowledge|terms|eula/i.test(message)
  );
};

async function enableInRegion(region: string, models: typeof MODELS) {
  const client = new BedrockClient({ region });
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

    if (availability.regionAvailability !== "AVAILABLE") {
      record(region, model.id, "not-in-region", "regionAvailability");
      continue;
    }

    // The idempotency check. Entitled and authorized means the agreement is
    // already in place, so there is nothing to do and re-running is free.
    if (
      availability.entitlementAvailability === "AVAILABLE" &&
      availability.authorizationStatus === "AUTHORIZED"
    ) {
      record(region, model.id, "already-entitled");
      continue;
    }

    if (availability.agreementAvailability?.status === "PENDING") {
      record(region, model.id, "would-create", "agreement pending, wait");
      continue;
    }

    if (!process.env.APPLY) {
      record(
        region,
        model.id,
        "would-create",
        `entitlement=${availability.entitlementAvailability} auth=${availability.authorizationStatus}`
      );
      continue;
    }

    try {
      const offers = await client.send(
        new ListFoundationModelAgreementOffersCommand({ modelId: model.id })
      );
      const offerToken = offers.offers?.[0]?.offerToken;
      if (!offerToken) {
        record(region, model.id, "failed", "no agreement offer returned");
        continue;
      }
      await client.send(
        new CreateFoundationModelAgreementCommand({
          modelId: model.id,
          offerToken,
        })
      );
      record(region, model.id, "created");
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
 * Fails once, before the loops, on the two things that would otherwise
 * produce one misleading error per model/region pair.
 *
 * The account check is not ceremony. This script creates agreements, the
 * organization has more than one account, and `AWS_PROFILE` is easy to get
 * wrong. Running it against the management account would be a real mistake
 * and the error it produced would not say so.
 */
async function preflight() {
  const sts = new STSClient({ region: REGIONS[0] });
  let identity;
  try {
    identity = await sts.send(new GetCallerIdentityCommand({}));
  } catch (err) {
    throw new Error(
      "Could not resolve AWS credentials. This needs AdministratorAccess in " +
        `the workbench account ${WORKBENCH_ACCOUNT_ID}, not WorkbenchAccess: ` +
        "enabling models is a mutation that WorkbenchAccess deliberately " +
        `cannot perform.\n  ${(err as Error).message}`
    );
  }

  if (identity.Account !== WORKBENCH_ACCOUNT_ID) {
    throw new Error(
      `Wrong account. Expected the workbench account ${WORKBENCH_ACCOUNT_ID}, ` +
        `got ${identity.Account} as ${identity.Arn}. Check AWS_PROFILE.`
    );
  }
  console.log(`Account ${identity.Account} as ${identity.Arn}`);
}

export default async function main() {
  await preflight();
  const applying = Boolean(process.env.APPLY);
  console.log(
    applying
      ? "APPLY is set: missing agreements will be created."
      : "Reporting only. Set APPLY=1 to create missing agreements."
  );

  const geoModels = MODELS.filter((m) => !m.pinned);
  const pinnedModels = MODELS.filter((m) => m.pinned);

  for (const region of REGIONS) {
    await enableInRegion(region, geoModels);
  }
  // The pinned models are deliberately not enabled across the geo set: they
  // are selected by bare model id, so they never route anywhere else.
  for (const region of PINNED_REGIONS) {
    await enableInRegion(region, pinnedModels);
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
  if (blocked.length) {
    console.error(
      `\n${blocked.length} model/region pair(s) need attention. ` +
        "needs-use-case-form means accepting the model's terms once in the " +
        "Bedrock console; the API for it takes an undocumented blob."
    );
    process.exitCode = 1;
  }
}
