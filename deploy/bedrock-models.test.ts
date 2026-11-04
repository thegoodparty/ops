import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import {
  WORKBENCH_MODELS,
  bedrockInvokeResources,
} from "../utils/bedrock-models";

// The composed `WorkbenchAccess` invoke statement is this list turned into
// resource ARNs, so these assertions are the policy shape rather than a
// convenience. They live under `deploy/` because that is the tree the test
// runner globs and the tree that reads the list; the module itself is in
// `utils/`.
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

  // A profile change keeps the old profile permitted until `gp-pi` has shipped
  // the switch, which is what `transitionalInvokeIds` is for. Without the
  // builder reading it, the old ARN would silently disappear and every image
  // still selecting the old profile would be refused mid-session. Sonnet 5.5 is
  // the entry with the longest history and the one this asserts in full: on
  // 2026-11-04 the account moved from its `us.` geo profile to its `global.`
  // one, so the pair inverted.
  it("permits a transitional profile alongside the selected one", () => {
    const sonnet = WORKBENCH_MODELS.find(
      (m) => m.id === "anthropic.claude-sonnet-5-5"
    );
    assert.ok(sonnet);
    assert.equal(sonnet.invokeId, "global.anthropic.claude-sonnet-5-5");
    assert.deepEqual(sonnet.transitionalInvokeIds, [
      "us.anthropic.claude-sonnet-5-5",
    ]);
    assert.ok(resources.includes(profileArn("global.anthropic.claude-sonnet-5-5")));
    assert.ok(
      resources.includes(profileArn("us.anthropic.claude-sonnet-5-5"))
    );
    assert.ok(resources.includes(foundationArn("anthropic.claude-sonnet-5-5")));
  });

  // Every served model is a global. profile, and the only `us.` profiles left
  // anywhere are the rollover ones. This is the assertion that would notice a
  // half-finished switch: an entry that kept a `us. invokeId` while the
  // gateway moved to global would be an AccessDenied at request time.
  it("selects a global. profile for every entry, keeping us. only as the rollover", () => {
    for (const model of WORKBENCH_MODELS) {
      assert.ok(
        model.invokeId.startsWith("global."),
        `${model.id} selects ${model.invokeId}; every entry is a global. profile`
      );
      for (const transitional of model.transitionalInvokeIds ?? []) {
        assert.ok(
          transitional.startsWith("us."),
          `${model.id} carries ${transitional} as transitional; the rollover is the outgoing us. profile`
        );
      }
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
