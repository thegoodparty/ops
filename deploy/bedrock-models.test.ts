import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import {
  WORKBENCH_MODELS,
  bedrockInvokeResources,
} from "../utils/bedrock-models";

// These assertions are the policy shape rather than a convenience: the arns
// composed here are the gateway task role's `InvokeSelectedBedrockModels`
// resource list, and since the sandbox's direct grant was removed that is the
// only place in the account a model can be invoked from. They live under
// `deploy/` because that is the tree the test runner globs and the tree that
// reads the list; the module itself is in `utils/`.
const resources = bedrockInvokeResources();

const profileArn = (id: string) =>
  `arn:aws:bedrock:*:${WORKBENCH_ACCOUNT_ID}:inference-profile/${id}`;
const foundationArn = (id: string) =>
  `arn:aws:bedrock:*::foundation-model/${id}`;

describe("bedrockInvokeResources", () => {
  // The request names the inference profile and Bedrock then invokes the
  // foundation model in whichever region it routes to, so a grant needs both
  // or it fails the moment routing leaves home. The region is wildcarded for
  // the same reason: the destination set differs per model.
  it("permits both the profile and the foundation model for every entry", () => {
    for (const model of WORKBENCH_MODELS) {
      assert.ok(resources.includes(foundationArn(model.id)), model.id);
      if (model.crossRegion) {
        assert.ok(
          resources.includes(profileArn(model.invokeId)),
          model.invokeId
        );
      }
    }
  });

  // The rollover that `transitionalInvokeIds` expressed is finished, and this
  // is the assertion that keeps it finished. Every entry named one `us.` geo
  // profile alongside its `global.` one until `gp-pi` had shipped the 2026-11-04
  // switch; the field is gone from the type, so a reintroduction has to be a
  // deliberate edit here rather than a value nobody notices. `us.` survives
  // nowhere in the composed resources: no ARN, for any principal, names a geo
  // profile. Sonnet 5.5 is checked by name because it is the entry with the
  // longest history and the one a careless revert would put back first.
  it("permits no us. geo profile anywhere in the resources", () => {
    const sonnet = WORKBENCH_MODELS.find(
      (m) => m.id === "anthropic.claude-sonnet-5-5"
    );
    assert.ok(sonnet);
    assert.equal(sonnet.invokeId, "global.anthropic.claude-sonnet-5-5");
    assert.ok(resources.includes(profileArn("global.anthropic.claude-sonnet-5-5")));
    assert.ok(resources.includes(foundationArn("anthropic.claude-sonnet-5-5")));

    assert.equal(
      resources.some((r) => r.includes(":inference-profile/us.")),
      false,
      "a us. geo inference profile is in the policy; the rollover is finished and only global. profiles are permitted"
    );
    // And nothing in the list can smuggle one in through a field: the type has
    // no `transitionalInvokeIds` any more, so this catches a reintroduction as
    // an untyped escape rather than a compile error.
    for (const model of WORKBENCH_MODELS) {
      assert.equal(
        "transitionalInvokeIds" in model,
        false,
        `${model.id} carries transitionalInvokeIds; the rollover is finished`
      );
    }
  });

  // Every served model is a global. profile. This is the assertion that would
  // notice a half-finished switch: an entry that kept a `us. invokeId` while the
  // gateway serves global would be an AccessDenied at request time.
  it("selects a global. profile for every entry", () => {
    for (const model of WORKBENCH_MODELS) {
      assert.ok(
        model.invokeId.startsWith("global."),
        `${model.id} selects ${model.invokeId}; every entry is a global. profile`
      );
    }
  });

  // DeepSeek V3.2 was removed on 2026-11-04 because Bedrock publishes no
  // `global.` profile for it and no `us.` one either (`ListInferenceProfiles`
  // in us-west-2 lists only `us.deepseek.r1-v1:0`; `GetFoundationModel` says
  // `inferenceTypesSupported: [ON_DEMAND]`), so it cannot be a global model.
  // It was the one class kept region-pinned, and it is the one class retired.
  // Asserted in both the list and the composed resources so a reintroduction
  // cannot slip in as an "already permitted" ARN.
  it("does not carry deepseek.v3.2, in the list or in the resources", () => {
    assert.equal(
      WORKBENCH_MODELS.some((m) => m.id === "deepseek.v3.2"),
      false,
      "deepseek.v3.2 has no global. inference profile and was removed"
    );
    assert.equal(
      resources.some((r) => r.includes("deepseek")),
      false,
      "a deepseek ARN is in the policy; the class has no global. profile and was removed"
    );
  });

  // The account id is a parameter so the same list composes for a second
  // workbench-style account, and so this test does not depend on the real one.
  it("uses the account id it is given for the profile ARNs", () => {
    const other = bedrockInvokeResources("111122223333");
    assert.ok(
      other.includes(
        "arn:aws:bedrock:*:111122223333:inference-profile/global.anthropic.claude-sonnet-5-5"
      )
    );
    assert.equal(
      other.some((r) => r.includes(WORKBENCH_ACCOUNT_ID)),
      false
    );
  });

  // A duplicate entry is two sources of one decision; the subscription script
  // walks the same list by id, and a duplicate ARN would be dead weight in the
  // policy. Nothing in the type prevents one, so this catches it.
  it("names each resource once", () => {
    assert.equal(new Set(resources).size, resources.length);
  });
});
