import * as aws from "@pulumi/aws";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  GOVERNANCE_METADATA_FIELDS,
  checkGovernanceOverrides,
  formatGovernanceProblems,
} from "./bifrost/governance-desired-state";

/**
 * The two governance documents, published as SSM parameters.
 *
 * Step 2 of `docs/bifrost-reconciler.md`, decisions 8 and 10. Git is the
 * source: both parameters are built from committed files on every apply, so a
 * console edit is overwritten by the next one, which is the property the
 * template has had since `bifrost-virtual-keys.md` step 1.
 *
 * The overrides parameter lives beside the template's, which is what the plan
 * asks for ("the `/bifrost/governance-overrides` parameter beside the
 * template's (`bifrost-vk-mint.ts`, same shape, same 'read the committed file
 * at deploy time')"). This module is that "same shape" extracted, so the two
 * documents cannot end up with different tiers, different validation or
 * different byte accounting; the mint imports it and re-exports the names, and
 * nothing else about the mint changes.
 *
 * Neither parameter is read by a gateway yet: step 3 is the reconciler that
 * reads them and step 4 is the trigger. What lands here is the document, the
 * merge, the validation and the publication, so a bad override fails an apply
 * instead of becoming a `400` on every tick.
 *
 * ## Why two parameters and not one
 *
 * The `String` standard tier holds 4 KiB. `bifrost/config.json` is already
 * 4,085 bytes against that ceiling (`ecs.ts`'s
 * `BIFROST_CONFIG_PARAMETER_STANDARD_TIER_BYTES`), so a combined governance
 * document would grow into the same wall from the far side. Split, the
 * 704-byte template has room and the overrides document gets the rest; the
 * sizes are asserted by `governance-parameters.test.ts`, which fails the build
 * rather than the apply when either crosses the line.
 *
 * ## Where the validation runs, and why it is split
 *
 * `checkGovernanceOverrides` runs here, over the committed text, as the Pulumi
 * program is evaluated: an unknown field, a malformed budget, a duplicate
 * `reset_duration` or a misplaced `inherit` fails a preview, which is the
 * earliest place a reviewer can be told.
 *
 * Membership in `Engineers` is the other half, and it is a directory read, so it
 * runs in `scripts/preflight-governance.ts` from `deploy.sh`, before the apply
 * that would write the parameter. This module cannot make that read: it runs as
 * the admin deploy role, and the reader is a separate role created in the
 * management account (`deploy/components/bifrost-vk-reader.ts`) precisely so
 * that a directory read has one scope. A second holder of that grant for a
 * check a workflow step already makes is not worth the narrowing it costs.
 */

/** The template parameter, unchanged from `bifrost-virtual-keys.md` step 1. */
export const VK_MINT_TEMPLATE_PARAMETER_NAME = "/bifrost/vk-mint-template";

/** The per-person overrides, new in this step. */
export const GOVERNANCE_OVERRIDES_PARAMETER_NAME =
  "/bifrost/governance-overrides";

/** The standard tier's content limit, in bytes. Both documents must fit. */
export const GOVERNANCE_PARAMETER_STANDARD_TIER_BYTES = 4096;

/** The committed documents, read from the repo rather than a copy in state. */
export const VK_MINT_TEMPLATE_PATH = path.resolve(
  __dirname,
  "bifrost/vk-mint-template.json",
);
export const GOVERNANCE_OVERRIDES_PATH = path.resolve(
  __dirname,
  "bifrost/governance-overrides.json",
);

export const readVkMintTemplate = (): string =>
  fs.readFileSync(VK_MINT_TEMPLATE_PATH, "utf8");

export const readGovernanceOverrides = (): string =>
  fs.readFileSync(GOVERNANCE_OVERRIDES_PATH, "utf8");

/**
 * A document with its `$comment` block removed.
 *
 * `$comment` is where a reviewable JSON document states its own rules, and it
 * is not part of the desired state: no consumer of the parameter reads it, and
 * `composeGovernanceDesiredState` drops it on the way to the gateway. Stripping
 * it before publication is what makes the paragraph free, and what makes the
 * three claims about it agree — the PR's, the test's, and the byte check's.
 *
 * Without this the block is the majority of the parameter: the committed
 * overrides document is 2.7 KB published with it and about 40 bytes without,
 * which is the difference between roughly ten overrides fitting under the 4 KiB
 * tier and the ~3 KiB the plan budgets for.
 *
 * Only the top level, because that is the only place a metadata field is
 * allowed; a `$comment` inside an override is a validation failure, so there is
 * nothing here to strip.
 */
export const stripMetadata = (text: string): string => {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if ((GOVERNANCE_METADATA_FIELDS as readonly string[]).includes(key)) continue;
    stripped[key] = value;
  }
  return JSON.stringify(stripped);
};

/**
 * The published value of a document: no `$comment`, no formatting.
 *
 * The parameter is read by a Lambda that parses it, so the only thing the
 * whitespace buys is bytes against a 4 KiB ceiling — and a document a reviewer
 * reads is the file, not the parameter. Re-serialising is safe for the same
 * reason `ecs.ts`'s digest parses rather than hashes: the content is what
 * matters, and a reformat of the file is not a change to the desired state.
 *
 * The template carries no metadata field, so stripping it is a no-op there and
 * the two documents go through one function.
 */
export const parameterValue = (text: string): string => stripMetadata(text);

/**
 * The two parameters, and the validation that gates them.
 *
 * `ssm.Parameter` rather than `ssm.getParameter` because these are ours to
 * write. `String` rather than `SecureString` because a reviewed file in git
 * holds no secret, and a SecureString would need `kms:Decrypt` for no
 * confidentiality — the same argument this file's template parameter has always
 * had.
 */
export const createBifrostGovernanceParameters = (args: {
  provider: aws.Provider;
  tags: Record<string, string>;
}): {
  template: aws.ssm.Parameter;
  overrides: aws.ssm.Parameter;
} => {
  const { provider, tags } = args;

  const templateText = readVkMintTemplate();
  const overridesText = readGovernanceOverrides();

  // Apply-time validation, over the committed text. A problem throws here, so
  // the apply fails with the paths in the document that caused it, rather than
  // writing a parameter a reconciler would then retry a 400 against forever.
  const problems = checkGovernanceOverrides(overridesText);
  if (problems.length > 0) {
    throw new Error(
      `${GOVERNANCE_OVERRIDES_PATH} has ${
        problems.length
      } problem${problems.length === 1 ? "" : "s"}:\n${formatGovernanceProblems(
        problems,
      )}`,
    );
  }

  for (const [name, text] of [
    [VK_MINT_TEMPLATE_PARAMETER_NAME, templateText],
    [GOVERNANCE_OVERRIDES_PARAMETER_NAME, overridesText],
  ] as const) {
    const bytes = Buffer.byteLength(parameterValue(text), "utf8");
    if (bytes >= GOVERNANCE_PARAMETER_STANDARD_TIER_BYTES) {
      throw new Error(
        `${name} would be ${bytes} bytes, and the standard tier holds ${GOVERNANCE_PARAMETER_STANDARD_TIER_BYTES}; move the parameter to tier: "Advanced" (8 KiB, and charged) in the same change`,
      );
    }
  }

  const template = new aws.ssm.Parameter(
    "bifrostVkMintTemplate",
    {
      name: VK_MINT_TEMPLATE_PARAMETER_NAME,
      type: "String",
      value: parameterValue(templateText),
      description:
        "Default provider_configs for a minted Bifrost virtual key (step 1 of docs/bifrost-virtual-keys.md, and the template half of docs/bifrost-reconciler.md step 2); edit deploy-workbench/bifrost/vk-mint-template.json.",
      tags,
    },
    { provider },
  );

  const overrides = new aws.ssm.Parameter(
    "bifrostGovernanceOverrides",
    {
      name: GOVERNANCE_OVERRIDES_PARAMETER_NAME,
      type: "String",
      value: parameterValue(overridesText),
      description:
        "Per-person overrides of the Bifrost virtual-key governance the reconciler converges to (step 2 of docs/bifrost-reconciler.md); edit deploy-workbench/bifrost/governance-overrides.json.",
      tags,
    },
    { provider },
  );

  return { template, overrides };
};

/**
 * The two SSM names, in the order the reconciler needs them.
 *
 * Exported as data so step 3's `ssm:GetParameter` grant and this step's
 * parameters cannot disagree about a name: the grant is written from this list,
 * and a third governance document is one entry here rather than a fourth
 * literal in a policy nobody re-reads.
 *
 * `/bifrost/config`, the third parameter the reconciler reads, is deliberately
 * not here. It is `ecs.ts`'s, because the config store is not governance, and a
 * list in this file that named it would read as a resource this module should
 * create.
 */
export const RECONCILER_PARAMETER_NAMES = [
  VK_MINT_TEMPLATE_PARAMETER_NAME,
  GOVERNANCE_OVERRIDES_PARAMETER_NAME,
] as const;
