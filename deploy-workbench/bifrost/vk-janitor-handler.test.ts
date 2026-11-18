import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { MembershipDirectory, VirtualKey } from "./vk-mint-core";
import { VK_DESCRIPTION } from "./vk-marker";
import {
  JanitorFailure,
  type JanitorGateway,
} from "./vk-janitor-core";
import type { ConfigGateway } from "./config-convergence-core";
import { createJanitorHandler, type JanitorDeps } from "./vk-janitor-handler";
import {
  decideInvokeAttempt,
  parseReconcilerSummary,
  type ReconcilerSummary,
} from "./reconciler-summary";

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
  configError?: Error;
  template?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  /** The committed file's text. Defaults to one the fake gateway already matches. */
  configText?: string;
  /** The gateway's own `GET /api/config` view. */
  observedConfig?: Record<string, unknown>;
  /** Replaces the whole config gateway, for a test about its writes. */
  configGateway?: (base: ConfigGateway) => ConfigGateway;
}) => {
  const logs: Record<string, unknown>[] = [];
  const updates: Array<{ id: string; body: Record<string, unknown> }> = [];
  const configPuts: Array<Record<string, unknown>> = [];

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

  // The gateway's config view and the committed file agree, so a test that is
  // not about config convergence gets an empty diff and no write. `client`
  // carries one field the file also carries; `governance` is in the file and
  // deliberately not converged (`env-reference`), which is what the default
  // summary's `skipped: 2` counts.
  const observedConfig = options.observedConfig ?? {
    client_config: { enable_logging: true },
    framework_config: {},
  };
  const configText =
    options.configText ??
    JSON.stringify({ client: { enable_logging: true }, governance: { auth_config: {} } });

  const baseConfigGateway: ConfigGateway = {
    getConfig: async () => observedConfig,
    putConfig: async (body) => {
      configPuts.push(body);
    },
    getProvider: async () => null,
    putProvider: async () => {},
    listProviderKeys: async () => [],
    putProviderKey: async () => {},
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
    readConfig: async () => {
      if (options.configError) throw options.configError;
      return configText;
    },
    createDirectory: async () => {
      if (options.directoryError) throw options.directoryError;
      return directory;
    },
    createGateway: () => gateway,
    createConfigGateway: () =>
      options.configGateway
        ? options.configGateway(baseConfigGateway)
        : baseConfigGateway,
    log: (entry) => logs.push(entry),
    now: () => NOW,
  };

  return {
    handler: createJanitorHandler(deps),
    logs,
    updates,
    configPuts,
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
  /**
   * The run's own summary, emitted last on every successful invocation. Its
   * shape is the contract the deploy's poll reads (`reconciler-summary.ts`), and
   * every test below sees it, so it is written here once.
   *
   * `config.unchanged: 1` and `config.skipped: 2` are the harness's default file:
   * one client field that already matches, plus the two sections config
   * convergence names and refuses ($schema, governance).
   */
  const runSummary = (overrides: {
    revocation?: Record<string, unknown>;
    governance?: Record<string, unknown>;
    config?: Record<string, unknown>;
    outcome?: string;
    trigger?: string;
  } = {}) => ({
    event: "reconciler-run",
    outcome: overrides.outcome ?? "converged",
    trigger: overrides.trigger ?? "unknown",
    revocation:
      overrides.revocation ??
      { outcome: "ok", kept: 0, deactivated: 1, skipped: 0 },
    governance:
      overrides.governance ??
      { outcome: "converged", changed: 0, unchanged: 0, skipped: 1 },
    // The default is the scheduled tick's answer: decision 16 makes the deploy
    // the trigger that owns config convergence, so a tick reports `not-run`
    // rather than doing it. Every test that expects a config write passes
    // `trigger: "deploy"`.
    config:
      overrides.config ??
      { outcome: "not-run", changed: 0, unchanged: 0, skipped: 0 },
  });

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
      runSummary(),
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
      runSummary({
        revocation: { outcome: "ok", kept: 1, deactivated: 0, skipped: 0 },
        governance: { outcome: "converged", changed: 0, unchanged: 1, skipped: 0 },
      }),
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
      // The config half still ran: it reads no group, and an unrelated directory
      // read must not decide whether a config change landed.
      runSummary({
        outcome: "not-converged",
        revocation: { outcome: "aborted", kept: 0, deactivated: 0, skipped: 0 },
        governance: { outcome: "aborted", changed: 0, unchanged: 0, skipped: 0 },
      }),
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
        trigger: "unknown",
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
      {
        event: "vk-janitor",
        outcome: "failed",
        reason: "gateway-unavailable",
        trigger: "unknown",
      },
    ]);
  });

  it("keeps the revocation audit when the convergence half fails afterwards", async () => {
    // The key is deactivated before the convergence half's read fails. The name
    // and reason must still reach the log: on the next tick that key carries its
    // deletion timer, is counted as `already-inactive`, and never appears again,
    // so losing this line loses the only record of who was revoked and why.
    const { handler, logs } = harness({
      keys: [key({ name: "gone@goodparty.org" })],
      members: ["user-1"],
      userIds: {},
      // The revocation loop reads the group and the keys; this fails later, in
      // the convergence half's desired-state read.
      overrides: { "gone@goodparty.org": { budgets: [{ max_limit: 1, reset_duration: "1M" }] } },
      governanceError: new Error("AccessDenied on /bifrost/governance-overrides"),
    });

    await assert.rejects(
      handler({ action: "reconcile" }),
      (error: unknown) =>
        error instanceof JanitorFailure &&
        error.code === "desired-state-unavailable",
    );

    // The audit lines come first, then the failure. The order is the assertion:
    // revocation logged what it did before the run went red.
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
        reason: "owner-unresolved",
      },
      {
        event: "vk-janitor",
        outcome: "failed",
        reason: "desired-state-unavailable",
        trigger: "unknown",
      },
    ]);
  });

  it("fails the invocation when a governance document cannot be read, after revocation has run", async () => {
    const { handler, logs } = harness({
      // No managed key, so revocation writes nothing and the only write the run
      // could make is a convergence one — which it never reaches.
      keys: [],
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
    // Revocation ran and said so; convergence then failed the run. A parameter
    // the deploy has not written yet is a red invocation rather than a guess at
    // the fleet's shape, and step 6's alarm counts it.
    assert.deepEqual(logs, [
      {
        event: "vk-janitor",
        outcome: "ok",
        members: 1,
        managedKeys: 0,
        kept: 0,
        deactivated: 0,
        skipped: 0,
      },
      {
        event: "vk-janitor",
        outcome: "failed",
        reason: "desired-state-unavailable",
        trigger: "unknown",
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
    assert.deepEqual(logs.at(-2), {
      event: "vk-reconciler",
      outcome: "converged",
      name: "jeff@goodparty.org",
      fields: ["budgets"],
    });
    assert.deepEqual(logs.at(-1), runSummary({
      revocation: { outcome: "ok", kept: 1, deactivated: 0, skipped: 0 },
      governance: { outcome: "converged", changed: 1, unchanged: 0, skipped: 0 },
    }));
    // Still no key value anywhere in the log.
    assert.ok(!JSON.stringify(logs).includes(KEY_VALUE));
  });

  /**
   * Step 4's half, through the handler rather than the core: the parameter's
   * text reaches the loop, a change to it is one `PUT`, and a refused write
   * fails the invocation so the deploy's poll cannot read it as converged.
   */
  it("converges the gateway's live config from the parameter, in one write", async () => {
    const { handler, logs, configPuts } = harness({
      keys: [],
      members: ["user-1"],
      configText: JSON.stringify({ client: { enable_logging: true } }),
      observedConfig: { client_config: { enable_logging: false } },
    });

    const result = await handler({ action: "reconcile", trigger: "deploy" });

    assert.equal(result.config.outcome, "converged");
    assert.equal(result.config.changed, 1);
    assert.deepEqual(configPuts, [
      { client_config: { enable_logging: true } },
    ]);
    // The per-section line comes before the run's summary, and it names the
    // field rather than its value.
    assert.deepEqual(logs.at(-2), {
      event: "bifrost-config-reconciler",
      outcome: "converged",
      section: "client",
      fields: ["enable_logging"],
    });
    assert.deepEqual(logs.at(-1), runSummary({
      trigger: "deploy",
      revocation: { outcome: "ok", kept: 0, deactivated: 0, skipped: 0 },
      governance: { outcome: "converged", changed: 0, unchanged: 0, skipped: 0 },
      config: { outcome: "converged", changed: 1, unchanged: 0, skipped: 2 },
    }));
    assert.equal(result.summary.outcome, "converged");
    assert.equal(result.summary.trigger, "deploy");
  });

  it("does not converge config on a scheduled tick, and says so", async () => {
    // Decision 16 bounds config convergence at a deploy. A tick that converged
    // it anyway would be a different promise than the plan makes, and it would
    // erase a dashboard edit within five minutes with no deploy behind it.
    let configGatewayBuilt = 0;
    const { handler, configPuts } = harness({
      keys: [],
      members: ["user-1"],
      configText: JSON.stringify({ client: { enable_logging: true } }),
      observedConfig: { client_config: { enable_logging: false } },
      configGateway: (base) => {
        configGatewayBuilt++;
        return base;
      },
    });

    const result = await handler({ action: "reconcile", trigger: "schedule" });

    assert.equal(result.config.outcome, "not-run");
    assert.equal(result.config.reason, "not-this-trigger");
    assert.deepEqual(configPuts, []);
    assert.equal(
      configGatewayBuilt,
      0,
      "the parameter is not even read, let alone written",
    );
    // A scheduled tick with nothing else to do is still `converged`: the config
    // half is not its job, which is exactly why the summary records `not-run`
    // rather than failing the tick.
    assert.equal(result.summary.outcome, "converged");
    assert.equal(result.summary.config.outcome, "not-run");
  });

  it("fails the invocation when the gateway refuses a config write", async () => {
    const { handler, logs } = harness({
      keys: [],
      members: ["user-1"],
      configText: JSON.stringify({ client: { enable_logging: true } }),
      observedConfig: { client_config: { enable_logging: false } },
      configGateway: (base) => ({
        ...base,
        putConfig: async () => {
          throw new Error("PUT /api/config refused");
        },
      }),
    });

    await assert.rejects(
      handler({ action: "reconcile", trigger: "deploy" }),
      (error: unknown) =>
        error instanceof JanitorFailure && error.code === "convergence-failed",
    );
    // No summary was returned, which is what the platform reports as a
    // FunctionError; the failure line is the record that it was this loop.
    assert.deepEqual(logs.at(-1), {
      event: "vk-janitor",
      outcome: "failed",
      reason: "convergence-failed",
      trigger: "deploy",
    });
  });

  it("fails the invocation when /bifrost/config cannot be read", async () => {
    const { handler, logs } = harness({
      keys: [],
      members: ["user-1"],
      configError: new Error("AccessDenied on /bifrost/config"),
    });

    await assert.rejects(
      handler({ action: "reconcile", trigger: "deploy" }),
      (error: unknown) =>
        error instanceof JanitorFailure &&
        error.code === "desired-state-unavailable",
    );
    assert.deepEqual(logs.at(-1), {
      event: "vk-janitor",
      outcome: "failed",
      reason: "desired-state-unavailable",
      trigger: "deploy",
    });
    assert.doesNotMatch(JSON.stringify(logs), /AccessDenied/);
  });
});

/**
 * The contract the deploy's poll actually depends on: the handler's **real
 * return value**, JSON-serialised the way `aws lambda invoke` writes it to the
 * outfile, read back by `parseReconcilerSummary`.
 *
 * This test exists because the defect it covers could not be seen from either
 * side alone. `reconciler-summary.test.ts` fed the parser a bare
 * `ReconcilerSummary`, and the tests above assert on `result.summary`; both were
 * green while the two never met, because the handler returns a `JanitorRun` and
 * the parser read only the top level. Every deploy's converge step failed with
 * "the run returned no summary", including a fully converged one.
 *
 * So it drives the real handler and passes its real reply through the
 * serialisation boundary, not a hand-written fixture.
 */
describe("the reply the deploy's poll reads", () => {
  it("parses the handler's own return value, serialised, as converged", async () => {
    const { handler } = harness({ keys: [], members: ["user-1"] });

    const run = await handler({ action: "reconcile", trigger: "deploy" });
    const decision = decideInvokeAttempt({
      kind: "ok",
      payload: JSON.stringify(run),
    });

    assert.equal(
      decision.kind,
      "converged",
      `a converged run must not read as "no summary": ${JSON.stringify(decision)}`,
    );
    assert.equal(parseReconcilerSummary(JSON.stringify(run))?.trigger, "deploy");
  });

  it("reads a scheduled tick's reply too, which is the same shape", async () => {
    // The tick returns the same `JanitorRun`, so the shape is one contract
    // rather than a deploy-only one. Its config half is `not-run`, and a tick is
    // allowed to say that where a deploy is not.
    const { handler } = harness({ keys: [], members: ["user-1"] });

    const run = await handler({ action: "reconcile", trigger: "schedule" });
    const summary = parseReconcilerSummary(JSON.stringify(run));

    assert.equal(summary?.outcome, "converged");
    assert.equal(summary?.trigger, "schedule");
    assert.equal(summary?.config.outcome, "not-run");
  });

  it("reads the wrapper's counts, so the failure line names the loop", async () => {
    // `not-converged` from a deploy whose config half never ran: the parse has to
    // survive to the counts, because `formatFailure` and the failure line print
    // them. A parse that returned the wrapper's outline without its loops would
    // get a summary the poll then dereferenced.
    const { handler } = harness({ keys: [], members: [] });

    const run = await handler({ action: "reconcile", trigger: "deploy" });
    const decision = decideInvokeAttempt({
      kind: "ok",
      payload: JSON.stringify(run),
    });

    assert.equal(decision.kind, "not-converged");
    assert.equal(
      (decision as { summary?: ReconcilerSummary }).summary?.governance.outcome,
      "aborted",
      "the poll's failure message reads governance.outcome off the parsed summary",
    );
  });
});
