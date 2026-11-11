import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INFRASTRUCTURE_ACCOUNT_ID, WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import {
  SWARM_MARKETPLACE_PRODUCTS,
  SWARM_MODEL_IDS,
  SWARM_MODELS,
  WORKBENCH_MODELS,
} from "../utils/bedrock-models";
import {
  BEDROCK_SCOPES,
  resolveScope,
} from "../scripts/enable-bedrock-models";

// `scripts/enable-bedrock-models.ts` is not under a tree the test runner globs,
// so its scope table is pinned from here. The script itself is run by
// `deploy-workbench.yml` and `deploy-infrastructure.yml`; the thing worth
// testing is that the two scopes name the account, the deploy role and the
// model list that belong together, because a mismatched pair is a subscription
// in the wrong account that reads as success.
describe("bedrock subscription scopes", () => {
  it("defaults to the workbench scope, so existing CI is unchanged", () => {
    const scope = resolveScope();
    assert.equal(scope.name, "workbench");
    assert.equal(scope.accountId, WORKBENCH_ACCOUNT_ID);
    assert.equal(
      scope.deployRoleArn,
      "arn:aws:iam::024901689212:role/pulumi-deploy"
    );
    // The whole list, not a subset: the gateway serves every entry.
    assert.equal(scope.models, WORKBENCH_MODELS);
  });

  it("names the infrastructure account and the swarm's two models", () => {
    const scope = resolveScope("swarm");
    assert.equal(scope.name, "swarm");
    assert.equal(scope.accountId, INFRASTRUCTURE_ACCOUNT_ID);
    assert.equal(
      scope.deployRoleArn,
      "arn:aws:iam::394495727159:role/pulumi-deploy"
    );
    assert.equal(scope.models, SWARM_MODELS);
    assert.deepEqual(
      scope.models.map((m) => m.id),
      [...SWARM_MODEL_IDS]
    );
    // The scope is what makes the subscription step in
    // deploy-infrastructure.yml prove entitlement rather than report it, so it
    // has to declare the two product ids rather than an empty map.
    assert.equal(
      scope.expectedMarketplaceAgreements,
      SWARM_MARKETPLACE_PRODUCTS
    );
  });

  // The script creates agreements, so a typo must not fall back to the
  // workbench account and look like a successful run.
  it("refuses a scope it does not know rather than falling back", () => {
    assert.throws(() => resolveScope("infrastructure"), /Unknown BEDROCK_SCOPE/);
    assert.throws(() => resolveScope(""), /Unknown BEDROCK_SCOPE/);
  });

  it("keeps the workbench run's reporting contract, expecting no agreements", () => {
    // Eight models, an `xai` entry that is not a Marketplace product, and a
    // report rather than a red run. An expectation map here would fail
    // deploy-workbench.yml for a reason this change is not about.
    assert.deepEqual(resolveScope("workbench").expectedMarketplaceAgreements, {});
  });

  // Every scope's deploy role is in that scope's own account, which is the
  // property that would break first if one were copied rather than derived.
  it("keeps each deploy role inside its own account", () => {
    for (const scope of Object.values(BEDROCK_SCOPES)) {
      assert.ok(
        scope.deployRoleArn.startsWith(`arn:aws:iam::${scope.accountId}:`),
        scope.name
      );
      assert.ok(scope.models.length > 0, scope.name);
    }
  });

  // Both swarm models are Marketplace products, and the product ids are what
  // the script's closing check asserts an agreement against. The mapping and
  // the model list have to name the same two ids, or that check covers a
  // different set than the policy does.
  it("records a product id for both swarm models and nothing else", () => {
    assert.deepEqual(SWARM_MARKETPLACE_PRODUCTS, {
      "openai.gpt-6.1-sol": "prod-qco655ut2vn54",
      "anthropic.claude-haiku-5-5": "prod-6cyn7tgqazjhu",
    });
    assert.deepEqual(
      Object.keys(SWARM_MARKETPLACE_PRODUCTS).sort(),
      [...SWARM_MODEL_IDS].sort()
    );
  });
});
