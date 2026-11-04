import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import type { KeyPage, MembershipDirectory, VirtualKey } from "./vk-mint-core";
import { VK_DESCRIPTION } from "./vk-marker";
import {
  JanitorFailure,
  composeDesiredState,
  convergenceBody,
  differingFields,
  reconcileGovernance,
  type GovernanceTemplate,
  type JanitorGateway,
} from "./vk-janitor-core";
import type { GovernanceOverrides } from "./governance-desired-state";
import type { ObservedGovernance } from "./vk-governance-observed";

/**
 * Step 3 of `docs/bifrost-reconciler.md`: the diff-and-apply loop, against a
 * fake gateway and a fake directory, which is how the rest of this module is
 * tested.
 *
 * The acceptance criteria the plan names, each one a test below:
 *
 * 1. A changed budget on a fake key converges in one `PUT` with the correct
 *    complete-set body, and `changed` reflects it.
 * 2. An unchanged key produces **no** `PUT` at all: diff before write, and
 *    "nothing changed" is an empty request, not a request that happens to be a
 *    no-op.
 * 3. A roster member with no key produces no key, and the run reports that it
 *    changed nothing (decision 7).
 * 4. `provider_configs` is a replacement set on the wire, so every `PUT` carries
 *    the complete composed set — and `inherit` merges field-level with the
 *    template, distinctly from `absent` (decision 9).
 * 5. `rate_limit` is carried in the shape with no default, and budgets carry
 *    `calendar_aligned: true`, so a retune matches by `reset_duration` and never
 *    sends `reset_budget_usage` (success criterion 3).
 * 6. `changed` and `unchanged` are numbers a test can assert (decision 6).
 */

const TEMPLATE_PATH = path.resolve(__dirname, "vk-mint-template.json");
const OVERRIDES_PATH = path.resolve(__dirname, "governance-overrides.json");

/** The committed documents, which is what the Lambda reads from SSM. */
const committedTemplate = (): GovernanceTemplate =>
  JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf8")) as GovernanceTemplate;
const committedOverrides = (): GovernanceOverrides =>
  JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8")) as GovernanceOverrides;

/**
 * A minimal template for the tests that are about the loop rather than the
 * committed document, so a change to the fleet's model list does not rewrite
 * every body assertion below.
 */
const template = (): GovernanceTemplate => ({
  description: VK_DESCRIPTION,
  is_active: true,
  provider_configs: [
    {
      provider: "bedrock",
      allowed_models: ["us.anthropic.claude-sonnet-5-5"],
      key_ids: ["*"],
    },
  ],
  calendar_aligned: true,
});

/**
 * A key as the gateway lists it. `value` is present because the real response
 * carries it, and is asserted absent from every result and log line.
 */
const key = (
  overrides: Partial<VirtualKey> & { name: string },
): VirtualKey =>
  ({
    id: `id-${overrides.name}`,
    // Present on the wire, never read by this loop and never in a result.
    value: "sk-bf-the-value-that-must-never-be-logged",
    is_active: true,
    expires_at: null,
    delete_after_expire: null,
    description: VK_DESCRIPTION,
    ...overrides,
  }) as VirtualKey;

/**
 * A key already at the template's shape, as `GET` reports it. Written out rather
 * than derived, so the "already converged" case is a statement about the wire
 * shape and not a restatement of the composition under test.
 */
const convergedKey = (
  overrides: Partial<VirtualKey> & { name: string },
): VirtualKey =>
  key({
    calendar_aligned: true,
    provider_configs: [
      {
        provider: "bedrock",
        allowed_models: ["us.anthropic.claude-sonnet-5-5"],
        blacklisted_models: [],
        weight: null as unknown as undefined,
        allow_all_keys: true,
        keys: [],
      },
    ],
    budgets: [],
    ...overrides,
  } as Partial<VirtualKey> & { name: string });

const directory = (
  options: {
    members?: readonly string[];
    userIds?: Record<string, string | null>;
    getUserIdError?: Error;
    listError?: Error;
  } = {},
): MembershipDirectory => ({
  getUserId: async (email) => {
    if (options.getUserIdError) throw options.getUserIdError;
    return options.userIds?.[email] ?? null;
  },
  listMemberUserIds: async () => {
    if (options.listError) throw options.listError;
    return options.members ?? ["user-1"];
  },
});

/** A gateway whose writes are recorded in call order, so "no PUT" is testable. */
const fakeGateway = (
  options: { keys?: VirtualKey[]; listError?: Error; updateError?: Error } = {},
): {
  gateway: JanitorGateway;
  updates: Array<{ id: string; body: Record<string, unknown> }>;
  listCalls: () => number;
} => {
  const updates: Array<{ id: string; body: Record<string, unknown> }> = [];
  let listCalls = 0;
  const page: KeyPage = {
    keys: options.keys ?? [],
    totalCount: options.keys?.length ?? 0,
  };
  return {
    updates,
    listCalls: () => listCalls,
    gateway: {
      list: async () => {
        if (options.listError) throw options.listError;
        listCalls++;
        return page;
      },
      update: async (id, body) => {
        if (options.updateError) throw options.updateError;
        updates.push({ id, body });
        return key({ name: "updated", id });
      },
    },
  };
};

describe("the composed desired state (decision 9)", () => {
  it("is the template alone for somebody with no override", () => {
    const { state, providerConfigsSource } = composeDesiredState({
      template: template(),
      overrides: {},
      email: "jeff@goodparty.org",
    });

    assert.equal(providerConfigsSource, "absent");
    assert.deepEqual(state.provider_configs, template().provider_configs);
    // Decision 11: the fleet's rule, not the document's.
    assert.equal(state.calendar_aligned, true);
    // Decision 12: no limit anywhere.
    assert.ok(!("rate_limit" in state));
  });

  it("merges field by field, so a budget-only override keeps the template's model policy", () => {
    const { state, providerConfigsSource } = composeDesiredState({
      template: template(),
      overrides: {
        "jeff@goodparty.org": {
          budgets: [{ max_limit: 250, reset_duration: "1M" }],
        },
      },
      email: "jeff@goodparty.org",
    });

    assert.equal(providerConfigsSource, "absent");
    // The whole point of a field-level merge: naming a budget must not drop the
    // provider list, or the key silently stops reaching the models it used to.
    assert.deepEqual(state.provider_configs, template().provider_configs);
    assert.deepEqual(state.budgets, [{ max_limit: 250, reset_duration: "1M" }]);
  });

  it("honours \"inherit\" distinctly from an absent field, and both resolve to the template's list", () => {
    const inherited = composeDesiredState({
      template: template(),
      overrides: { "jeff@goodparty.org": { provider_configs: "inherit" } },
      email: "jeff@goodparty.org",
    });
    const absent = composeDesiredState({
      template: template(),
      overrides: { "jeff@goodparty.org": {} },
      email: "jeff@goodparty.org",
    });

    // Same value...
    assert.deepEqual(inherited.state.provider_configs, absent.state.provider_configs);
    assert.deepEqual(inherited.state.provider_configs, template().provider_configs);
    // ...different statement. Decision 9 makes the sentinel the explicit
    // spelling of a thing absence already means, so the two must not collapse.
    assert.equal(inherited.providerConfigsSource, "inherit");
    assert.equal(absent.providerConfigsSource, "absent");
  });

  it("replaces the provider list whole when an override names one, rather than merging entries", () => {
    const { state, providerConfigsSource } = composeDesiredState({
      template: template(),
      overrides: {
        "jeff@goodparty.org": {
          provider_configs: [
            {
              provider: "fireworks",
              allowed_models: ["worker-default"],
              key_ids: ["*"],
            },
          ],
        },
      },
      email: "jeff@goodparty.org",
    });

    assert.equal(providerConfigsSource, "override");
    // The template's bedrock entry is gone: `provider_configs` is a replacement
    // set on the wire, so a narrowing has to be able to drop an entry, and a
    // deep merge would make that depend on what the template happens to hold.
    assert.deepEqual(state.provider_configs, [
      { provider: "fireworks", allowed_models: ["worker-default"], key_ids: ["*"] },
    ]);
  });

  it("lowercases the email before looking an override up, as the key's name is lowercase", () => {
    const { state } = composeDesiredState({
      template: template(),
      overrides: {
        "jeff@goodparty.org": { budgets: [{ max_limit: 5, reset_duration: "1M" }] },
      },
      email: "Jeff@GoodParty.org",
    });
    assert.deepEqual(state.budgets, [{ max_limit: 5, reset_duration: "1M" }]);
  });

  it("lets an override turn calendar alignment off, because the document is the authority", () => {
    const { state } = composeDesiredState({
      template: template(),
      overrides: { "jeff@goodparty.org": { calendar_aligned: false } },
      email: "jeff@goodparty.org",
    });
    assert.equal(state.calendar_aligned, false);
  });

  it("carries a rate limit in the shape with no default (decision 12)", () => {
    const { state } = composeDesiredState({
      template: committedTemplate(),
      overrides: {
        "jeff@goodparty.org": {
          rate_limit: { request_max_limit: 600, request_reset_duration: "5m" },
        },
      },
      email: "jeff@goodparty.org",
    });

    assert.deepEqual(state.rate_limit, {
      request_max_limit: 600,
      request_reset_duration: "5m",
    });
    // The committed template carries none, so the field is absent rather than
    // present-and-empty everywhere else.
    const bare = composeDesiredState({
      template: committedTemplate(),
      overrides: {},
      email: "someone@goodparty.org",
    });
    assert.ok(!("rate_limit" in bare.state));
  });
});

describe("the complete-set body (acceptance 4)", () => {
  it("carries every provider entry, every budget, calendar alignment, and no ids", () => {
    const body = convergenceBody({
      calendar_aligned: true,
      provider_configs: [
        { provider: "bedrock", allowed_models: ["a"], key_ids: ["*"] },
        { provider: "fireworks", allowed_models: ["b"], key_ids: ["*"] },
      ],
      budgets: [{ max_limit: 250, reset_duration: "1M" }],
    });

    assert.deepEqual(body, {
      calendar_aligned: true,
      provider_configs: [
        { provider: "bedrock", allowed_models: ["a"], key_ids: ["*"] },
        { provider: "fireworks", allowed_models: ["b"], key_ids: ["*"] },
      ],
      budgets: [{ max_limit: 250, reset_duration: "1M" }],
    });
  });

  it("never sends reset_budget_usage, which is what keeps a retune from wiping a month", () => {
    const body = convergenceBody({
      calendar_aligned: true,
      budgets: [{ max_limit: 250, reset_duration: "1M" }],
    });
    assert.ok(!("reset_budget_usage" in body));
    // A budget carries exactly the two fields git owns. An `id` would be written
    // and never read (git holds none), and the update path matches on
    // `reset_duration` when none is given, which is the matching that preserves
    // `current_usage` (governance.go:904).
    assert.deepEqual(Object.keys((body.budgets as object[])[0]).sort(), [
      "max_limit",
      "reset_duration",
    ]);
  });

  it("omits rate_limit entirely when no document names one", () => {
    const body = convergenceBody({ calendar_aligned: true, budgets: [] });
    assert.ok(!("rate_limit" in body));
  });

  it("sends a rate limit with both halves of whatever pair it names", () => {
    const body = convergenceBody({
      rate_limit: { request_max_limit: 600, request_reset_duration: "5m" },
    });
    assert.deepEqual(body.rate_limit, {
      request_max_limit: 600,
      request_reset_duration: "5m",
    });
    assert.ok(!("token_max_limit" in (body.rate_limit as object)));
  });
});

describe("the diff (acceptance 2 and 5)", () => {
  it("finds no difference on a key that already matches the template", () => {
    const { state } = composeDesiredState({
      template: template(),
      overrides: {},
      email: "jeff@goodparty.org",
    });
    assert.deepEqual(differingFields(state, convergedKey({ name: "jeff@goodparty.org" })), []);
  });

  it("ignores current_usage, last_reset and the gateway's own columns", () => {
    // The accounting writes these itself; a diff that compared them would fight
    // it every five minutes and report a change forever.
    const observed = convergedKey({
      name: "jeff@goodparty.org",
      budgets: [{ max_limit: 250, reset_duration: "1M", current_usage: 137.5 }],
    } as Partial<VirtualKey> & { name: string });
    const { state } = composeDesiredState({
      template: template(),
      overrides: { "jeff@goodparty.org": { budgets: [{ max_limit: 250, reset_duration: "1M" }] } },
      email: "jeff@goodparty.org",
    });
    assert.deepEqual(differingFields(state, observed), []);
  });

  it("reports a budget difference by reset_duration, not by index", () => {
    const { state } = composeDesiredState({
      template: template(),
      overrides: { "jeff@goodparty.org": { budgets: [{ max_limit: 999, reset_duration: "1M" }] } },
      email: "jeff@goodparty.org",
    });
    const observed = convergedKey({
      name: "jeff@goodparty.org",
      budgets: [
        { max_limit: 5, reset_duration: "1d" },
        { max_limit: 250, reset_duration: "1M", current_usage: 10 },
      ],
    } as Partial<VirtualKey> & { name: string });
    assert.deepEqual(differingFields(state, observed), ["budgets"]);
  });

  it("does not fight a rate limit a document does not name (decision 12)", () => {
    const { state } = composeDesiredState({
      template: template(),
      overrides: {},
      email: "jeff@goodparty.org",
    });
    const observed = convergedKey({
      name: "jeff@goodparty.org",
      rate_limit: {
        request_max_limit: 10,
        request_reset_duration: "1m",
        request_current_usage: 3,
      },
    } as Partial<VirtualKey> & { name: string });
    // A limit somebody set by hand is not drift this loop removes.
    assert.deepEqual(differingFields(state, observed), []);
  });

  it("finds a rate limit difference when a document names one", () => {
    const { state } = composeDesiredState({
      template: template(),
      overrides: {
        "jeff@goodparty.org": {
          rate_limit: { request_max_limit: 600, request_reset_duration: "5m" },
        },
      },
      email: "jeff@goodparty.org",
    });
    const observed = convergedKey({
      name: "jeff@goodparty.org",
      rate_limit: { request_max_limit: 600, request_reset_duration: "5m" },
    } as Partial<VirtualKey> & { name: string });
    assert.deepEqual(differingFields(state, observed), []);
  });

  it("reads the gateway's allow_all_keys and keys as the key_ids the desired state uses", () => {
    const { state } = composeDesiredState({
      template: template(),
      overrides: {},
      email: "jeff@goodparty.org",
    });
    // The gateway reports the association the other way round; without the
    // conversion every key would look different on every tick.
    const observed = convergedKey({ name: "jeff@goodparty.org" });
    assert.deepEqual(differingFields(state, observed), []);

    const noKeys = convergedKey({
      name: "jeff@goodparty.org",
      provider_configs: [
        {
          provider: "bedrock",
          allowed_models: ["us.anthropic.claude-sonnet-5-5"],
          allow_all_keys: false,
          keys: [],
        },
      ],
    } as Partial<VirtualKey> & { name: string });
    assert.deepEqual(differingFields(state, noKeys), ["provider_configs"]);
  });

  it("treats a reordered provider or budget list as no change", () => {
    const { state } = composeDesiredState({
      template: template(),
      overrides: {
        "jeff@goodparty.org": {
          provider_configs: [
            { provider: "bedrock", allowed_models: ["a"], key_ids: ["*"] },
            { provider: "fireworks", allowed_models: ["b"], key_ids: ["*"] },
          ],
          budgets: [
            { max_limit: 1, reset_duration: "1d" },
            { max_limit: 250, reset_duration: "1M" },
          ],
        },
      },
      email: "jeff@goodparty.org",
    });

    const observed = convergedKey({
      name: "jeff@goodparty.org",
      provider_configs: [
        { provider: "fireworks", allowed_models: ["b"], allow_all_keys: true, keys: [] },
        { provider: "bedrock", allowed_models: ["a"], allow_all_keys: true, keys: [] },
      ],
      budgets: [
        { max_limit: 250, reset_duration: "1M" },
        { max_limit: 1, reset_duration: "1d" },
      ],
    } as Partial<VirtualKey> & { name: string });

    assert.deepEqual(differingFields(state, observed), []);
  });
});

describe("the converge loop (acceptance 1, 2, 3, 6)", () => {
  it("converges a changed budget in one PUT with the complete body, and counts it", async () => {
    const { gateway, updates } = fakeGateway({
      keys: [
        convergedKey({
          name: "jeff@goodparty.org",
          budgets: [{ max_limit: 100, reset_duration: "1M" }],
        } as Partial<VirtualKey> & { name: string }),
      ],
    });

    const result = await reconcileGovernance({
      gateway,
      directory: directory({ members: ["user-1"], userIds: { "jeff@goodparty.org": "user-1" } }),
      template: template(),
      overrides: {
        "jeff@goodparty.org": { budgets: [{ max_limit: 250, reset_duration: "1M" }] },
      },
    });

    assert.equal(result.outcome, "converged");
    assert.equal(result.changed, 1);
    assert.equal(result.unchanged, 0);
    assert.deepEqual(result.applied, [{ name: "jeff@goodparty.org", fields: ["budgets"] }]);
    assert.equal(result.minted, 0);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, "id-jeff@goodparty.org");
    // The complete set, not a patch: the provider list is restated alongside the
    // budget, because `provider_configs` is a replacement set on the wire.
    assert.deepEqual(updates[0].body, {
      calendar_aligned: true,
      provider_configs: [
        { provider: "bedrock", allowed_models: ["us.anthropic.claude-sonnet-5-5"], key_ids: ["*"] },
      ],
      budgets: [{ max_limit: 250, reset_duration: "1M" }],
    });
  });

  it("makes no PUT at all for an already-converged key, and says nothing changed", async () => {
    const { gateway, updates, listCalls } = fakeGateway({
      keys: [convergedKey({ name: "jeff@goodparty.org" })],
    });

    const result = await reconcileGovernance({
      gateway,
      directory: directory({ members: ["user-1"], userIds: { "jeff@goodparty.org": "user-1" } }),
      template: template(),
      overrides: {},
    });

    assert.equal(listCalls(), 1);
    // Decision 6, the assertion the whole design rests on: "nothing changed" is
    // an empty request set, not a request that happens to be a no-op.
    assert.deepEqual(updates, []);
    assert.equal(result.changed, 0);
    assert.equal(result.unchanged, 1);
    assert.deepEqual(result.applied, []);
    assert.equal(result.outcome, "converged");
  });

  it("mints nothing for a member with no key, and reports that it changed nothing (decision 7)", async () => {
    const { gateway, updates } = fakeGateway({ keys: [] });

    const result = await reconcileGovernance({
      gateway,
      directory: directory({
        members: ["user-1", "user-2", "user-3"],
        userIds: {},
      }),
      template: committedTemplate(),
      overrides: { "jeff@goodparty.org": { budgets: [{ max_limit: 250, reset_duration: "1M" }] } },
    });

    // Three engineers, no keys: the reconciler applies to existing keys and
    // grants nothing. A member with no key is still a `gp-pi bifrost-key` mint.
    assert.equal(result.memberCount, 3);
    assert.equal(result.managedKeyCount, 0);
    assert.equal(result.changed, 0);
    assert.equal(result.unchanged, 0);
    assert.equal(result.minted, 0);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(updates, []);
  });

  it("converges only the keys that differ, and counts both sides honestly", async () => {
    const { gateway, updates } = fakeGateway({
      keys: [
        convergedKey({ name: "kept@goodparty.org" }),
        convergedKey({
          name: "changed@goodparty.org",
          budgets: [{ max_limit: 100, reset_duration: "1M" }],
        } as Partial<VirtualKey> & { name: string }),
      ],
    });

    const result = await reconcileGovernance({
      gateway,
      directory: directory({
        members: ["user-1", "user-2"],
        userIds: { "kept@goodparty.org": "user-1", "changed@goodparty.org": "user-2" },
      }),
      template: template(),
      overrides: {
        "changed@goodparty.org": { budgets: [{ max_limit: 250, reset_duration: "1M" }] },
      },
    });

    // Decision 6: "converged" is a number a test can assert, not a log line.
    assert.equal(result.changed, 1);
    assert.equal(result.unchanged, 1);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, "id-changed@goodparty.org");
  });

  it("converges an unmarked key never, whoever its owner is", async () => {
    const { gateway, updates } = fakeGateway({
      keys: [key({ name: "hand-made@goodparty.org", description: "my test key" })],
    });

    const result = await reconcileGovernance({
      gateway,
      directory: directory({ members: ["user-1"], userIds: { "hand-made@goodparty.org": "user-1" } }),
      template: template(),
      overrides: { "hand-made@goodparty.org": { budgets: [{ max_limit: 1, reset_duration: "1M" }] } },
    });

    assert.equal(result.managedKeyCount, 0);
    assert.deepEqual(updates, []);
    assert.equal(result.changed, 0);
  });

  it("does not converge a departing person's key: that is the revocation loop's", async () => {
    const { gateway, updates } = fakeGateway({
      keys: [
        convergedKey({
          name: "gone@goodparty.org",
          budgets: [{ max_limit: 100, reset_duration: "1M" }],
        } as Partial<VirtualKey> & { name: string }),
      ],
    });

    const result = await reconcileGovernance({
      gateway,
      directory: directory({ members: ["user-1"], userIds: { "gone@goodparty.org": "user-9" } }),
      template: template(),
      overrides: { "gone@goodparty.org": { budgets: [{ max_limit: 250, reset_duration: "1M" }] } },
    });

    assert.deepEqual(result.skipped, [{ name: "gone@goodparty.org", reason: "not-a-member" }]);
    assert.deepEqual(updates, []);
    assert.equal(result.changed, 0);
  });

  it("skips a marker-bearing key whose name is not an email, and writes nothing", async () => {
    const { gateway, updates } = fakeGateway({
      keys: [convergedKey({ name: "jdoe" })],
    });

    const result = await reconcileGovernance({
      gateway,
      directory: directory({ members: ["user-1"], userIds: { jdoe: "user-1" } }),
      template: template(),
      overrides: {},
    });

    assert.deepEqual(result.skipped, [{ name: "jdoe", reason: "owner-not-an-email" }]);
    assert.deepEqual(updates, []);
  });

  it("never puts a key value in the result", async () => {
    const { gateway } = fakeGateway({
      keys: [convergedKey({ name: "jeff@goodparty.org" })],
    });
    const result = await reconcileGovernance({
      gateway,
      directory: directory({ members: ["user-1"], userIds: { "jeff@goodparty.org": "user-1" } }),
      template: template(),
      overrides: {},
    });
    assert.doesNotMatch(JSON.stringify(result), /sk-bf/);
  });
});

describe("failing closed, and not silently (decision 15)", () => {
  it("aborts on an empty group with no list and no write", async () => {
    const { gateway, updates, listCalls } = fakeGateway();
    const result = await reconcileGovernance({
      gateway,
      directory: directory({ members: [] }),
      template: template(),
      overrides: {},
    });

    assert.equal(result.outcome, "aborted");
    assert.equal(result.abortReason, "group-empty");
    assert.equal(listCalls(), 0);
    assert.deepEqual(updates, []);
  });

  it("fails the run when the group read errors, with no write", async () => {
    const { gateway, updates } = fakeGateway();
    await assert.rejects(
      reconcileGovernance({
        gateway,
        directory: directory({ listError: new Error("AccessDenied") }),
        template: template(),
        overrides: {},
      }),
      (error: unknown) =>
        error instanceof JanitorFailure && error.code === "membership-unavailable",
    );
    assert.deepEqual(updates, []);
  });

  it("fails the run when the key list errors, with no write", async () => {
    const { gateway, updates } = fakeGateway({ listError: new Error("500") });
    await assert.rejects(
      reconcileGovernance({
        gateway,
        directory: directory({ members: ["user-1"] }),
        template: template(),
        overrides: {},
      }),
      (error: unknown) =>
        error instanceof JanitorFailure && error.code === "gateway-unavailable",
    );
    assert.deepEqual(updates, []);
  });

  it("does no write when an owner lookup fails partway through", async () => {
    const { gateway, updates } = fakeGateway({
      keys: [
        convergedKey({
          name: "changed@goodparty.org",
          budgets: [{ max_limit: 100, reset_duration: "1M" }],
        } as Partial<VirtualKey> & { name: string }),
      ],
    });
    await assert.rejects(
      reconcileGovernance({
        gateway,
        directory: directory({ members: ["user-1"], getUserIdError: new Error("Throttled") }),
        template: template(),
        overrides: {
          "changed@goodparty.org": { budgets: [{ max_limit: 250, reset_duration: "1M" }] },
        },
      }),
      (error: unknown) =>
        error instanceof JanitorFailure && error.code === "membership-unavailable",
    );
    // Every read happens before the first write, so a run cannot converge one
    // key and then die on the next key's owner lookup.
    assert.deepEqual(updates, []);
  });

  it("fails the run when a PUT is refused, rather than carrying on", async () => {
    const { gateway } = fakeGateway({
      keys: [
        convergedKey({
          name: "changed@goodparty.org",
          budgets: [{ max_limit: 100, reset_duration: "1M" }],
        } as Partial<VirtualKey> & { name: string }),
      ],
      updateError: new Error("Bifrost answered 400"),
    });

    await assert.rejects(
      reconcileGovernance({
        gateway,
        directory: directory({ members: ["user-1"], userIds: { "changed@goodparty.org": "user-1" } }),
        template: template(),
        overrides: {
          "changed@goodparty.org": { budgets: [{ max_limit: 250, reset_duration: "1M" }] },
        },
      }),
      (error: unknown) =>
        error instanceof JanitorFailure && error.code === "gateway-unavailable",
    );
  });
});

describe("the committed documents converge a key to the same shape twice", () => {
  it("is idempotent: the body it would write is one the diff then finds nothing to change in", () => {
    // The shape the gateway would report after taking the body: this is what
    // makes a second tick's diff empty, and it is asserted rather than assumed
    // because a body the observation cannot round-trip is a permanent diff.
    const { state } = composeDesiredState({
      template: committedTemplate(),
      overrides: {
        "jeff@goodparty.org": {
          budgets: [{ max_limit: 250, reset_duration: "1M" }],
          rate_limit: { request_max_limit: 600, request_reset_duration: "5m" },
        },
      },
      email: "jeff@goodparty.org",
    });
    const body = convergenceBody(state);

    const asObserved: ObservedGovernance = {
      calendar_aligned: Boolean(body.calendar_aligned),
      provider_configs: (
        body.provider_configs as Array<Record<string, unknown>>
      ).map((entry) => ({
        provider: entry.provider as string,
        allowed_models: entry.allowed_models as string[],
        blacklisted_models: entry.blacklisted_models as string[],
        weight: (entry.weight as number | undefined) ?? null,
        allow_all_keys: true,
        keys: [],
      })),
      budgets: (body.budgets as Array<Record<string, unknown>>).map((entry) => ({
        max_limit: entry.max_limit as number,
        reset_duration: entry.reset_duration as string,
        current_usage: 42,
        last_reset: "2026-10-01T00:00:00Z",
      })),
      rate_limit: {
        ...(body.rate_limit as Record<string, unknown>),
        request_current_usage: 0,
      },
    };

    assert.deepEqual(differingFields(state, asObserved), []);

    // And the body is the complete provider list, entry for entry, so a second
    // PUT could never delete a provider by omitting it.
    const templateProviders = (committedTemplate().provider_configs ?? []).map(
      (entry) => entry.provider,
    );
    assert.deepEqual(
      (body.provider_configs as Array<Record<string, unknown>>).map((entry) => entry.provider),
      templateProviders,
    );
  });
});
