import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INFRASTRUCTURE_ACCOUNT_ID, WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import {
  SWARM_MODEL_IDS,
  SWARM_MODELS,
  WORKBENCH_MODELS,
  bedrockInvokeResources,
  bedrockInvokeResourcesFor,
  swarmBedrockInvokeResources,
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
const infraProfileArn = (id: string) =>
  `arn:aws:bedrock:*:${INFRASTRUCTURE_ACCOUNT_ID}:inference-profile/${id}`;

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

describe("the swarm's two-model subset", () => {
  const swarmResources = swarmBedrockInvokeResources();

  // The Delegate swarm host is a second principal in a second account, and its
  // grant is deliberately narrower than the fleet's: two models, by id. Pinned
  // as a list of ids so an addition is a visible edit here rather than a
  // widening nobody reviews. Reasons in `docs/swarm-bedrock.md`.
  it("is exactly the two models the swarm may invoke", () => {
    assert.deepEqual([...SWARM_MODEL_IDS], [
      "openai.gpt-6.1-sol",
      "anthropic.claude-haiku-5-5",
    ]);
    assert.deepEqual(
      SWARM_MODELS.map((m) => m.id),
      [...SWARM_MODEL_IDS]
    );
  });

  // Derived, not restated. A second copy of `invokeId` would let a profile move
  // in WORKBENCH_MODELS leave the swarm naming the old profile, which fails as
  // an AccessDenied rather than as a diff.
  it("holds the same entries the model list does, field for field", () => {
    for (const model of SWARM_MODELS) {
      assert.equal(
        WORKBENCH_MODELS.find((m) => m.id === model.id),
        model,
        `${model.id} is a copy rather than the entry from WORKBENCH_MODELS`
      );
    }
  });

  // Four ARNs: two profiles and two foundation models, both shapes, because a
  // grant needs both and the region is the only wildcard.
  it("composes both ARN shapes per model, in the infrastructure account", () => {
    assert.deepEqual(swarmResources, [
      infraProfileArn("global.openai.gpt-6.1-sol"),
      infraProfileArn("global.anthropic.claude-haiku-5-5"),
      foundationArn("openai.gpt-6.1-sol"),
      foundationArn("anthropic.claude-haiku-5-5"),
    ]);
    assert.equal(swarmResources.length, 4);
    for (const arn of swarmResources) {
      assert.match(arn, /^arn:aws:bedrock:\*:/, arn);
      assert.ok(
        SWARM_MODEL_IDS.some(
          (id) => arn.endsWith(`/${id}`) || arn.endsWith(`/global.${id}`)
        ),
        arn
      );
    }
  });

  // The workbench grant is unchanged by this: eight entries still, in that
  // account, and no inference profile outside it.
  it("leaves the workbench grant at every entry, in the workbench account", () => {
    assert.equal(resources.length, WORKBENCH_MODELS.length * 2);
    assert.equal(
      resources.some((r) => r.includes(INFRASTRUCTURE_ACCOUNT_ID)),
      false
    );
    assert.equal(
      swarmResources.some((r) => r.includes(WORKBENCH_ACCOUNT_ID)),
      false
    );
  });

  // Neither subset may carry a geo profile: every entry in the model list is a
  // `global.` profile, and `us.` was retired for every principal on 2026-11-04.
  it("names no us. geo profile", () => {
    assert.equal(
      swarmResources.some((r) => r.includes(":inference-profile/us.")),
      false
    );
    for (const model of SWARM_MODELS) {
      assert.ok(model.invokeId.startsWith("global."), model.invokeId);
    }
  });

  // The composer is the one place ARN shapes are decided, so the workbench
  // grant has to be exactly what it produces for that list. This is the
  // assertion that would catch a second, hand-written shape creeping into
  // either caller.
  it("composes the workbench grant through the same function", () => {
    assert.deepEqual(
      bedrockInvokeResources(),
      bedrockInvokeResourcesFor(WORKBENCH_MODELS, WORKBENCH_ACCOUNT_ID)
    );
    assert.deepEqual(
      swarmResources,
      bedrockInvokeResourcesFor(SWARM_MODELS, INFRASTRUCTURE_ACCOUNT_ID)
    );
  });

  it("names each resource once", () => {
    assert.equal(new Set(swarmResources).size, swarmResources.length);
  });
});
