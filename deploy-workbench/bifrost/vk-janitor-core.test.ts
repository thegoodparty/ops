import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  KeyPage,
  MembershipDirectory,
  VirtualKey,
} from "./vk-mint-core";
import { VK_DESCRIPTION } from "./vk-marker";
import {
  JANITOR_MAX_KEY_PAGES,
  JanitorFailure,
  VK_RETENTION_DAYS,
  deactivationBody,
  hasDeletionTimer,
  isEmailShaped,
  reconcileVirtualKeys,
  retentionDeadline,
  type JanitorGateway,
} from "./vk-janitor-core";

/**
 * The janitor's rules, without AWS and without HTTP: step 5's reconcile cases
 * (`docs/bifrost-virtual-keys.md`, decision 6), each one a test.
 *
 * The set the plan asks for is here by name — a member's key left active, a
 * departed member's key deactivated, an unmarked key untouched, a directory or
 * gateway read failing closed, and the unresolved `userName` of open item 6 —
 * plus the two edges the retention timer creates (set once, never reactivated).
 */

const NOW = new Date("2026-10-29T12:00:00.000Z");

const key = (overrides: Partial<VirtualKey> & { name: string }): VirtualKey => ({
  id: `id-${overrides.name}`,
  // A value is present in the gateway's response and must never reach a log or
  // a result. If it ever shows up in `JSON.stringify(result)`, a test fails.
  value: "sk-bf-the-value-that-must-never-be-logged",
  is_active: true,
  expires_at: null,
  delete_after_expire: null,
  description: VK_DESCRIPTION,
  ...overrides,
});

/**
 * A directory whose reads are recorded, so a test can assert both the verdict
 * and that an already-timed-out key was not looked up at all.
 */
const directory = (
  options: {
    members?: readonly string[];
    userIds?: Record<string, string | null>;
    getUserIdError?: Error;
    listError?: Error;
  } = {},
): { directory: MembershipDirectory; lookups: string[]; listCalls: () => number } => {
  const lookups: string[] = [];
  let listCalls = 0;
  return {
    lookups,
    listCalls: () => listCalls,
    directory: {
      getUserId: async (email) => {
        lookups.push(email);
        if (options.getUserIdError) throw options.getUserIdError;
        return options.userIds?.[email] ?? null;
      },
      listMemberUserIds: async () => {
        listCalls++;
        if (options.listError) throw options.listError;
        return options.members ?? ["user-1"];
      },
    },
  };
};

/** A gateway whose pages and writes are recorded, in call order. */
const fakeGateway = (
  options: {
    pages?: KeyPage[];
    listError?: Error;
    updateError?: Error;
  } = {},
): {
  gateway: JanitorGateway;
  updates: Array<{ id: string; body: Record<string, unknown> }>;
  listCalls: () => number;
} => {
  const updates: Array<{ id: string; body: Record<string, unknown> }> = [];
  let listCalls = 0;
  return {
    updates,
    listCalls: () => listCalls,
    gateway: {
      list: async () => {
        if (options.listError) throw options.listError;
        const page = options.pages?.[listCalls] ?? { keys: [], totalCount: 0 };
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

describe("the deactivation write (decision 6)", () => {
  it("deactivates, dates the retention window ninety days out and schedules the delete", () => {
    assert.equal(VK_RETENTION_DAYS, 90);
    assert.equal(retentionDeadline(NOW), "2027-01-27T12:00:00Z");
    // RFC3339, no fractional seconds: the shape the gateway's update path reads
    // as a timestamp, and the empty string is its spelling for "no expiry".
    assert.match(retentionDeadline(NOW), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.deepEqual(deactivationBody(NOW), {
      is_active: false,
      expires_at: "2027-01-27T12:00:00Z",
      delete_after_expire: true,
    });
  });

  it("recognises a key that already carries the whole timer", () => {
    assert.equal(
      hasDeletionTimer(
        key({
          name: "a",
          is_active: false,
          expires_at: "2027-01-27T00:00:00Z",
          delete_after_expire: true,
        }),
      ),
      true,
    );
    // An expiry without the delete flag is a partial transition, completed once
    // rather than skipped; the next run then sees all three.
    assert.equal(
      hasDeletionTimer(
        key({
          name: "a",
          is_active: false,
          expires_at: "2027-01-27T00:00:00Z",
          delete_after_expire: null,
        }),
      ),
      false,
    );
    // Still active: a member whose key an external actor deactivated without a
    // timer is not the janitor's to delete.
    assert.equal(
      hasDeletionTimer(
        key({ name: "a", is_active: true, expires_at: "2027-01-27T00:00:00Z", delete_after_expire: true }),
      ),
      false,
    );
    assert.equal(hasDeletionTimer(key({ name: "a", is_active: false })), false);
    assert.equal(
      hasDeletionTimer(key({ name: "a", is_active: false, expires_at: "  " })),
      false,
    );
  });
});

describe("the reconcile loop", () => {
  it("leaves a member's active key active, with no write", async () => {
    const { directory: dir, lookups } = directory({
      members: ["user-1", "user-2"],
      userIds: { "jeff@goodparty.org": "user-1" },
    });
    const { gateway, updates } = fakeGateway({
      pages: [{ keys: [key({ name: "jeff@goodparty.org" })], totalCount: 1 }],
    });

    const result = await reconcileVirtualKeys({ directory: dir, gateway, now: NOW });

    assert.equal(result.outcome, "ok");
    assert.deepEqual(result.kept, ["jeff@goodparty.org"]);
    assert.deepEqual(result.deactivated, []);
    assert.equal(result.memberCount, 2);
    assert.equal(result.managedKeyCount, 1);
    assert.deepEqual(lookups, ["jeff@goodparty.org"]);
    assert.deepEqual(updates, []);
  });

  it("deactivates a departed member's key in one PUT", async () => {
    const { directory: dir } = directory({
      members: ["user-1"],
      // The person's Identity Center user still exists; they are just not in
      // the group any more.
      userIds: { "gone@goodparty.org": "user-9" },
    });
    const { gateway, updates } = fakeGateway({
      pages: [{ keys: [key({ name: "gone@goodparty.org" })], totalCount: 1 }],
    });

    const result = await reconcileVirtualKeys({ directory: dir, gateway, now: NOW });

    assert.deepEqual(result.deactivated, [
      { name: "gone@goodparty.org", reason: "not-a-member" },
    ]);
    assert.deepEqual(updates, [
      {
        id: "id-gone@goodparty.org",
        body: {
          is_active: false,
          expires_at: "2027-01-27T12:00:00Z",
          delete_after_expire: true,
        },
      },
    ]);
    // The three fields are the whole write: nothing else is touched on a key
    // that still has its budgets and spend history.
    assert.deepEqual(Object.keys(updates[0].body).sort(), [
      "delete_after_expire",
      "expires_at",
      "is_active",
    ]);
  });

  it("deactivates a key whose owner resolves to no Identity Center user", async () => {
    const { directory: dir, lookups } = directory({
      members: ["user-1"],
      userIds: {},
    });
    const { gateway, updates } = fakeGateway({
      pages: [{ keys: [key({ name: "deleted@goodparty.org" })], totalCount: 1 }],
    });

    const result = await reconcileVirtualKeys({ directory: dir, gateway, now: NOW });

    assert.deepEqual(lookups, ["deleted@goodparty.org"]);
    // Decision 6's fail-closed direction: an owner that resolves to no user is
    // not a member. The log records which of the two reasons it was.
    assert.deepEqual(result.deactivated, [
      { name: "deleted@goodparty.org", reason: "owner-unresolved" },
    ]);
    assert.equal(updates.length, 1);
  });

  it("never touches a key without the marker, whoever its owner is", async () => {
    const { directory: dir, lookups } = directory({ members: ["user-1"] });
    const { gateway, updates } = mkGatewayWithUnmarked();

    const result = await reconcileVirtualKeys({ directory: dir, gateway, now: NOW });

    assert.equal(result.managedKeyCount, 0);
    assert.deepEqual(result.kept, []);
    assert.deepEqual(result.deactivated, []);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(updates, []);
    // Not even looked up: a hand-made key is not evidence of an owner this job
    // may resolve, let alone deactivate. The marker is the whole safety
    // property (decision 5).
    assert.deepEqual(lookups, []);
  });

  it("leaves an inactive key with its deletion timer running alone, without a second lookup", async () => {
    const { directory: dir, lookups } = directory({ members: ["user-1"] });
    const { gateway, updates } = fakeGateway({
      pages: [
        {
          keys: [
            key({
              name: "gone@goodparty.org",
              is_active: false,
              expires_at: "2026-12-01T00:00:00Z",
              delete_after_expire: true,
            }),
          ],
          totalCount: 1,
        },
      ],
    });

    const result = await reconcileVirtualKeys({ directory: dir, gateway, now: NOW });

    // The timer is set once, on the transition. Re-PUTting it every hour would
    // push the 90-day window forward forever and nothing would be deleted.
    assert.deepEqual(result.skipped, [
      { name: "gone@goodparty.org", reason: "already-inactive" },
    ]);
    assert.deepEqual(updates, []);
    assert.deepEqual(lookups, []);
  });

  it("never reactivates a key, even when its owner is a member again", async () => {
    const { directory: dir } = directory({
      members: ["user-1"],
      userIds: { "back@goodparty.org": "user-1" },
    });
    const { gateway, updates } = fakeGateway({
      pages: [
        {
          keys: [key({ name: "back@goodparty.org", is_active: false })],
          totalCount: 1,
        },
      ],
    });

    const result = await reconcileVirtualKeys({ directory: dir, gateway, now: NOW });

    assert.deepEqual(result.kept, ["back@goodparty.org"]);
    assert.deepEqual(updates, []);
  });

  it("completes a partial transition once: inactive, no timer, departed owner", async () => {
    const { directory: dir } = directory({ members: ["user-1"], userIds: {} });
    const { gateway, updates } = fakeGateway({
      pages: [
        {
          keys: [key({ name: "gone@goodparty.org", is_active: false })],
          totalCount: 1,
        },
      ],
    });

    await reconcileVirtualKeys({ directory: dir, gateway, now: NOW });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].body.delete_after_expire, true);
  });

  it("lowercases the key name before resolving the owner", async () => {
    const { directory: dir, lookups } = directory({
      members: ["user-1"],
      userIds: { "jeff@goodparty.org": "user-1" },
    });
    const { gateway } = fakeGateway({
      pages: [{ keys: [key({ name: "Jeff@GoodParty.org" })], totalCount: 1 }],
    });

    const result = await reconcileVirtualKeys({ directory: dir, gateway, now: NOW });

    assert.deepEqual(lookups, ["jeff@goodparty.org"]);
    assert.deepEqual(result.kept, ["jeff@goodparty.org"]);
  });

  it("walks every page, so a managed key is not missed past the first", async () => {
    const { directory: dir } = directory({
      members: ["user-1"],
      userIds: { "gone@goodparty.org": "user-9" },
    });
    const { gateway, updates, listCalls } = fakeGateway({
      pages: [
        {
          keys: [key({ name: "a@goodparty.org", description: "dashboard key" })],
          totalCount: 2,
        },
        { keys: [key({ name: "gone@goodparty.org" })], totalCount: 2 },
      ],
    });

    const result = await reconcileVirtualKeys({ directory: dir, gateway, now: NOW });

    assert.equal(listCalls(), 2);
    assert.deepEqual(result.deactivated, [
      { name: "gone@goodparty.org", reason: "not-a-member" },
    ]);
    assert.equal(updates.length, 1);
  });

  it("fails the run rather than looping when the key list never ends", async () => {
    const { directory: dir } = directory({ members: ["user-1"] });
    const gateway: JanitorGateway = {
      list: async (query) => ({
        keys: [key({ name: `k${query.offset}@goodparty.org` })],
        totalCount: 1_000_000,
      }),
      update: async () => key({ name: "a" }),
    };

    await assert.rejects(
      reconcileVirtualKeys({ directory: dir, gateway, now: NOW }),
      (error: unknown) =>
        error instanceof JanitorFailure && error.code === "gateway-unavailable",
    );
    assert.equal(JANITOR_MAX_KEY_PAGES, 100);
  });

  it("does not put a key value in the result", async () => {
    const { directory: dir } = directory({ members: [] });
    const { gateway } = fakeGateway({ pages: [] });
    const result = await reconcileVirtualKeys({ directory: dir, gateway, now: NOW });
    assert.doesNotMatch(JSON.stringify(result), /sk-bf/);
  });
});

describe("failing closed (decision 6)", () => {
  it("aborts on an empty group with no list and no write", async () => {
    const { directory: dir, listCalls } = directory({ members: [] });
    const { gateway, updates, listCalls: keyListCalls } = fakeGateway();

    const result = await reconcileVirtualKeys({ directory: dir, gateway, now: NOW });

    assert.equal(result.outcome, "aborted");
    assert.equal(result.abortReason, "group-empty");
    assert.equal(listCalls(), 1);
    // Nothing else was read: "the group is empty" is indistinguishable from
    // "the read failed", and neither is a reason to deactivate everybody.
    assert.equal(keyListCalls(), 0);
    assert.deepEqual(updates, []);
  });

  it("fails the run when the group read errors, with no list and no write", async () => {
    const { directory: dir } = directory({ listError: new Error("AccessDenied") });
    const { gateway, updates, listCalls } = fakeGateway();

    await assert.rejects(
      reconcileVirtualKeys({ directory: dir, gateway, now: NOW }),
      (error: unknown) =>
        error instanceof JanitorFailure && error.code === "membership-unavailable",
    );
    assert.equal(listCalls(), 0);
    assert.deepEqual(updates, []);
  });

  it("fails the run when the gateway list errors, with no write", async () => {
    const { directory: dir } = directory({ members: ["user-1"] });
    const { gateway, updates } = fakeGateway({
      listError: new Error("Bifrost answered 500"),
    });

    await assert.rejects(
      reconcileVirtualKeys({ directory: dir, gateway, now: NOW }),
      (error: unknown) =>
        error instanceof JanitorFailure && error.code === "gateway-unavailable",
    );
    assert.deepEqual(updates, []);
  });

  it("does no write when an owner lookup fails partway through, even for keys before it", async () => {
    // The first key would be deactivated on its own; the second key's lookup is
    // the one that fails. Every read happens before the first write, so the
    // first key is still untouched — a half-reconciled run is what the ordering
    // prevents.
    const { directory: dir } = directory({
      members: ["user-1"],
      userIds: { "gone@goodparty.org": "user-9" },
      getUserIdError: new Error("Throttled"),
    });
    const { gateway, updates } = fakeGateway({
      pages: [
        {
          keys: [
            key({ name: "gone@goodparty.org" }),
            key({ name: "other@goodparty.org" }),
          ],
          totalCount: 2,
        },
      ],
    });

    await assert.rejects(
      reconcileVirtualKeys({ directory: dir, gateway, now: NOW }),
      (error: unknown) =>
        error instanceof JanitorFailure && error.code === "membership-unavailable",
    );
    assert.deepEqual(updates, []);
  });

  it("fails the run when a deactivation is refused, rather than carrying on", async () => {
    const { directory: dir } = directory({ members: ["user-1"], userIds: {} });
    const { gateway } = fakeGateway({
      pages: [{ keys: [key({ name: "gone@goodparty.org" })], totalCount: 1 }],
      updateError: new Error("Bifrost answered 500"),
    });

    await assert.rejects(
      reconcileVirtualKeys({ directory: dir, gateway, now: NOW }),
      (error: unknown) =>
        error instanceof JanitorFailure && error.code === "gateway-unavailable",
    );
  });
});

describe("a userName that is not an email (open item 6)", () => {
  it("is not email-shaped in the cases that matter", () => {
    assert.equal(isEmailShaped("jeff@goodparty.org"), true);
    assert.equal(isEmailShaped("jeff@sub.goodparty.org"), true);
    assert.equal(isEmailShaped("jeff@goodparty"), false);
    assert.equal(isEmailShaped("jeff"), false);
    assert.equal(isEmailShaped("jeff@@goodparty.org"), false);
    assert.equal(isEmailShaped("jeff@goodparty..org"), false);
    assert.equal(isEmailShaped(""), false);
  });

  it("skips a marker-bearing key whose name is not an address, and says which one", async () => {
    const { directory: dir, lookups } = directory({
      members: ["user-1"],
      userIds: { jdoe: "user-1" },
    });
    const { gateway, updates } = fakeGateway({
      pages: [{ keys: [key({ name: "jdoe" })], totalCount: 1 }],
    });

    const result = await reconcileVirtualKeys({ directory: dir, gateway, now: NOW });

    // Deactivating here would be a guess: the name is not the identity string
    // this design resolves (`GetUserId` is on `emails.value`), so "not found"
    // says nothing about membership and could revoke a working person's key.
    // The run names it instead, every hour, until a human fixes the identity or
    // the key.
    assert.deepEqual(result.skipped, [
      { name: "jdoe", reason: "owner-not-an-email" },
    ]);
    assert.deepEqual(result.deactivated, []);
    assert.deepEqual(lookups, []);
    assert.deepEqual(updates, []);
  });

  it("still deactivates an email-shaped name that resolves to no user, so the guard is not a hole", async () => {
    const { directory: dir } = directory({ members: ["user-1"], userIds: {} });
    const { gateway, updates } = fakeGateway({
      pages: [{ keys: [key({ name: "wrong.address@goodparty.org" })], totalCount: 1 }],
    });

    const result = await reconcileVirtualKeys({ directory: dir, gateway, now: NOW });

    assert.deepEqual(result.deactivated, [
      { name: "wrong.address@goodparty.org", reason: "owner-unresolved" },
    ]);
    assert.equal(updates.length, 1);
  });
});

/** A gateway whose one page holds only unmarked keys, including a test key. */
const mkGatewayWithUnmarked = () => {
  const updates: Array<{ id: string; body: Record<string, unknown> }> = [];
  const gateway: JanitorGateway = {
    list: async () => ({
      keys: [
        key({ name: "it-test-key", description: "my test key" }),
        key({ name: "dashboard@goodparty.org", description: null }),
        key({ name: "x@goodparty.org", description: "contains lambda-managed later" }),
      ],
      totalCount: 3,
    }),
    update: async (id, body) => {
      updates.push({ id, body });
      return key({ name: "updated", id });
    },
  };
  return { gateway, updates };
};
