import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";

import { WORKBENCH_ACCOUNT_ID } from "../../utils/accounts";
import {
  ENGINEERS_GROUP_ID,
  KeyNameConflict,
  MAX_KEY_PAGES,
  MintFailure,
  REACTIVATION_BODY,
  WORKBENCH_ACCESS_ROLE_PREFIX,
  findExactKey,
  mintVirtualKey,
  needsReactivation,
  requireEngineer,
  workbenchAccessCaller,
  type KeyPage,
  type KeyQuery,
  type MembershipDirectory,
  type VirtualKey,
  type VirtualKeyGateway,
} from "./vk-mint-core";
import {
  convergenceBody,
  governanceDesiredState,
  type GovernanceOverrides,
  type GovernanceTemplate,
} from "./governance-desired-state";
import { reconcileGovernance, type JanitorGateway } from "./vk-janitor-core";
import { VK_DESCRIPTION } from "./vk-marker";

/**
 * The mint's rules, without AWS and without HTTP: step 3's idempotency cases
 * (docs/bifrost-virtual-keys.md, decisions 1, 2 and 4), each one a test.
 */

const WORKBENCH_ROLE =
  `arn:aws:sts::${WORKBENCH_ACCOUNT_ID}:assumed-role/` +
  `${WORKBENCH_ACCESS_ROLE_PREFIX}2c05f47560d36270/jeff@goodparty.org`;

const ssoEvent = (userArn: string, body?: unknown) => ({
  version: "2.0",
  routeKey: "$default",
  rawPath: "/",
  rawQueryString: "",
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  requestContext: {
    http: { method: "POST", path: "/" },
    authorizer: { iam: { userArn, callerId: "AIDA", accountId: WORKBENCH_ACCOUNT_ID } },
  },
});

const key = (overrides: Partial<VirtualKey> & { name: string }): VirtualKey => ({
  id: `id-${overrides.name}`,
  value: `sk-bf-${overrides.name}`,
  is_active: true,
  expires_at: null,
  delete_after_expire: null,
  description: "lambda-managed per-user key",
  ...overrides,
});

const template = {
  description: "lambda-managed per-user key",
  is_active: true,
  provider_configs: [{ provider: "bedrock", allowed_models: ["m"], key_ids: ["*"] }],
};

/** A gateway whose pages and calls are recorded, so a test can assert both. */
const fakeGateway = (options: {
  pages?: KeyPage[];
  create?: (body: Record<string, unknown>) => Promise<VirtualKey>;
  update?: (id: string, body: Record<string, unknown>) => Promise<VirtualKey>;
}) => {
  const calls: string[] = [];
  const queries: KeyQuery[] = [];
  const creates: Record<string, unknown>[] = [];
  const updates: Array<{ id: string; body: Record<string, unknown> }> = [];

  const gateway: VirtualKeyGateway = {
    list: async (query) => {
      calls.push(`list:${query.offset}`);
      queries.push(query);
      // Pages are consumed in call order, so a test can model a second list
      // call (after a 409) returning a different result from the first.
      return options.pages?.shift() ?? { keys: [], totalCount: 0 };
    },
    create: async (body) => {
      calls.push("create");
      creates.push(body);
      if (options.create) return options.create(body);
      return key({ name: String(body.name), value: "sk-bf-created" });
    },
    update: async (id, body) => {
      calls.push(`update:${id}`);
      updates.push({ id, body });
      if (options.update) return options.update(id, body);
      return key({ name: "jeff@goodparty.org", id, value: "sk-bf-reactivated" });
    },
  };

  return { gateway, calls, queries, creates, updates };
};

describe("the caller is the SigV4-verified ARN", () => {
  it("takes the session name of a WorkbenchAccess role in the workbench account as the email", () => {
    const caller = workbenchAccessCaller(ssoEvent(WORKBENCH_ROLE));
    assert.equal(caller?.email, "jeff@goodparty.org");
    assert.equal(caller?.roleName, `${WORKBENCH_ACCESS_ROLE_PREFIX}2c05f47560d36270`);
  });

  it("lowercases the session name, so the key name is the lowercase email", () => {
    const arn = `arn:aws:sts::${WORKBENCH_ACCOUNT_ID}:assumed-role/${WORKBENCH_ACCESS_ROLE_PREFIX}abc/Jeff@GoodParty.org`;
    assert.equal(workbenchAccessCaller(ssoEvent(arn))?.email, "jeff@goodparty.org");
  });

  it("refuses another role in the workbench account, which could pick its own session name", () => {
    // The gateway's own task role, named as a person. Decision 2: without this
    // check a role that is not WorkbenchAccess could mint somebody else's key.
    const arn = `arn:aws:sts::${WORKBENCH_ACCOUNT_ID}:assumed-role/bifrost-task/jeff@goodparty.org`;
    assert.equal(workbenchAccessCaller(ssoEvent(arn)), undefined);
  });

  it("refuses a WorkbenchAccess-shaped role in another account", () => {
    const arn = `arn:aws:sts::333022194791:assumed-role/${WORKBENCH_ACCESS_ROLE_PREFIX}abc/jeff@goodparty.org`;
    assert.equal(workbenchAccessCaller(ssoEvent(arn)), undefined);
  });

  it("refuses an event with no authorizer, which is what a direct Invoke delivers", () => {
    assert.equal(workbenchAccessCaller({ body: "{}" }), undefined);
    assert.equal(workbenchAccessCaller(undefined), undefined);
    assert.equal(workbenchAccessCaller({ requestContext: { authorizer: {} } }), undefined);
  });

  it("refuses an IAM user ARN, a role ARN that is not an assumed-role ARN, and a blank session", () => {
    assert.equal(
      workbenchAccessCaller(ssoEvent(`arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:user/jeff`)),
      undefined,
    );
    assert.equal(
      workbenchAccessCaller(ssoEvent(`arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/bifrost-task`)),
      undefined,
    );
    assert.equal(
      workbenchAccessCaller(
        ssoEvent(`arn:aws:sts::${WORKBENCH_ACCOUNT_ID}:assumed-role/${WORKBENCH_ACCESS_ROLE_PREFIX}abc/`),
      ),
      undefined,
    );
  });

  it("keeps the group id the reader role's policy literal names", () => {
    // deploy/components/bifrost-vk-reader.ts scopes ListGroupMemberships to
    // this group; a different id here is a 403 on every membership read. The
    // deploy-workbench/bifrost-vk-mint.test.ts cross-check reads that file; this
    // pins the constant itself for a reader of the handler.
    assert.equal(ENGINEERS_GROUP_ID, "383193a0-7001-70d9-a321-ffe6d8af7378");
  });
});

describe("exact-name matching, because search is a substring", () => {
  it("filters a superset down to the exact lowercase email", () => {
    const keys = [
      key({ name: "xjeff@goodparty.org", value: "sk-bf-wrong" }),
      key({ name: "jeff@goodparty.org", value: "sk-bf-right" }),
      key({ name: "jeff@goodparty.org.evil.example", value: "sk-bf-also-wrong" }),
    ];
    assert.equal(findExactKey(keys, "jeff@goodparty.org")?.value, "sk-bf-right");
  });

  it("never matches on a substring, a prefix or a different case of the whole name", () => {
    assert.equal(findExactKey([key({ name: "jeff@goodparty.org.old" })], "jeff@goodparty.org"), undefined);
    assert.equal(findExactKey([key({ name: "xjeff@goodparty.org" })], "jeff@goodparty.org"), undefined);
    // A name stored with different case still matches, because both sides are
    // lowercased before the equality test.
    assert.equal(findExactKey([key({ name: "Jeff@GoodParty.org" })], "jeff@goodparty.org")?.name, "Jeff@GoodParty.org");
  });

  it("returns the exact key from a later page rather than creating a second one", async () => {
    const { gateway, calls, creates } = fakeGateway({
      pages: [
        { keys: [key({ name: "xjeff@goodparty.org" })], totalCount: 2 },
        { keys: [key({ name: "jeff@goodparty.org" })], totalCount: 2 },
      ],
    });
    const result = await mintVirtualKey({ gateway, template, email: "jeff@goodparty.org" });
    assert.equal(result.action, "existing");
    assert.equal(result.key, "sk-bf-jeff@goodparty.org");
    // The offset advances by what the page actually returned, because that is
    // the only number that cannot skip a row when a gateway returns a short
    // page against a larger total_count.
    assert.deepEqual(calls, ["list:0", "list:1"]);
    assert.equal(creates.length, 0);
  });

  it("stops instead of looping when the result set never ends", async () => {
    const gateway: VirtualKeyGateway = {
      list: async (query) => ({
        keys: [key({ name: `x${query.offset}@goodparty.org` })],
        totalCount: 1_000_000,
      }),
      create: async () => key({ name: "jeff@goodparty.org" }),
      update: async () => key({ name: "jeff@goodparty.org" }),
    };
    await assert.rejects(
      mintVirtualKey({ gateway, template, email: "jeff@goodparty.org" }),
      (error: unknown) => error instanceof MintFailure && error.code === "gateway-unavailable",
    );
    assert.equal(MAX_KEY_PAGES, 20);
  });
});

describe("idempotent minting", () => {
  it("returns an active key as it is, with no write", async () => {
    const { gateway, calls } = fakeGateway({
      pages: [{ keys: [key({ name: "jeff@goodparty.org", value: "sk-bf-existing" })], totalCount: 1 }],
    });
    const result = await mintVirtualKey({ gateway, template, email: "jeff@goodparty.org" });
    assert.deepEqual(result, {
      key: "sk-bf-existing",
      email: "jeff@goodparty.org",
      action: "existing",
    });
    assert.deepEqual(calls, ["list:0"]);
  });

  it("creates from the template plus the name when no key exists", async () => {
    const { gateway, creates } = fakeGateway({
      pages: [{ keys: [], totalCount: 0 }],
      create: async (body) => key({ name: String(body.name), value: "sk-bf-new" }),
    });
    const result = await mintVirtualKey({ gateway, template, email: "jeff@goodparty.org" });
    assert.equal(result.action, "created");
    assert.equal(result.key, "sk-bf-new");
    // The template's own fields, the name, and the governance the reconciler
    // would compute for this person. The governance half (`budgets: []`,
    // `calendar_aligned: true`) is `governanceBody`'s, so a key created here is
    // already the shape the first tick compares against (step 5 of
    // `docs/bifrost-reconciler.md`).
    assert.deepEqual(creates, [
      {
        ...template,
        calendar_aligned: true,
        budgets: [],
        name: "jeff@goodparty.org",
      },
    ]);
  });

  it("reactivates an inactive key in one PUT that also clears the expiry and the deletion timer", async () => {
    const { gateway, updates, creates, calls } = fakeGateway({
      pages: [
        {
          keys: [
            key({
              name: "jeff@goodparty.org",
              is_active: false,
              expires_at: "2027-01-27T00:00:00Z",
              delete_after_expire: true,
            }),
          ],
          totalCount: 1,
        },
      ],
    });
    const result = await mintVirtualKey({ gateway, template, email: "jeff@goodparty.org" });
    assert.equal(result.action, "reactivated");
    assert.equal(result.key, "sk-bf-reactivated");
    assert.equal(creates.length, 0, "a returning member must not get a second key");
    assert.deepEqual(calls, ["list:0", `update:${"id-jeff@goodparty.org"}`]);
    // The exact body, in one call: active, `expires_at: ""` (clear) and
    // `delete_after_expire: null` (back to inheriting). Omitting the last two
    // leaves the janitor's timer running, and a past expiry would reject the
    // key whatever is_active says.
    assert.deepEqual(updates, [
      { id: "id-jeff@goodparty.org", body: { ...REACTIVATION_BODY } },
    ]);
    assert.deepEqual(Object.keys(updates[0].body).sort(), [
      "delete_after_expire",
      "expires_at",
      "is_active",
    ]);
    assert.equal(updates[0].body.expires_at, "");
    assert.equal(updates[0].body.delete_after_expire, null);
    assert.equal(updates[0].body.is_active, true);
  });

  it("clears an expiry on a key that is still active", async () => {
    const { gateway, updates } = fakeGateway({
      pages: [
        {
          keys: [key({ name: "jeff@goodparty.org", expires_at: "2027-01-27T00:00:00Z" })],
          totalCount: 1,
        },
      ],
    });
    const result = await mintVirtualKey({ gateway, template, email: "jeff@goodparty.org" });
    assert.equal(result.action, "reactivated");
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].body, { ...REACTIVATION_BODY });
  });

  it("treats an empty or absent expiry as no expiry", () => {
    assert.equal(needsReactivation(key({ name: "a", expires_at: "" })), false);
    assert.equal(needsReactivation(key({ name: "a", expires_at: null })), false);
    assert.equal(needsReactivation(key({ name: "a", expires_at: "2027-01-27T00:00:00Z" })), true);
    assert.equal(needsReactivation(key({ name: "a", is_active: false })), true);
    // `is_active` nil means true at the pinned tag ("IsActive nil means true"),
    // but the wire shape the list returns is a boolean; only an explicit false
    // or a missing one forces a PUT, which is the safe reading.
    assert.equal(needsReactivation(key({ name: "a", is_active: null })), true);
  });

  it("loses the create race with a 409, re-reads and returns the winner's key", async () => {
    let created = false;
    const { gateway, calls, creates } = fakeGateway({
      pages: [
        { keys: [], totalCount: 0 },
        { keys: [key({ name: "jeff@goodparty.org", value: "sk-bf-winner" })], totalCount: 1 },
      ],
      create: async () => {
        created = true;
        throw new KeyNameConflict();
      },
    });
    const result = await mintVirtualKey({ gateway, template, email: "jeff@goodparty.org" });
    assert.equal(created, true);
    assert.equal(result.action, "existing");
    assert.equal(result.key, "sk-bf-winner");
    assert.equal(creates.length, 1, "the loser must not try to create a second time");
    // list (before), create, list (after the conflict)
    assert.deepEqual(calls, ["list:0", "create", "list:0"]);
  });

  it("does not mint when the 409's winner cannot be read back", async () => {
    const { gateway } = fakeGateway({
      pages: [{ keys: [], totalCount: 0 }],
      create: async () => {
        throw new KeyNameConflict();
      },
    });
    await assert.rejects(
      mintVirtualKey({ gateway, template, email: "jeff@goodparty.org" }),
      (error: unknown) =>
        error instanceof MintFailure && error.code === "key-not-returned" && error.status === 502,
    );
  });

  it("falls back to the listed value when the update response carries none", async () => {
    // The PUT at the pinned tag returns the re-read key with its plaintext
    // value; this holds the reactivation to working even if a response shape
    // omits it, because the value does not change on reactivation and the
    // listing that found the key already has it.
    const { gateway } = fakeGateway({
      pages: [
        {
          keys: [key({ name: "jeff@goodparty.org", value: "sk-bf-listed", is_active: false })],
          totalCount: 1,
        },
      ],
      update: async (id) => ({ id, name: "jeff@goodparty.org", is_active: true, value: null }),
    });
    const result = await mintVirtualKey({ gateway, template, email: "jeff@goodparty.org" });
    assert.equal(result.action, "reactivated");
    assert.equal(result.key, "sk-bf-listed");
  });

  it("does not return an empty value as a key", async () => {
    const { gateway } = fakeGateway({
      pages: [{ keys: [key({ name: "jeff@goodparty.org", value: "" })], totalCount: 1 }],
    });
    await assert.rejects(
      mintVirtualKey({ gateway, template, email: "jeff@goodparty.org" }),
      (error: unknown) => error instanceof MintFailure && error.code === "key-not-returned",
    );
  });

  it("propagates a gateway error from the list without creating anything", async () => {
    const gateway: VirtualKeyGateway = {
      list: async () => {
        throw new MintFailure("gateway-unavailable", "Bifrost answered 500");
      },
      create: async () => {
        throw new Error("must not create");
      },
      update: async () => {
        throw new Error("must not update");
      },
    };
    await assert.rejects(
      mintVirtualKey({ gateway, template, email: "jeff@goodparty.org" }),
      (error: unknown) => error instanceof MintFailure && error.status === 502,
    );
  });
});

describe("live membership, every call (decision 1)", () => {
  const directory = (options: {
    userId?: string | null;
    members?: string[];
    getUserIdError?: Error;
    listError?: Error;
  }): MembershipDirectory => ({
    getUserId: async () => {
      if (options.getUserIdError) throw options.getUserIdError;
      return options.userId ?? null;
    },
    listMemberUserIds: async () => {
      if (options.listError) throw options.listError;
      return options.members ?? [];
    },
  });

  it("admits a member", async () => {
    const userId = await requireEngineer(directory({ userId: "u-1", members: ["u-1", "u-2"] }), "jeff@goodparty.org");
    assert.equal(userId, "u-1");
  });

  it("refuses an email that resolves to no user with 403", async () => {
    await assert.rejects(
      requireEngineer(directory({ userId: null, members: ["u-1"] }), "gone@goodparty.org"),
      (error: unknown) => error instanceof MintFailure && error.status === 403 && error.code === "not-a-member",
    );
  });

  it("refuses a resolved user who is not in the group with 403", async () => {
    await assert.rejects(
      requireEngineer(directory({ userId: "u-9", members: ["u-1"] }), "gone@goodparty.org"),
      (error: unknown) => error instanceof MintFailure && error.status === 403,
    );
  });

  it("refuses everybody when the group read comes back empty", async () => {
    // The same fail-closed reading as the janitor's: "the group is empty" is
    // indistinguishable from "the read failed" and neither admits a key.
    await assert.rejects(
      requireEngineer(directory({ userId: "u-1", members: [] }), "jeff@goodparty.org"),
      (error: unknown) => error instanceof MintFailure && error.status === 403,
    );
  });

  it("fails closed with 503 when GetUserId errors", async () => {
    await assert.rejects(
      requireEngineer(
        directory({ getUserIdError: new Error("AccessDenied"), members: ["u-1"] }),
        "jeff@goodparty.org",
      ),
      (error: unknown) =>
        error instanceof MintFailure && error.status === 503 && error.code === "membership-unavailable",
    );
  });

  it("fails closed with 503 when the membership list errors", async () => {
    await assert.rejects(
      requireEngineer(
        directory({ userId: "u-1", listError: new Error("Throttled") }),
        "jeff@goodparty.org",
      ),
      (error: unknown) => error instanceof MintFailure && error.status === 503,
    );
  });
});

/**
 * Step 5 of `docs/bifrost-reconciler.md`: **a mint for an overridden email
 * produces a key the reconciler then reports as unchanged.**
 *
 * The gate the plan sets for this step, and the reason the two live in one test
 * file section rather than two: the assertion is not "the create body had the
 * right fields" but "the reconciler, run over the key this create produced,
 * finds nothing to write". A test of the first kind passes on a mint that agrees
 * with the reconciler by coincidence, and the coincidence is exactly what drifts.
 *
 * The gateway here is a fake that *keeps* what a create writes, so the key the
 * reconciler lists is the one the mint actually asked for, hydrated the way
 * `GET /api/governance/virtual-keys` hydrates it (`applyVKGovernanceFromModelConfigs`
 * at the pinned tag): `allow_all_keys` and `keys` rather than `key_ids`, budget
 * rows with the runtime columns, and a rate limit with its counters.
 */
describe("a minted key starts converged (step 5)", () => {
  /**
   * A gateway that stores the create body it was given and answers the list the
   * way the real one does. Nothing is derived from the desired-state code: the
   * key is a translation of the request, so a difference the reconciler finds is
   * a difference the mint really sent.
   */
  const storingGateway = () => {
    const created: Record<string, unknown>[] = [];
    let stored: Record<string, unknown> | undefined;

    /** A stored key row, hydrated the way the list route hydrates it. */
    const asListed = (): VirtualKey =>
      ({
        id: "id-created",
        name: stored?.name,
        value: "sk-bf-created",
        is_active: stored?.is_active,
        expires_at: null,
        delete_after_expire: null,
        description: stored?.description,
        calendar_aligned: stored?.calendar_aligned ?? null,
        budgets: ((stored?.budgets as Record<string, unknown>[]) ?? []).map(
          (budget) => ({
            id: `budget-${String(budget.reset_duration)}`,
            max_limit: budget.max_limit,
            reset_duration: budget.reset_duration,
            // Runtime-owned, written by the accounting, never by git.
            current_usage: 0,
            last_reset: "2026-11-01T00:00:00Z",
            is_calendar_aligned: true,
          }),
        ),
        provider_configs: (
          (stored?.provider_configs as Record<string, unknown>[]) ?? []
        ).map((config) => ({
          id: 1,
          provider: config.provider,
          allowed_models: config.allowed_models ?? [],
          blacklisted_models: config.blacklisted_models ?? [],
          weight: config.weight ?? null,
          // The association the other way round, as the route reports it.
          allow_all_keys: Array.isArray(config.key_ids)
            ? (config.key_ids as unknown[]).includes("*")
            : false,
          keys: [],
        })),
        rate_limit:
          stored?.rate_limit === undefined
            ? null
            : {
                ...(stored.rate_limit as Record<string, unknown>),
                token_current_usage: 0,
                request_current_usage: 0,
              },
      }) as unknown as VirtualKey;

    const gateway: VirtualKeyGateway & JanitorGateway = {
      list: async () => ({
        keys: stored ? [asListed()] : [],
        totalCount: stored ? 1 : 0,
      }),
      create: async (body) => {
        created.push(body);
        stored = body;
        return asListed();
      },
      update: async () => asListed(),
    };
    return { gateway, created };
  };

  /**
   * A template with the committed document's shape: the marker, one provider
   * entry per model family, and no budgets or rate limit (decisions 11 and 12).
   */
  const keyTemplate = (): GovernanceTemplate => ({
    description: VK_DESCRIPTION,
    is_active: true,
    provider_configs: [
      {
        provider: "bedrock",
        allowed_models: ["us.anthropic.claude-sonnet-5-5", "us.moonshotai.kimi-k3"],
        key_ids: ["*"],
      },
      {
        provider: "fireworks",
        allowed_models: ["worker-default"],
        key_ids: ["*"],
      },
    ],
  });

  const EMAIL = "jeff@goodparty.org";

  /** The directory the reconciler needs; its answers are not this test's subject. */
  const directory = (): MembershipDirectory => ({
    getUserId: async () => "user-1",
    listMemberUserIds: async () => ["user-1"],
  });

  /** Run the reconciler over whatever the mint's create left in the fake. */
  const reconcile = async (
    gateway: JanitorGateway,
    overrides: GovernanceOverrides,
  ) =>
    reconcileGovernance({
      gateway,
      directory: directory(),
      template: keyTemplate(),
      overrides,
    });

  it("is unchanged to the reconciler when the email has an override", async () => {
    const overrides: GovernanceOverrides = {
      [EMAIL]: {
        budgets: [{ max_limit: 250, reset_duration: "1M" }],
        rate_limit: { request_max_limit: 600, request_reset_duration: "5m" },
      },
    };

    const { gateway, created } = storingGateway();
    const minted = await mintVirtualKey({
      gateway,
      template: keyTemplate(),
      overrides,
      email: EMAIL,
    });
    assert.equal(minted.action, "created");

    // What the create asked for, before the reconciler sees it: the override is
    // in the body, and it is in the composed shape rather than the override's
    // own spelling.
    assert.deepEqual(created[0].budgets, [
      { max_limit: 250, reset_duration: "1M" },
    ]);
    assert.deepEqual(created[0].rate_limit, {
      request_max_limit: 600,
      request_reset_duration: "5m",
    });
    assert.equal(created[0].calendar_aligned, true);
    // The template's model policy survived a budget-only override: the merge is
    // field by field (decision 9), not a replacement of the whole document.
    assert.deepEqual(created[0].provider_configs, keyTemplate().provider_configs);

    // The criterion: the reconciler over that key writes nothing.
    const result = await reconcile(gateway, overrides);
    assert.equal(result.outcome, "converged");
    assert.equal(result.changed, 0);
    assert.equal(result.unchanged, 1);
    assert.deepEqual(result.applied, []);
    assert.equal(result.minted, 0);
  });

  it("is unchanged to the reconciler for somebody with no override", async () => {
    const { gateway } = storingGateway();
    const minted = await mintVirtualKey({
      gateway,
      template: keyTemplate(),
      overrides: {},
      email: EMAIL,
    });
    assert.equal(minted.action, "created");

    const result = await reconcile(gateway, {});
    assert.equal(result.changed, 0);
    assert.equal(result.unchanged, 1);
    assert.deepEqual(result.applied, []);
  });

  it("is unchanged when the override narrows the provider list and inherits the rest", async () => {
    // The case that would break a mint copying the template or the override
    // instead of the merge: `provider_configs` is a replacement set on the wire
    // (decision 9), so a narrowed list has to be the list that is created, and
    // the reconciler has to agree about it.
    const overrides: GovernanceOverrides = {
      [EMAIL]: {
        provider_configs: [
          { provider: "bedrock", allowed_models: ["us.anthropic.claude-sonnet-5-5"], key_ids: ["*"] },
        ],
        calendar_aligned: false,
      },
    };

    const { gateway, created } = storingGateway();
    await mintVirtualKey({
      gateway,
      template: keyTemplate(),
      overrides,
      email: EMAIL,
    });

    assert.deepEqual(created[0].provider_configs, [
      { provider: "bedrock", allowed_models: ["us.anthropic.claude-sonnet-5-5"], key_ids: ["*"] },
    ]);
    assert.equal(created[0].calendar_aligned, false);

    const result = await reconcile(gateway, overrides);
    assert.equal(result.changed, 0);
    assert.equal(result.unchanged, 1);
  });

  it("never puts a key value in the create body, and the mint hands the gateway's back", async () => {
    // Decision 7: the reconciler mints nothing and the minter is the only place
    // a credential exists. The create is where it comes into existence, and the
    // gateway generates it — so the only `value` in play is the one the gateway
    // returned, and the desired state has no field for one.
    const { gateway, created } = storingGateway();
    const result = await mintVirtualKey({
      gateway,
      template: keyTemplate(),
      overrides: {
        [EMAIL]: { budgets: [{ max_limit: 250, reset_duration: "1M" }] },
      },
      email: EMAIL,
    });

    assert.ok(!("value" in created[0]), "the create body must not carry a key value");
    assert.ok(!("key" in created[0]), "the create body must not carry a key value");
    assert.equal(JSON.stringify(created[0]).includes("sk-bf"), false);
    // And what comes back is the gateway's own value, not one composed here.
    assert.equal(result.key, "sk-bf-created");

    // The reconciler's body for the same key has no credential either: it is
    // built from the desired state, and the desired state has no such field.
    const body = convergenceBody(
      governanceDesiredState({
        template: keyTemplate(),
        overrides: { [EMAIL]: { budgets: [{ max_limit: 250, reset_duration: "1M" }] } },
        email: EMAIL,
      }).state,
    );
    assert.ok(!("value" in body));
    assert.equal(JSON.stringify(body).includes("sk-bf"), false);
  });

  it("does not converge an existing key, and does not create a second one", async () => {
    // The other half of the split decision 7 makes: governance on an existing key
    // is the reconciler's, so a mint that finds a key returns it. The mint's job
    // is granting, and a mint that also wrote governance would be a second writer
    // racing the five-minute tick.
    const { gateway, created } = storingGateway();
    await mintVirtualKey({
      gateway,
      template: keyTemplate(),
      overrides: {},
      email: EMAIL,
    });
    const createsBefore = created.length;

    const second = await mintVirtualKey({
      gateway,
      template: keyTemplate(),
      overrides: { [EMAIL]: { budgets: [{ max_limit: 250, reset_duration: "1M" }] } },
      email: EMAIL,
    });
    assert.equal(second.action, "existing");
    assert.equal(created.length, createsBefore, "a second mint must not create");

    // So the reconciler is the one that applies the override, exactly as it
    // would for a key minted before the override existed.
    const result = await reconcile(gateway, {
      [EMAIL]: { budgets: [{ max_limit: 250, reset_duration: "1M" }] },
    });
    assert.equal(result.changed, 1);
    assert.deepEqual(result.applied, [{ name: EMAIL, fields: ["budgets"] }]);
  });
});

describe("the committed documents, minted and then reconciled", () => {
  const TEMPLATE_PATH = path.resolve(__dirname, "vk-mint-template.json");
  const OVERRIDES_PATH = path.resolve(__dirname, "governance-overrides.json");

  /**
   * The same two files the Lambdas read out of SSM, and the same shape the
   * handler hands to `mintVirtualKey`: the template as written, and the
   * overrides document with its `$comment` metadata still on it (which the
   * merge ignores and the desired state never carries).
   */
  const documents = () => ({
    template: JSON.parse(
      fs.readFileSync(TEMPLATE_PATH, "utf8"),
    ) as GovernanceTemplate,
    overrides: JSON.parse(
      fs.readFileSync(OVERRIDES_PATH, "utf8"),
    ) as GovernanceOverrides,
  });

  /**
   * The fake gateway from the acceptance suite, which stores a create and lists
   * it back hydrated. Repeated here rather than exported from a test file: it is
   * the smallest thing that can answer "what would the reconciler see".
   */
  const storingGateway = () => {
    let stored: Record<string, unknown> | undefined;
    const asListed = (): VirtualKey =>
      ({
        id: "id-created",
        name: stored?.name,
        value: "sk-bf-created",
        is_active: stored?.is_active,
        expires_at: null,
        delete_after_expire: null,
        description: stored?.description,
        calendar_aligned: (stored?.calendar_aligned as boolean) ?? null,
        budgets: ((stored?.budgets as Record<string, unknown>[]) ?? []).map(
          (budget) => ({
            max_limit: budget.max_limit,
            reset_duration: budget.reset_duration,
            current_usage: 0,
          }),
        ),
        provider_configs: (
          (stored?.provider_configs as Record<string, unknown>[]) ?? []
        ).map((config) => ({
          provider: config.provider,
          allowed_models: config.allowed_models ?? [],
          blacklisted_models: config.blacklisted_models ?? [],
          weight: config.weight ?? null,
          allow_all_keys: Array.isArray(config.key_ids)
            ? (config.key_ids as unknown[]).includes("*")
            : false,
          keys: [],
        })),
        rate_limit:
          stored?.rate_limit === undefined
            ? null
            : (stored.rate_limit as Record<string, unknown>),
      }) as unknown as VirtualKey;

    const gateway: VirtualKeyGateway & JanitorGateway = {
      list: async () => ({
        keys: stored ? [asListed()] : [],
        totalCount: stored ? 1 : 0,
      }),
      create: async (body) => {
        stored = body;
        return asListed();
      },
      update: async () => asListed(),
    };
    return gateway;
  };

  const EMAIL = "jeff@goodparty.org";

  it("mints a key from the committed template that the reconciler reports unchanged", async () => {
    const gateway = storingGateway();
    const { template, overrides } = documents();

    const minted = await mintVirtualKey({ gateway, template, overrides, email: EMAIL });
    assert.equal(minted.action, "created");

    const result = await reconcileGovernance({
      gateway,
      directory: {
        getUserId: async () => "user-1",
        listMemberUserIds: async () => ["user-1"],
      },
      template,
      overrides,
    });

    // The criterion, against the files as committed rather than a fixture: a
    // real mint for a real email is a key the next tick has nothing to do for.
    assert.equal(result.outcome, "converged");
    assert.equal(result.changed, 0);
    assert.equal(result.unchanged, 1);
    assert.deepEqual(result.applied, []);
    assert.equal(result.minted, 0);
  });

  it("mints a key that starts unchanged to the reconciler when the committed overrides name the person", async () => {
    // The same, with an override layered on the committed document the way a
    // real one would be, so the criterion is proven for the case the step is
    // about rather than only for the empty document.
    const gateway = storingGateway();
    const { template, overrides } = documents();
    const withOverride: GovernanceOverrides = {
      ...overrides,
      [EMAIL]: {
        budgets: [{ max_limit: 250, reset_duration: "1M" }],
        rate_limit: { request_max_limit: 600, request_reset_duration: "5m" },
        calendar_aligned: true,
      },
    };

    await mintVirtualKey({ gateway, template, overrides: withOverride, email: EMAIL });

    const result = await reconcileGovernance({
      gateway,
      directory: {
        getUserId: async () => "user-1",
        listMemberUserIds: async () => ["user-1"],
      },
      template,
      overrides: withOverride,
    });
    assert.equal(result.changed, 0);
    assert.equal(result.unchanged, 1);
  });
});
