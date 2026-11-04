import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { MembershipDirectory, VirtualKey } from "./vk-mint-core";
import { VK_DESCRIPTION } from "./vk-marker";
import {
  JanitorFailure,
  type JanitorGateway,
} from "./vk-janitor-core";
import { createJanitorHandler, type JanitorDeps } from "./vk-janitor-handler";

/**
 * The handler's wiring: the summary and per-key lines a run emits, the
 * fail-closed statuses, and the one property decision 3 is emphatic about —
 * no key value and no setup token in a log line.
 */

const NOW = new Date("2026-10-29T12:00:00.000Z");
const SETUP_TOKEN = "setup-token-value-that-must-not-be-logged";
const KEY_VALUE = "sk-bf-the-key-that-must-not-be-logged";

const key = (overrides: Partial<VirtualKey> & { name: string }): VirtualKey => ({
  id: `id-${overrides.name}`,
  value: KEY_VALUE,
  is_active: true,
  expires_at: null,
  delete_after_expire: null,
  description: VK_DESCRIPTION,
  // The governance shape the harness's template converges to, so a test that is
  // about revocation is not also exercising the convergence loop's diff. Every
  // key below is already at its desired state unless it says otherwise.
  calendar_aligned: true,
  provider_configs: [
    {
      provider: "bedrock",
      allowed_models: ["us.anthropic.claude-sonnet-5-5"],
      allow_all_keys: true,
      keys: [],
    },
  ],
  ...overrides,
});

const harness = (options: {
  keys?: VirtualKey[];
  members?: readonly string[];
  userIds?: Record<string, string | null>;
  directoryError?: Error;
  tokenError?: Error;
  governanceError?: Error;
  template?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}) => {
  const logs: Record<string, unknown>[] = [];
  const updates: Array<{ id: string; body: Record<string, unknown> }> = [];

  const directory: MembershipDirectory = {
    getUserId: async (email) => options.userIds?.[email] ?? null,
    listMemberUserIds: async () => options.members ?? ["user-1"],
  };
  const gateway: JanitorGateway = {
    list: async () => ({ keys: options.keys ?? [], totalCount: options.keys?.length ?? 0 }),
    update: async (id, body) => {
      updates.push({ id, body });
      return key({ name: "updated", id });
    },
  };

  const deps: JanitorDeps = {
    readSetupToken: async () => {
      if (options.tokenError) throw options.tokenError;
      return SETUP_TOKEN;
    },
    readGovernance: async () => {
      if (options.governanceError) throw options.governanceError;
      return {
        // The shape every key is already at, so a test that is not about
        // convergence gets an empty diff and an empty write log.
        template: (options.template ?? {
          provider_configs: [
            { provider: "bedrock", allowed_models: ["us.anthropic.claude-sonnet-5-5"], key_ids: ["*"] },
          ],
          calendar_aligned: true,
        }) as never,
        overrides: (options.overrides ?? {}) as never,
      };
    },
    createDirectory: async () => {
      if (options.directoryError) throw options.directoryError;
      return directory;
    },
    createGateway: () => gateway,
    log: (entry) => logs.push(entry),
    now: () => NOW,
  };

  return {
    handler: createJanitorHandler(deps),
    logs,
    updates,
  };
};

describe("the janitor handler", () => {
  /**
   * The convergence summary one run emits. Every revocation test below sees it,
   * because the same invocation now does both jobs; a test that is about
   * revocation names it here rather than repeating it. `changed: 0` is the
   * assertion those tests are really making about the second job: the fake
   * gateway's keys are already converged.
   */
  const reconcilerSummary = (managedKeys: number, unchanged: number) => ({
    event: "vk-reconciler",
    outcome: "converged",
    members: 1,
    managedKeys,
    changed: 0,
    unchanged,
    skipped: 0,
    minted: 0,
  });

  it("logs a summary and one deactivation line, and nothing secret", async () => {
    const { handler, logs, updates } = harness({
      keys: [key({ name: "gone@goodparty.org" })],
      members: ["user-1"],
      userIds: { "gone@goodparty.org": "user-9" },
    });

    const result = await handler({ action: "reconcile" });

    assert.equal(result.revocation.deactivated.length, 1);
    assert.equal(updates.length, 1);
    assert.deepEqual(logs, [
      {
        event: "vk-janitor",
        outcome: "ok",
        members: 1,
        managedKeys: 1,
        kept: 0,
        deactivated: 1,
        skipped: 0,
      },
      {
        event: "vk-janitor",
        outcome: "deactivated",
        name: "gone@goodparty.org",
        reason: "not-a-member",
      },
      // Not a member, so convergence skips it too: a deactivated key is not
      // converged to a shape its departing owner would keep.
      {
        event: "vk-reconciler",
        outcome: "converged",
        members: 1,
        managedKeys: 1,
        changed: 0,
        unchanged: 0,
        skipped: 1,
        minted: 0,
      },
      {
        event: "vk-reconciler",
        outcome: "skipped",
        name: "gone@goodparty.org",
        reason: "not-a-member",
      },
    ]);
    // Decision 3's rule, applied to this job too: a key appears in a response
    // body and must not appear in a log line. The setup token is worse.
    const logged = JSON.stringify(logs);
    assert.ok(!logged.includes(KEY_VALUE));
    assert.ok(!logged.includes(SETUP_TOKEN));
  });

  it("leaves a member's key alone and says how many it kept", async () => {
    const { handler, logs, updates } = harness({
      keys: [key({ name: "jeff@goodparty.org" })],
      members: ["user-1"],
      userIds: { "jeff@goodparty.org": "user-1" },
    });

    await handler({ action: "reconcile" });

    assert.deepEqual(updates, []);
    assert.deepEqual(logs, [
      {
        event: "vk-janitor",
        outcome: "ok",
        members: 1,
        managedKeys: 1,
        kept: 1,
        deactivated: 0,
        skipped: 0,
      },
      reconcilerSummary(1, 1),
    ]);
  });

  it("logs and skips a key whose name is not an email, without failing the run", async () => {
    const { handler, logs, updates } = harness({
      keys: [key({ name: "jdoe" })],
      members: ["user-1"],
      userIds: { jdoe: "user-1" },
    });

    await handler({ action: "reconcile" });

    assert.deepEqual(updates, []);
    // Both halves name it: the shape mismatch is a human's to fix, so neither
    // job leaves it to a count.
    const skipped = logs.filter((entry) => entry.outcome === "skipped");
    assert.deepEqual(skipped, [
      { event: "vk-janitor", outcome: "skipped", name: "jdoe", reason: "owner-not-an-email" },
      {
        event: "vk-reconciler",
        outcome: "skipped",
        name: "jdoe",
        reason: "owner-not-an-email",
      },
    ]);
  });

  it("uses the injected clock for the retention deadline", async () => {
    const { handler, updates } = harness({
      keys: [key({ name: "gone@goodparty.org" })],
      members: ["user-1"],
      userIds: {},
    });

    await handler({ action: "reconcile" });

    assert.equal(updates[0].body.expires_at, "2027-01-27T12:00:00Z");
  });

  it("logs an abort for an empty group and does not throw", async () => {
    const { handler, logs, updates } = harness({
      keys: [key({ name: "jeff@goodparty.org" })],
      members: [],
    });

    const result = await handler({ action: "reconcile" });

    assert.equal(result.revocation.outcome, "aborted");
    assert.deepEqual(updates, []);
    assert.deepEqual(logs, [
      { event: "vk-janitor", outcome: "aborted", reason: "group-empty", members: 0 },
    ]);
  });

  it("fails the invocation, with a reason, when the reader role cannot be assumed", async () => {
    const { handler, logs } = harness({
      directoryError: new Error("AccessDenied"),
    });

    await assert.rejects(
      handler({ action: "reconcile" }),
      (error: unknown) =>
        error instanceof JanitorFailure && error.code === "membership-unavailable",
    );
    assert.deepEqual(logs, [
      {
        event: "vk-janitor",
        outcome: "failed",
        reason: "membership-unavailable",
      },
    ]);
  });

  it("fails the invocation when the setup token cannot be read", async () => {
    const { handler, logs } = harness({ tokenError: new Error("no secret") });

    await assert.rejects(
      handler({ action: "reconcile" }),
      (error: unknown) =>
        error instanceof JanitorFailure && error.code === "gateway-unavailable",
    );
    assert.deepEqual(logs, [
      { event: "vk-janitor", outcome: "failed", reason: "gateway-unavailable" },
    ]);
  });

  it("fails the invocation, before any write, when a governance document cannot be read", async () => {
    const { handler, logs, updates } = harness({
      keys: [key({ name: "gone@goodparty.org" })],
      members: ["user-1"],
      userIds: {},
      governanceError: new Error("AccessDenied on /bifrost/governance-overrides"),
    });

    await assert.rejects(
      handler({ action: "reconcile" }),
      (error: unknown) =>
        error instanceof JanitorFailure &&
        error.code === "desired-state-unavailable",
    );
    // A run with no desired state converges nothing and deactivates nothing: the
    // read is before the writes, so a parameter the deploy has not written yet
    // is a red invocation rather than a guess at what the fleet should look
    // like. Step 6's alarm counts the failure either way.
    assert.deepEqual(updates, []);
    assert.deepEqual(logs, [
      {
        event: "vk-janitor",
        outcome: "failed",
        reason: "desired-state-unavailable",
      },
    ]);
    // The parameter's value is never in a log line, and neither is the error's
    // message: the reason is a code.
    assert.doesNotMatch(JSON.stringify(logs), /AccessDenied/);
  });

  it("converges a key whose governance differs, and logs the fields that did", async () => {
    const { handler, logs, updates } = harness({
      // Already at the harness template, so the only difference the overrides
      // introduce is the budget.
      keys: [key({ name: "jeff@goodparty.org" })],
      members: ["user-1"],
      userIds: { "jeff@goodparty.org": "user-1" },
      overrides: {
        "jeff@goodparty.org": { budgets: [{ max_limit: 250, reset_duration: "1M" }] },
      },
    });

    const result = await handler({ action: "reconcile" });

    assert.equal(result.governance.outcome, "converged");
    assert.equal(result.governance.changed, 1);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].body.budgets, [
      { max_limit: 250, reset_duration: "1M" },
    ]);
    assert.deepEqual(logs.at(-1), {
      event: "vk-reconciler",
      outcome: "converged",
      name: "jeff@goodparty.org",
      fields: ["budgets"],
    });
    // Still no key value anywhere in the log.
    assert.ok(!JSON.stringify(logs).includes(KEY_VALUE));
  });
});
