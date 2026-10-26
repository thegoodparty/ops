import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  ConflictException,
  CreateGroupMembershipCommand,
  CreateUserCommand,
  DeleteGroupMembershipCommand,
  GetUserIdCommand,
  ListGroupMembershipsCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-identitystore";

import {
  POLL_INTERVAL_SECONDS,
  RESERVED_TARGET_GROUP_IDS,
  SYNC_CONFIG,
  SYNC_PAIRS,
  type SyncPair,
  type SyncConfig,
} from "./group-sync/config";
import { SyncAbortError } from "./group-sync/errors";
import {
  deriveDisplayName,
  createIdentityDirectory,
  withRetry,
  type IdentityDirectory,
  type IdentityStoreClientLike,
} from "./group-sync/identity";
import { emailRef, memoryLogger } from "./group-sync/log";
import { METRIC_NAMES, memoryMetrics, type Metrics } from "./group-sync/metrics";
import {
  parseSyncConfig,
  runPair,
  runSync,
  validatePair,
  type PairOutcome,
} from "./group-sync/run";
import {
  buildAssertion,
  createDirectoryClient,
  parseServiceAccountKey,
  type FetchLike,
} from "./group-sync/google";
import {
  fetchSourceMembers,
  type DirectoryClient,
  type DirectoryMember,
  type DirectoryMemberPage,
} from "./group-sync/source";
import { handle, parseOverride } from "./group-sync/handler";
import {
  GROUP_SYNC_ROLE_NAME,
  GROUP_SYNC_PARAMETER_NAME,
  GROUP_SYNC_SECRET_NAME,
  GROUP_SYNC_SCHEDULE_EXPRESSION,
  GROUP_SYNC_TIMEOUT_SECONDS,
  groupSyncLambdaPolicy,
  groupSyncLambdaTrust,
  buildGroupSyncCode,
} from "./group-sync-lambda";
import { GRANT_SESSION_NAME } from "../deploy/components/identity-group-sync-grant";

// ---------------------------------------------------------------------------
// The configured pair, pinned.
//
// Step 3 resolved open question 7: `engineering@goodparty.org` mirrors the
// `Engineers` Identity Center group. The id, mode, cap and allowlist are policy
// and are asserted here so a change to any of them is a change to this test.
// ---------------------------------------------------------------------------

const ENGINEERS_GROUP_ID = "383193a0-7001-70d9-a321-ffe6d8af7378";
const ADMINS_GROUP_ID = "88c1b330-a001-707a-06ca-94e289013bf5";

// The `Approvers` group, the `approvers-google` pair's target. A literal in
// `deploy-infrastructure/group-sync/config.ts` and in the management-account
// grant, both pinned here so the three cannot drift.
const APPROVERS_GROUP_ID = "e841e310-0051-7062-2ea4-9905d12f345e";

const pairById = (id: string) => {
  const found = SYNC_PAIRS.find((pair) => pair.id === id);
  assert.ok(found, `no configured pair ${id}`);
  return found;
};

const identityCenterSource = (): string =>
  fs.readFileSync(
    path.resolve(__dirname, "../deploy/components/identity-center.ts"),
    "utf8",
  );

describe("the configured sync pair", () => {
  it("applies the engineering@ Workspace group into Engineers after its reviewed dry run", () => {
    // Rollout step 4: the pair shipped `dry-run`, the dry run against the real
    // group was reviewed, and this is the reviewed change that flips it to
    // `apply`. It is asserted here rather than assumed, so a pair that quietly
    // starts writing -- or stops -- is a failing test.
    assert.equal(SYNC_PAIRS.length, 2);
    const pair = pairById("engineers-google");
    assert.deepEqual(pair, {
      id: "engineers-google",
      sourceGroupEmail: "engineering@goodparty.org",
      targetGroupId: ENGINEERS_GROUP_ID,
      mode: "apply",
      removalCap: { maxCount: 5, maxFraction: 0.1 },
      allowlist: ["@goodparty.org"],
      removalAlertThreshold: 0,
    });
  });

  it("adds the eng-admin@ Workspace group into Approvers, starting in dry-run", () => {
    // The second pair is a parallel copy of the first: same id shape, same cap,
    // same allowlist. It starts in `dry-run` because that is "Adding a pair"
    // step 4, and it is pinned here so flipping it to `apply` -- or changing
    // its source, target or allowlist -- is a reviewed change to this test.
    assert.deepEqual(pairById("approvers-google"), {
      id: "approvers-google",
      sourceGroupEmail: "eng-admin@goodparty.org",
      targetGroupId: APPROVERS_GROUP_ID,
      mode: "dry-run",
      removalCap: { maxCount: 5, maxFraction: 0.1 },
      allowlist: ["@goodparty.org"],
      removalAlertThreshold: 0,
    });
  });

  it("names a target that exists in identity-center.ts", () => {
    // The group is created out of band, so the id is a literal in two files.
    // Read the source so the two cannot drift, the way sheriff-grant.test.ts
    // pins Admins.
    const source = identityCenterSource();
    assert.match(
      source,
      new RegExp(`Engineers: "${pairById("engineers-google").targetGroupId}"`),
    );
  });

  it("names a target the management-account grant is authorized for", () => {
    // "Adding a pair" is two changes: the config and the grant. A pair whose
    // group ARN is missing from the grant fails closed at its first
    // CreateGroupMembership with an AccessDenied, which is safe but noisy.
    const grant = fs.readFileSync(
      path.resolve(
        __dirname,
        "../deploy/components/identity-group-sync-grant.ts",
      ),
      "utf8",
    );
    for (const pair of SYNC_PAIRS) {
      assert.ok(
        grant.includes(`arn:aws:identitystore:::group/${pair.targetGroupId}`),
        `grant has no ARN for ${pair.id}`,
      );
    }
  });

  it("reserves the Admins group and never configures it as a target", () => {
    assert.match(identityCenterSource(), new RegExp(`Admins: "${ADMINS_GROUP_ID}"`));
    assert.ok(RESERVED_TARGET_GROUP_IDS.includes(ADMINS_GROUP_ID));
    assert.ok(
      SYNC_PAIRS.every((pair) => pair.targetGroupId !== ADMINS_GROUP_ID),
    );
  });

  it("writes a config the handler's parser accepts", () => {
    // Pulumi writes `JSON.stringify(SYNC_CONFIG)` to SSM; the Lambda parses the
    // same string. If the two ever disagree, every run aborts on `invalid-config`
    // and the heartbeat alarm is the only warning.
    const parsed = parseSyncConfig(JSON.stringify(SYNC_CONFIG));
    assert.equal(parsed.pollIntervalSeconds, POLL_INTERVAL_SECONDS);
    assert.deepEqual(parsed.pairs, [...SYNC_PAIRS]);
    for (const pair of parsed.pairs) {
      assert.deepEqual(validatePair(pair), []);
    }
  });

  it("keeps the interval a multiple of 60 with the timeout below it", () => {
    // The alarm periods are this interval; the function must not outlive it.
    assert.equal(POLL_INTERVAL_SECONDS % 60, 0);
    assert.ok(GROUP_SYNC_TIMEOUT_SECONDS < POLL_INTERVAL_SECONDS);
    assert.equal(
      GROUP_SYNC_SCHEDULE_EXPRESSION,
      `rate(${POLL_INTERVAL_SECONDS / 60} minutes)`,
    );
  });
});

// ---------------------------------------------------------------------------
// The Lambda's identity and grant, pinned against the management-account role
// it assumes. The two names are a seam: a drift is an AccessDenied at the first
// run, not an apply-time error.
// ---------------------------------------------------------------------------

describe("the Lambda's execution role", () => {
  it("is named exactly as the grant's trust expects, with the grant's session name", () => {
    assert.equal(GROUP_SYNC_ROLE_NAME, "identity-group-sync");
    assert.equal(GRANT_SESSION_NAME, "identity-group-sync");
    assert.match(
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../deploy/components/identity-group-sync-grant.ts",
        ),
        "utf8",
      ),
      /INFRASTRUCTURE_ACCOUNT_ID\}:role\/identity-group-sync`/,
    );
  });

  it("trusts only lambda.amazonaws.com", () => {
    assert.deepEqual(groupSyncLambdaTrust.Statement, [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ]);
  });

  it("assumes the one grant role, reads its own secret and config, writes its own metrics and logs", () => {
    const statements = [...groupSyncLambdaPolicy.Statement];
    const bySid = Object.fromEntries(statements.map((s) => [s.Sid, s]));

    assert.deepEqual(Object.keys(bySid).sort(), [
      "AssumeSyncGrant",
      "OwnLogs",
      "PutSyncMetrics",
      "ReadConfig",
      "ReadGoogleSecret",
    ]);
    assert.equal(
      bySid.AssumeSyncGrant.Resource,
      "arn:aws:iam::333022194791:role/identity-group-sync-grant",
    );
    assert.equal(
      bySid.ReadGoogleSecret.Resource,
      `arn:aws:secretsmanager:us-west-2:394495727159:secret:${GROUP_SYNC_SECRET_NAME}-*`,
    );
    assert.equal(
      bySid.ReadConfig.Resource,
      `arn:aws:ssm:us-west-2:394495727159:parameter${GROUP_SYNC_PARAMETER_NAME}`,
    );
    assert.equal(GROUP_SYNC_PARAMETER_NAME, "/identity-group-sync/pairs");
    assert.equal(
      GROUP_SYNC_SECRET_NAME,
      "identity-group-sync/google-service-account",
    );
    assert.equal(bySid.PutSyncMetrics.Resource, "*");
    assert.deepEqual(bySid.PutSyncMetrics.Condition, {
      StringEquals: { "cloudwatch:namespace": "IdentityGroupSync" },
    });
    assert.deepEqual([...bySid.OwnLogs.Action], [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]);
  });

  it("holds no directory, secret-write, KMS or SSM-write permission of its own", () => {
    // Every identitystore call goes through the assumed role; the secret's
    // value is set by hand; the default KMS keys admit the account.
    const actions = groupSyncLambdaPolicy.Statement.flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action],
    );
    for (const action of actions) {
      assert.doesNotMatch(action, /^identitystore:/, action);
      assert.doesNotMatch(action, /^(sso|sso-directory|sso-oauth):/, action);
      assert.doesNotMatch(action, /^kms:/, action);
      assert.doesNotMatch(action, /^ssm:(Put|Delete|GetParameters)/, action);
      assert.doesNotMatch(action, /^secretsmanager:(Put|Create|Update|Delete)/, action);
    }
  });

  it("bundles the handler as the function's only asset", async () => {
    // A broken entry point would otherwise only fail at deploy.
    const archive = buildGroupSyncCode();
    assert.deepEqual(Object.keys(await archive.assets), ["handler.js"]);
  });

  it("takes the impersonation admin from the stack config deploy.sh sets", () => {
    // `googleImpersonationEmail` is deployment state (manual Google setup step
    // 4 in docs/google-group-sync.md), and unset means every pair aborts with
    // `source-read-failed`. Pulumi.*.yaml is gitignored, so the value is
    // declared in deploy.sh the way `providerRoleName` is, and read here into
    // the environment the handler keys on. Pin both ends so a drift is a
    // failing test rather than a red heartbeat after a deploy.
    const lambda = fs.readFileSync(
      path.resolve(__dirname, "group-sync-lambda.ts"),
      "utf8",
    );
    assert.match(lambda, /get\("googleImpersonationEmail"\)/);
    assert.match(lambda, /GOOGLE_IMPERSONATION_EMAIL:/);

    const deploy = fs.readFileSync(
      path.resolve(__dirname, "deploy.sh"),
      "utf8",
    );
    assert.match(
      deploy,
      /pulumi config set googleImpersonationEmail svc-identity-group-sync@goodparty\.org/,
    );
  });
});

// ---------------------------------------------------------------------------
// Fakes. Nothing below reaches Google or AWS.
// ---------------------------------------------------------------------------

const member = (email: string | null, type: string | null): DirectoryMember => ({
  email,
  type,
});

const fakeDirectory = (options: {
  pages: Array<DirectoryMemberPage | Error>;
  groupError?: Error;
  calls?: string[];
}): DirectoryClient => {
  const calls = options.calls ?? [];
  let pageIndex = 0;
  return {
    async getGroup(request) {
      calls.push(`getGroup:${request.groupKey}`);
      if (options.groupError) throw options.groupError;
      return { id: "google-group", email: request.groupKey };
    },
    async listMembers(request) {
      calls.push(`listMembers:${request.groupKey}:${request.pageToken ?? ""}`);
      const page = options.pages[pageIndex++] ?? { members: [] };
      if (page instanceof Error) throw page;
      return page;
    },
  };
};

const fakeIdentity = (options: {
  users?: Record<string, string>;
  memberships?: Array<{ userId: string; membershipId: string }>;
  calls: string[];
  /** Override the write behaviour per member, for failure cases. */
  onCreateUser?: (email: string) => Promise<string>;
  onAddMembership?: (userId: string) => Promise<void>;
  onRemoveMembership?: (membershipId: string) => Promise<void>;
}): IdentityDirectory => {
  const users = { ...(options.users ?? {}) };
  const memberships = [...(options.memberships ?? [])];
  const calls = options.calls;
  return {
    async resolveUserId(email) {
      calls.push(`GetUserId:${email}`);
      return users[email] ?? null;
    },
    async createUser(email) {
      calls.push(`CreateUser:${email}`);
      if (options.onCreateUser) return options.onCreateUser(email);
      const userId = `u-${email.split("@")[0]}`;
      users[email] = userId;
      return userId;
    },
    async addMembership(userId) {
      calls.push(`CreateGroupMembership:${userId}`);
      if (options.onAddMembership) return options.onAddMembership(userId);
    },
    async removeMembership(membershipId) {
      calls.push(`DeleteGroupMembership:${membershipId}`);
      if (options.onRemoveMembership) return options.onRemoveMembership(membershipId);
      const index = memberships.findIndex(
        (entry) => entry.membershipId === membershipId,
      );
      if (index >= 0) memberships.splice(index, 1);
    },
    async listMemberships() {
      calls.push("ListGroupMemberships");
      return memberships;
    },
  };
};

const WRITE_CALLS = /^(CreateUser|CreateGroupMembership|DeleteGroupMembership):/;

const writes = (calls: string[]): string[] =>
  calls.filter((call) => WRITE_CALLS.test(call));

const pair = (overrides: Partial<SyncPair> = {}): SyncPair => ({
  id: "test-pair",
  sourceGroupEmail: "engineering@goodparty.org",
  targetGroupId: ENGINEERS_GROUP_ID,
  mode: "apply",
  removalCap: { maxCount: 5, maxFraction: 0.1 },
  allowlist: ["@goodparty.org"],
  removalAlertThreshold: 0,
  ...overrides,
});

const metricValues = (
  records: Array<{ pairId: string; values: Array<{ name: string; value: number; dimensions?: Record<string, string> }> }>,
  pairId: string,
): Map<string, number> => {
  const map = new Map<string, number>();
  for (const record of records.filter((entry) => entry.pairId === pairId)) {
    for (const value of record.values) map.set(value.name, value.value);
  }
  return map;
};

const runWith = async (options: {
  syncPair: SyncPair;
  directory: DirectoryClient;
  identity: IdentityDirectory;
  overrideRemovalCap?: boolean;
}): Promise<{
  outcome: PairOutcome;
  metrics: ReturnType<typeof memoryMetrics>;
  log: ReturnType<typeof memoryLogger>;
}> => {
  const metrics = memoryMetrics();
  const log = memoryLogger();
  const outcome = await runPair(options.syncPair, {
    directory: options.directory,
    identity: options.identity,
    metrics: metrics.metrics,
    log: log.log,
    now: () => 0,
    ...(options.overrideRemovalCap
      ? { overrideRemovalCap: options.overrideRemovalCap }
      : {}),
  });
  return { outcome, metrics, log };
};

// ---------------------------------------------------------------------------
// Step 6: dry-run applies nothing.
// ---------------------------------------------------------------------------

describe("dry-run", () => {
  it("computes and logs the diff and applies nothing", async () => {
    const calls: string[] = [];
    const { outcome, metrics } = await runWith({
      syncPair: pair({ mode: "dry-run" }),
      directory: fakeDirectory({
        pages: [{ members: [member("alice@goodparty.org", "USER")] }],
      }),
      identity: fakeIdentity({
        users: {},
        memberships: [{ userId: "u-departed", membershipId: "m-departed" }],
        calls,
      }),
    });

    assert.equal(outcome.aborted, null);
    assert.equal(outcome.counts.wouldAdd, 1);
    assert.equal(outcome.counts.wouldRemove, 1);
    assert.equal(outcome.counts.added, 0);
    assert.equal(outcome.counts.removed, 0);
    // The whole point: not one write, not even for the member that is already
    // resolvable.
    assert.deepEqual(writes(calls), []);
    // `Removed` stays zero so the removals alarm does not page on a rehearsal;
    // the heartbeat is still emitted, because the run did happen.
    const values = metricValues(metrics.records, "test-pair");
    assert.equal(values.get(METRIC_NAMES.added), 0);
    assert.equal(values.get(METRIC_NAMES.removed), 0);
    assert.equal(values.get(METRIC_NAMES.success), 1);
  });
});

// ---------------------------------------------------------------------------
// Step 6: the reserved-target guard, in the handler as well as the config.
// ---------------------------------------------------------------------------

describe("reserved target", () => {
  it("refuses the Admins group and changes nothing", async () => {
    const calls: string[] = [];
    const { outcome, metrics, log } = await runWith({
      syncPair: pair({ targetGroupId: ADMINS_GROUP_ID }),
      directory: fakeDirectory({
        pages: [{ members: [member("alice@goodparty.org", "USER")] }],
      }),
      identity: fakeIdentity({
        memberships: [{ userId: "u-x", membershipId: "m-x" }],
        calls,
      }),
    });

    assert.equal(outcome.aborted?.reason, "reserved-target");
    assert.deepEqual(calls, []);
    assert.deepEqual(writes(calls), []);
    const aborted = log.events.find((entry) => entry.event === "sync.aborted");
    assert.equal(aborted?.fields.reason, "reserved-target");
    const values = metricValues(metrics.records, "test-pair");
    assert.equal(values.get(METRIC_NAMES.aborted), 1);
    // No heartbeat on an abort: the absence is the dead-man's switch.
    assert.equal(values.get(METRIC_NAMES.success), undefined);
  });

  it("is refused by the pair loop with reason reserved-target, before any read", async () => {
    const calls: string[] = [];
    const metrics = memoryMetrics();
    const log = memoryLogger();
    const outcomes = await runSync({
      config: {
        pollIntervalSeconds: 900,
        pairs: [pair({ targetGroupId: ADMINS_GROUP_ID, mode: "apply" })],
      },
      directory: fakeDirectory({
        pages: [{ members: [member("alice@goodparty.org", "USER")] }],
        calls,
      }),
      identityFor: () => fakeIdentity({ users: {}, memberships: [], calls }),
      metrics: metrics.metrics,
      log: log.log,
      now: () => 0,
    });

    // The plan's pinned assertion: the reason is `reserved-target`, not the
    // `invalid-config` a malformed pair gets, and the pair never read anything.
    assert.equal(outcomes[0].aborted?.reason, "reserved-target");
    assert.deepEqual(calls, []);
    assert.equal(
      metricValues(metrics.records, "test-pair").get(METRIC_NAMES.aborted),
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// The single most important test: a partial source read produces no writes.
// Step 2 pinned the adapter's rejection; this pins that the handler's apply
// step is never reached.
// ---------------------------------------------------------------------------

describe("incomplete source read", () => {
  it("aborts the pair and makes no CreateUser, CreateGroupMembership or DeleteGroupMembership call", async () => {
    const calls: string[] = [];
    const { outcome, metrics } = await runWith({
      syncPair: pair(),
      directory: fakeDirectory({
        pages: [
          { members: [member("alice@goodparty.org", "USER")], nextPageToken: "p2" },
          new Error("500 backendError"),
        ],
      }),
      identity: fakeIdentity({
        memberships: [
          { userId: "u-bob", membershipId: "m-bob" },
          { userId: "u-carol", membershipId: "m-carol" },
        ],
        calls,
      }),
    });

    assert.equal(outcome.aborted?.reason, "source-read-failed");
    assert.deepEqual(writes(calls), []);
    // The target was never even listed: the read failed before step 4.
    assert.ok(!calls.includes("ListGroupMemberships"));
    const values = metricValues(metrics.records, "test-pair");
    assert.equal(values.get(METRIC_NAMES.aborted), 1);
    assert.equal(values.get(METRIC_NAMES.success), undefined);
  });

  it("aborts on a domain-wide CUSTOMER member rather than mass-removing", async () => {
    const calls: string[] = [];
    const { outcome } = await runWith({
      syncPair: pair(),
      directory: fakeDirectory({
        pages: [{ members: [member(null, "CUSTOMER")] }],
      }),
      identity: fakeIdentity({
        memberships: [{ userId: "u-bob", membershipId: "m-bob" }],
        calls,
      }),
    });
    assert.equal(outcome.aborted?.reason, "domain-wide-membership");
    assert.deepEqual(writes(calls), []);
  });
});

// ---------------------------------------------------------------------------
// Step 6: the removal cap, and the invocation-payload override.
// ---------------------------------------------------------------------------

describe("removal cap", () => {
  const memberships = Array.from({ length: 20 }, (_, index) => ({
    userId: `u-${index}`,
    membershipId: `m-${index}`,
  }));

  it("aborts the whole pair on a large removal, adds included", async () => {
    const calls: string[] = [];
    const { outcome, metrics } = await runWith({
      syncPair: pair(),
      directory: fakeDirectory({
        pages: [{ members: [member("new@goodparty.org", "USER")] }],
      }),
      identity: fakeIdentity({ memberships, calls }),
    });

    assert.equal(outcome.aborted?.reason, "removal-cap");
    // Even the add that would have been safe is not applied: a large removal
    // means the source is not what we think it is.
    assert.deepEqual(writes(calls), []);
    const values = metricValues(metrics.records, "test-pair");
    assert.equal(values.get(METRIC_NAMES.removalCapTripped), 1);
    assert.equal(values.get(METRIC_NAMES.aborted), 1);
  });

  it("lets an explicit override through, and records it", async () => {
    const calls: string[] = [];
    const directory = fakeDirectory({ pages: [{ members: [] }] });
    const identity = fakeIdentity({ memberships, calls });
    const metrics = memoryMetrics();
    const log = memoryLogger();

    const outcomes = await runSync({
      config: { pollIntervalSeconds: 900, pairs: [pair()] },
      directory,
      identityFor: () => identity,
      metrics: metrics.metrics,
      log: log.log,
      now: () => 0,
      override: { pairId: "test-pair", overrideRemovalCap: true },
    });

    assert.equal(outcomes[0].aborted, null);
    assert.equal(outcomes[0].counts.removed, 20);
    assert.deepEqual(
      writes(calls).filter((call) => call.startsWith("DeleteGroupMembership")),
      memberships.map((entry) => `DeleteGroupMembership:${entry.membershipId}`),
    );
    const completed = log.events.find((entry) => entry.event === "sync.completed");
    assert.equal(completed?.fields.overridden, true);
  });

  it("still evaluates the cap in dry-run and reports it without aborting", async () => {
    const calls: string[] = [];
    const { outcome, metrics } = await runWith({
      syncPair: pair({ mode: "dry-run" }),
      directory: fakeDirectory({ pages: [{ members: [] }] }),
      identity: fakeIdentity({ memberships, calls }),
    });
    assert.equal(outcome.aborted, null);
    assert.deepEqual(writes(calls), []);
    assert.equal(
      metricValues(metrics.records, "test-pair").get(
        METRIC_NAMES.removalCapTripped,
      ),
      1,
    );
    assert.equal(
      metricValues(metrics.records, "test-pair").get(METRIC_NAMES.success),
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// Step 7: apply order, idempotency and the ambiguous-user stop.
// ---------------------------------------------------------------------------

describe("apply", () => {
  it("creates, then adds, then removes", async () => {
    const calls: string[] = [];
    const { outcome } = await runWith({
      syncPair: pair(),
      directory: fakeDirectory({
        pages: [{ members: [member("alice@goodparty.org", "USER")] }],
        calls,
      }),
      identity: fakeIdentity({
        users: {},
        memberships: [{ userId: "u-gone", membershipId: "m-gone" }],
        calls,
      }),
    });

    assert.equal(outcome.aborted, null);
    assert.equal(outcome.counts.added, 1);
    assert.equal(outcome.counts.removed, 1);
    assert.deepEqual(calls, [
      "getGroup:engineering@goodparty.org",
      "listMembers:engineering@goodparty.org:",
      // Step 3's resolution pass, then the target, then the create.
      "GetUserId:alice@goodparty.org",
      "ListGroupMemberships",
      // Create, then add, then remove: the group is never briefly smaller
      // than the union of source and target.
      "CreateUser:alice@goodparty.org",
      "CreateGroupMembership:u-alice",
      "DeleteGroupMembership:m-gone",
    ]);
  });

  it("reuses an existing user instead of creating one", async () => {
    const calls: string[] = [];
    const { outcome } = await runWith({
      syncPair: pair(),
      directory: fakeDirectory({
        pages: [{ members: [member("alice@goodparty.org", "USER")] }],
      }),
      identity: fakeIdentity({
        users: { "alice@goodparty.org": "u-alice" },
        memberships: [],
        calls,
      }),
    });
    assert.equal(outcome.counts.toCreate, 0);
    assert.ok(!calls.some((call) => call.startsWith("CreateUser:")));
    assert.deepEqual(
      writes(calls).filter((call) => call.startsWith("CreateGroupMembership")),
      ["CreateGroupMembership:u-alice"],
    );
  });

  it("is a no-op when the run already converged", async () => {
    const calls: string[] = [];
    const { outcome } = await runWith({
      syncPair: pair(),
      directory: fakeDirectory({
        pages: [{ members: [member("alice@goodparty.org", "USER")] }],
      }),
      identity: fakeIdentity({
        users: { "alice@goodparty.org": "u-alice" },
        memberships: [{ userId: "u-alice", membershipId: "m-alice" }],
        calls,
      }),
    });
    assert.equal(outcome.aborted, null);
    assert.deepEqual(writes(calls), []);
    assert.equal(outcome.counts.added, 0);
    assert.equal(outcome.counts.removed, 0);
  });

  it("counts a failed write and withholds the heartbeat", async () => {
    const calls: string[] = [];
    const { outcome, metrics } = await runWith({
      syncPair: pair(),
      directory: fakeDirectory({
        pages: [{ members: [member("alice@goodparty.org", "USER")] }],
      }),
      identity: fakeIdentity({
        users: { "alice@goodparty.org": "u-alice" },
        memberships: [],
        calls,
        onAddMembership: async () => {
          throw new SyncAbortError("apply-failed", "boom");
        },
      }),
    });
    assert.equal(outcome.aborted?.reason, "apply-failed");
    assert.equal(outcome.counts.failed, 1);
    const values = metricValues(metrics.records, "test-pair");
    // The heartbeat is absent so the dead-man's alarm sees a sync that did not
    // complete, not only a metric that says "failed".
    assert.equal(values.get(METRIC_NAMES.success), undefined);
    assert.equal(values.get(METRIC_NAMES.failed), 1);
  });

  it("stops on an ambiguous user rather than adding a duplicate", async () => {
    const calls: string[] = [];
    const { outcome } = await runWith({
      syncPair: pair(),
      directory: fakeDirectory({
        pages: [
          {
            members: [
              member("alice@goodparty.org", "USER"),
              member("bob@goodparty.org", "USER"),
            ],
          },
        ],
      }),
      identity: fakeIdentity({
        users: {},
        memberships: [],
        calls,
        onCreateUser: async () => {
          throw new SyncAbortError("ambiguous-user", "conflict, no user");
        },
      }),
    });
    assert.equal(outcome.aborted?.reason, "ambiguous-user");
    // The second member was never attempted.
    assert.equal(
      calls.filter((call) => call.startsWith("CreateUser:")).length,
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// Step 1: config validation, and one bad pair not taking down the others.
// ---------------------------------------------------------------------------

describe("config", () => {
  it("parses the envelope and rejects an unusable poll interval", () => {
    assert.equal(
      parseSyncConfig(
        JSON.stringify({ pollIntervalSeconds: 900, pairs: [] } as SyncConfig),
      ).pollIntervalSeconds,
      900,
    );
    for (const bad of [
      "not json",
      JSON.stringify({ pollIntervalSeconds: 90, pairs: [] }),
      JSON.stringify({ pollIntervalSeconds: 900 }),
    ]) {
      assert.throws(
        () => parseSyncConfig(bad),
        (err: unknown) =>
          err instanceof SyncAbortError && err.reason === "invalid-config",
      );
    }
  });

  it("reports every problem in a pair, not just the first", () => {
    const problems = validatePair({
      id: "",
      sourceGroupEmail: "not-an-address",
      targetGroupId: "g-1",
      mode: "nope",
      removalCap: { maxCount: -1, maxFraction: 2 },
      allowlist: [],
      removalAlertThreshold: -1,
    });
    assert.ok(problems.length >= 7, problems.join("; "));
  });

  it("treats a reserved target as well-formed config, refused by the guard instead", () => {
    // The reason matters: `invalid-config` would say "the pair is broken", and
    // `reserved-target` says "this group is off limits", which is what an
    // operator needs to read.
    assert.deepEqual(
      validatePair(pair({ targetGroupId: ADMINS_GROUP_ID })),
      [],
    );
  });

  it("skips an invalid pair with invalid-config and still runs the good one", async () => {
    const calls: string[] = [];
    const metrics = memoryMetrics();
    const log = memoryLogger();
    const outcomes = await runSync({
      config: {
        pollIntervalSeconds: 900,
        pairs: [
          pair({ id: "broken", sourceGroupEmail: "nope" }),
          pair({ id: "good", mode: "dry-run" }),
        ],
      },
      directory: fakeDirectory({
        pages: [{ members: [member("alice@goodparty.org", "USER")] }],
      }),
      identityFor: () =>
        fakeIdentity({ users: {}, memberships: [], calls }),
      metrics: metrics.metrics,
      log: log.log,
      now: () => 0,
    });

    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0].aborted?.reason, "invalid-config");
    assert.equal(outcomes[1].aborted, null);
    // The broken pair never reached the source read.
    assert.ok(!calls.some((call) => call.includes("listMembers")));
  });
});

// ---------------------------------------------------------------------------
// The invocation shapes and the SSM read.
// ---------------------------------------------------------------------------

const handlerDeps = (options: {
  raw?: string | (() => Promise<string>);
  calls?: string[];
  identity?: IdentityDirectory;
  metrics?: Metrics;
}) => {
  const calls = options.calls ?? [];
  const log = memoryLogger();
  const metrics = options.metrics ?? memoryMetrics().metrics;
  return {
    calls,
    log,
    deps: {
      readParameter: async () => {
        if (typeof options.raw === "function") return options.raw();
        return options.raw ?? JSON.stringify(SYNC_CONFIG);
      },
      buildDirectory: async () =>
        fakeDirectory({
          pages: [{ members: [member("alice@goodparty.org", "USER")] }],
          calls,
        }),
      buildIdentity: async () =>
        options.identity ?? fakeIdentity({ users: {}, memberships: [], calls }),
      metrics,
      log: log.log,
      now: () => 0,
    },
  };
};

describe("the invocation", () => {
  it("refuses an unrecognised action rather than treating it as a run", async () => {
    const calls: string[] = [];
    const { deps, log } = handlerDeps({ calls });
    const outcomes = await handle({ action: "apply" }, deps);
    assert.deepEqual(outcomes, []);
    assert.deepEqual(calls, []);
    assert.equal(
      log.events.find((entry) => entry.event === "sync.aborted")?.fields.reason,
      "invalid-config",
    );
  });

  it("aborts the whole invocation when SSM cannot be read", async () => {
    const calls: string[] = [];
    const { deps, log } = handlerDeps({
      calls,
      raw: async () => {
        throw new Error("ParameterNotFound");
      },
    });
    const outcomes = await handle({ action: "sync" }, deps);
    assert.deepEqual(outcomes, []);
    // Nothing was read and nothing was written.
    assert.deepEqual(calls, []);
    const aborted = log.events.find((entry) => entry.event === "sync.aborted");
    assert.equal(aborted?.fields.reason, "invalid-config");
    assert.match(String(aborted?.fields.detail), /ParameterNotFound/);
  });

  it("parses the manual override payload and ignores everything else about it", () => {
    assert.deepEqual(parseOverride({ action: "sync" }), {
      overrideRemovalCap: false,
    });
    assert.deepEqual(
      parseOverride({
        action: "sync",
        pairId: "engineers-google",
        overrideRemovalCap: true,
      }),
      { pairId: "engineers-google", overrideRemovalCap: true },
    );
    // Only a literal `true` is an override.
    assert.equal(
      parseOverride({ action: "sync", overrideRemovalCap: "true" })
        ?.overrideRemovalCap,
      false,
    );
    // An EventBridge scheduled event has no `action` and runs every pair.
    assert.equal(parseOverride({ version: "0", source: "aws.events" }), undefined);
  });

  it("refuses an override that names no pair, rather than ignoring it", async () => {
    // The override is applied per pair, so one without a `pairId` cannot mean
    // anything. Accepting it and doing nothing would look to the operator like
    // the cap had been let through.
    assert.throws(
      () => parseOverride({ action: "sync", overrideRemovalCap: true }),
      (err: unknown) =>
        err instanceof SyncAbortError &&
        err.reason === "invalid-config" &&
        /pairId/.test(err.message),
    );

    const calls: string[] = [];
    const { deps, log } = handlerDeps({ calls });
    const outcomes = await handle(
      { action: "sync", overrideRemovalCap: true },
      deps,
    );
    assert.deepEqual(outcomes, []);
    assert.deepEqual(calls, []);
    const aborted = log.events.find((entry) => entry.event === "sync.aborted");
    assert.equal(aborted?.fields.reason, "invalid-config");
    assert.match(String(aborted?.fields.detail), /pairId/);
  });

  it("refuses an override that names a pair which is not configured", async () => {
    const calls: string[] = [];
    const metrics = memoryMetrics();
    const log = memoryLogger();
    const outcomes = await runSync({
      config: { pollIntervalSeconds: 900, pairs: [pair({ mode: "dry-run" })] },
      directory: fakeDirectory({ pages: [{ members: [] }], calls }),
      identityFor: () => fakeIdentity({ users: {}, memberships: [], calls }),
      metrics: metrics.metrics,
      log: log.log,
      now: () => 0,
      override: { pairId: "not-a-pair", overrideRemovalCap: true },
    });
    // No pair ran, and the run says why instead of reporting success by
    // omission.
    assert.deepEqual(outcomes, []);
    assert.deepEqual(calls, []);
    const aborted = log.events.find((entry) => entry.event === "sync.aborted");
    assert.equal(aborted?.fields.reason, "invalid-config");
    assert.match(String(aborted?.fields.detail), /not-a-pair/);
  });

  it("runs the configured pair from the SSM value in its configured mode", async () => {
    const calls: string[] = [];
    const metrics = memoryMetrics();
    const { deps } = handlerDeps({ calls, metrics: metrics.metrics });
    const outcomes = await handle({ action: "sync" }, deps);

    // Both configured pairs run, in config order. The second one is `dry-run`,
    // so the write assertions below stay the first pair's alone.
    assert.deepEqual(
      outcomes.map((outcome) => outcome.pairId),
      ["engineers-google", "approvers-google"],
    );
    const outcome = outcomes.find(
      (candidate) => candidate.pairId === "engineers-google",
    );
    assert.ok(outcome);
    assert.equal(outcome.aborted, null);
    assert.equal(outcome.counts.wouldAdd, 1);
    // The configured pair is `apply`, so the diff reaches the write path. The
    // dry-run path is covered separately above; this test is what would fail if
    // the mode in the config stopped matching the mode the handler acts on.
    assert.equal(outcome.counts.added, 1);
    assert.deepEqual(writes(calls), [
      "CreateUser:alice@goodparty.org",
      "CreateGroupMembership:u-alice",
    ]);
    assert.equal(
      metricValues(
        metrics.records as never,
        "engineers-google",
      ).get(METRIC_NAMES.success),
      1,
    );
  });

  it("restricts a manual invocation to the one pair it names", async () => {
    const calls: string[] = [];
    const config: SyncConfig = {
      pollIntervalSeconds: 900,
      pairs: [pair({ id: "a", mode: "dry-run" }), pair({ id: "b", mode: "dry-run" })],
    };
    const { deps } = handlerDeps({ calls, raw: JSON.stringify(config) });
    const outcomes = await handle({ action: "sync", pairId: "b" }, deps);
    assert.deepEqual(outcomes.map((outcome) => outcome.pairId), ["b"]);
  });
});

// ---------------------------------------------------------------------------
// The Identity Store adapter's idempotency, driven through a fake SDK client so
// the command shapes and the error handling are exercised too.
// ---------------------------------------------------------------------------

const sdkClient = (
  handler: (command: unknown) => Promise<unknown>,
): IdentityStoreClientLike =>
  ({ send: handler }) as unknown as IdentityStoreClientLike;

describe("identity adapter", () => {
  it("resolves on emails.value and treats ResourceNotFound as 'create it'", async () => {
    const seen: string[] = [];
    const directory = createIdentityDirectory({
      groupId: ENGINEERS_GROUP_ID,
      client: sdkClient(async (command) => {
        if (command instanceof GetUserIdCommand) {
          seen.push(
            `${command.input.AlternateIdentifier?.UniqueAttribute?.AttributePath}="${command.input.AlternateIdentifier?.UniqueAttribute?.AttributeValue}"`,
          );
          throw new ResourceNotFoundException({
            message: "no such user",
            $metadata: {},
          });
        }
        throw new Error("unexpected command");
      }),
    });
    assert.equal(await directory.resolveUserId("Alice@GoodParty.org"), null);
    assert.deepEqual(seen, ['emails.value="alice@goodparty.org"']);
  });

  it("treats ConflictException on CreateUser as success once the user resolves", async () => {
    let resolves = 0;
    const directory = createIdentityDirectory({
      groupId: ENGINEERS_GROUP_ID,
      client: sdkClient(async (command) => {
        if (command instanceof GetUserIdCommand) {
          resolves += 1;
          // First resolution (before the create) misses; the re-resolve after
          // the conflict finds the user.
          if (resolves === 1) {
            throw new ResourceNotFoundException({ message: "", $metadata: {} });
          }
          return { UserId: "u-alice" };
        }
        if (command instanceof CreateUserCommand) {
          assert.equal(command.input.UserName, "alice@goodparty.org");
          assert.equal(command.input.Emails?.[0]?.Value, "alice@goodparty.org");
          assert.equal(command.input.DisplayName, "Alice");
          throw new ConflictException({ message: "exists", $metadata: {} });
        }
        throw new Error("unexpected command");
      }),
    });
    assert.equal(await directory.createUser("alice@goodparty.org"), "u-alice");
  });

  it("aborts with ambiguous-user when the conflict does not resolve", async () => {
    const directory = createIdentityDirectory({
      groupId: ENGINEERS_GROUP_ID,
      client: sdkClient(async (command) => {
        if (command instanceof GetUserIdCommand) {
          throw new ResourceNotFoundException({ message: "", $metadata: {} });
        }
        if (command instanceof CreateUserCommand) {
          throw new ConflictException({ message: "unique", $metadata: {} });
        }
        throw new Error("unexpected command");
      }),
    });
    await assert.rejects(
      directory.createUser("alice@goodparty.org"),
      (err: unknown) =>
        err instanceof SyncAbortError && err.reason === "ambiguous-user",
    );
  });

  it("treats ConflictException on add and ResourceNotFound on remove as success", async () => {
    const directory = createIdentityDirectory({
      groupId: ENGINEERS_GROUP_ID,
      client: sdkClient(async (command) => {
        if (command instanceof CreateGroupMembershipCommand) {
          assert.equal(command.input.GroupId, ENGINEERS_GROUP_ID);
          assert.deepEqual(command.input.MemberId, { UserId: "u-alice" });
          throw new ConflictException({ message: "member", $metadata: {} });
        }
        if (command instanceof DeleteGroupMembershipCommand) {
          assert.equal(command.input.MembershipId, "m-alice");
          throw new ResourceNotFoundException({ message: "", $metadata: {} });
        }
        throw new Error("unexpected command");
      }),
    });
    // Neither throws: both mean the desired state already holds.
    await directory.addMembership("u-alice");
    await directory.removeMembership("m-alice");
  });

  it("lists every membership page before the diff sees the target", async () => {
    let page = 0;
    const directory = createIdentityDirectory({
      groupId: ENGINEERS_GROUP_ID,
      client: sdkClient(async (command) => {
        assert.ok(command instanceof ListGroupMembershipsCommand);
        page += 1;
        if (page === 1) {
          return {
            GroupMemberships: [{ MemberId: { UserId: "u-1" }, MembershipId: "m-1" }],
            NextToken: "next",
          };
        }
        return {
          GroupMemberships: [{ MemberId: { UserId: "u-2" }, MembershipId: "m-2" }],
        };
      }),
    });
    assert.deepEqual(await directory.listMemberships(), [
      { userId: "u-1", membershipId: "m-1" },
      { userId: "u-2", membershipId: "m-2" },
    ]);
  });

  it("retries throttling with exponential backoff and nothing else", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("slow down"), {
            name: "ThrottlingException",
          });
        }
        return "ok";
      },
      { sleep: async (ms) => void delays.push(ms) },
    );
    assert.equal(result, "ok");
    assert.deepEqual(delays, [200, 400]);

    // A non-throttling error is not retried at all.
    attempts = 0;
    await assert.rejects(
      withRetry(async () => {
        attempts += 1;
        throw new Error("denied");
      }),
      /denied/,
    );
    assert.equal(attempts, 1);
  });

  it("derives a display name from the local part", () => {
    // Open question 3 keeps the Google scope to group reads, so the name comes
    // from the address and a human corrects it later.
    assert.deepEqual(deriveDisplayName("jeff.jagoda@goodparty.org"), {
      displayName: "Jeff Jagoda",
      givenName: "Jeff",
      familyName: "Jagoda",
    });
    assert.deepEqual(deriveDisplayName("swain@goodparty.org"), {
      displayName: "Swain",
      givenName: "Swain",
    });
  });
});

// ---------------------------------------------------------------------------
// The Google adapter. A fake `fetch` and a generated key: no network, but the
// JWT, the token exchange, the pagination and the abort on a non-2xx are real.
// ---------------------------------------------------------------------------

const serviceAccountKey = (): {
  json: string;
  privateKeyPem: string;
  publicKey: KeyObject;
} => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return {
    privateKeyPem,
    publicKey,
    json: JSON.stringify({
      type: "service_account",
      client_email: "identity-group-sync@example.iam.gserviceaccount.com",
      private_key: privateKeyPem,
    }),
  };
};

/**
 * Verifies an assertion the way Google does: RS256 over the signing input, with
 * the public key. A double-encoded signature fails this even though it is a
 * well-formed JWT, which is why the test is a verification and not a shape
 * check.
 */
const assertionIsSigned = (assertion: string, publicKey: KeyObject): boolean => {
  const [header, claims, signature] = assertion.split(".");
  return verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${claims}`),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
};

const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() {
    return body;
  },
  async text() {
    return JSON.stringify(body);
  },
});

describe("google adapter", () => {
  it("signs a delegated assertion for exactly the two read scopes", () => {
    const { json, publicKey } = serviceAccountKey();
    const key = parseServiceAccountKey(json);
    const assertion = buildAssertion({
      key,
      impersonationEmail: "group-sync-admin@goodparty.org",
      nowSeconds: 1_700_000_000,
    });
    const [header, claims, signature] = assertion.split(".");

    // The signature is the raw RSA output, base64url-encoded exactly once:
    // 256 bytes for a 2048-bit key. The double-encoded regression produced a
    // ~344-character signature that decodes to base64 text, and Google
    // rejected every assertion.
    assert.equal(Buffer.from(signature, "base64url").length, 256);
    assert.equal(assertionIsSigned(assertion, publicKey), true);
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
      alg: "RS256",
      typ: "JWT",
    });
    const decoded = JSON.parse(Buffer.from(claims, "base64url").toString());
    assert.equal(decoded.iss, key.client_email);
    assert.equal(decoded.sub, "group-sync-admin@goodparty.org");
    assert.equal(
      decoded.scope,
      "https://www.googleapis.com/auth/admin.directory.group.readonly https://www.googleapis.com/auth/admin.directory.group.member.readonly",
    );
    assert.equal(decoded.aud, "https://oauth2.googleapis.com/token");
    assert.equal(decoded.exp - decoded.iat, 3600);
  });

  it("refuses a malformed secret without quoting it", () => {
    for (const bad of ["not json", JSON.stringify({ client_email: "x" })]) {
      assert.throws(
        () => parseServiceAccountKey(bad),
        (err: unknown) =>
          err instanceof SyncAbortError &&
          err.reason === "source-read-failed" &&
          !err.message.includes("not json"),
      );
    }
  });

  it("reads the group and every member page through the real client", async () => {
    const { json, publicKey } = serviceAccountKey();
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      urls.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        assert.equal(init?.method, "POST");
        assert.match(String(init?.body), /grant_type=/);
        // The assertion the client actually sends is one Google would accept:
        // a signature over the header and claims, verifiable with the key.
        const assertion = new URLSearchParams(String(init?.body)).get(
          "assertion",
        );
        assert.ok(assertion);
        assert.equal(assertionIsSigned(assertion, publicKey), true);
        return response(200, { access_token: "token-1" });
      }
      assert.equal(init?.headers?.authorization, "Bearer token-1");
      if (url.includes("pageToken=p2")) {
        return response(200, {
          members: [{ email: "bob@goodparty.org", type: "USER" }],
        });
      }
      return response(200, {
        members: [{ email: "alice@goodparty.org", type: "USER" }],
        nextPageToken: "p2",
      });
    };

    const client = await createDirectoryClient({
      keyJson: json,
      impersonationEmail: "group-sync-admin@goodparty.org",
      fetchImpl,
    });
    const result = await fetchSourceMembers({
      client,
      groupEmail: "engineering@goodparty.org",
      allowlist: ["@goodparty.org"],
    });

    assert.deepEqual(result.emails, ["alice@goodparty.org", "bob@goodparty.org"]);
    // One token exchange for the run, then the group and two member pages.
    assert.equal(urls.filter((url) => url.includes("oauth2")).length, 1);
    assert.equal(urls.length, 4);
  });

  it("aborts when a later member page returns a non-2xx", async () => {
    const { json } = serviceAccountKey();
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("oauth2")) return response(200, { access_token: "t" });
      if (url.includes("pageToken=p2")) return response(500, { error: "boom" });
      return response(200, {
        members: [{ email: "alice@goodparty.org", type: "USER" }],
        nextPageToken: "p2",
      });
    };
    const client = await createDirectoryClient({
      keyJson: json,
      impersonationEmail: "group-sync-admin@goodparty.org",
      fetchImpl,
    });
    await assert.rejects(
      fetchSourceMembers({
        client,
        groupEmail: "engineering@goodparty.org",
        allowlist: ["@goodparty.org"],
      }),
      (err: unknown) =>
        err instanceof Error && err.name === "SourceReadError" &&
        (err as { reason?: string }).reason === "source-read-failed",
    );
  });

  it("fails closed when no impersonation admin is configured", async () => {
    const { json } = serviceAccountKey();
    await assert.rejects(
      createDirectoryClient({
        keyJson: json,
        impersonationEmail: "",
        fetchImpl: async () => response(200, {}),
      }),
      (err: unknown) =>
        err instanceof SyncAbortError && err.reason === "source-read-failed",
    );
  });
});

// ---------------------------------------------------------------------------
// Logging: membership is personal data, and the logs say so by not containing
// it.
// ---------------------------------------------------------------------------

describe("logging", () => {
  it("logs a stable reference to an email, never the address", () => {
    const ref = emailRef("Alice@GoodParty.org");
    assert.match(ref, /^[0-9a-f]{12}$/);
    assert.equal(ref, emailRef("alice@goodparty.org"));
    assert.ok(!ref.includes("alice"));
    assert.ok(!ref.includes("goodparty"));
  });
});
