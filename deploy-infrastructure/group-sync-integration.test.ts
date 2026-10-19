/**
 * Integration test for step 4 of `docs/google-group-sync.md`: the read, the
 * diff and the guards against a **real scratch Google group and a real scratch
 * Identity Center group**.
 *
 * The unit tests (`group-sync.test.ts`, `group-sync-runtime.test.ts`) fake
 * Google and the Identity Store, so they cannot answer the questions this file
 * exists for: does the real delegated Google read actually return the source
 * group's members, does the real target membership list diff as expected, does
 * a dry run against the real directory write nothing, and does the
 * reserved-target guard refuse `Admins` before any call. Those need live
 * credentials.
 *
 * ## Opt-in, and why it is not in `npm test`'s green path
 *
 * The suite is skipped unless `GROUP_SYNC_INTEGRATION=1`. `npm test` still
 * loads this file, so the skip is visible: the file prints a `SKIPPED` line to
 * stderr at load time and node's test reporter prints the skip reason. It
 * never runs by default, because it needs:
 *
 * - **Real Google domain-wide delegation.** A service-account key JSON at
 *   `GROUP_SYNC_GOOGLE_KEY_FILE` whose client id is delegated the two
 *   read-only group scopes, and an impersonation admin at
 *   `GOOGLE_IMPERSONATION_EMAIL` (default
 *   `svc-identity-group-sync@goodparty.org`, the address the infrastructure
 *   stack now configures). CI has neither.
 * - **Real AWS credentials for the Identity Store in the management account.**
 *   The operator's ambient chain is used, or a role named by
 *   `GROUP_SYNC_INTEGRATION_IDENTITY_ROLE_ARN` is assumed first. It is
 *   deliberately **not** the Lambda's `identity-group-sync-grant`: that role's
 *   trust admits only the `identity-group-sync` Lambda role in the
 *   infrastructure account, so no test runner can assume it, and the test
 *   would fail with AccessDenied however the scratch group is configured. The
 *   credentials only need `identitystore:GetUserId` and
 *   `identitystore:ListGroupMemberships` on the scratch group. The container's
 *   own session (`WorkbenchAccess` in 024901689212) cannot reach what this
 *   needs, which is why this test does not run there either. Nothing here
 *   reads a secret or writes to the identity store.
 *
 * ## The scratch pair
 *
 * Open question 4 is resolved as the cheap option: a scratch group in the
 * **existing** identity store, not a dedicated test account. The pair id,
 * source group and target group are supplied as environment variables and are
 * asserted not to collide with any configured pair, so this test can never
 * touch the real `engineering@goodparty.org` → `Engineers` pair:
 *
 * - `GROUP_SYNC_SCRATCH_SOURCE_GROUP` — the scratch Google group's address.
 * - `GROUP_SYNC_SCRATCH_TARGET_GROUP_ID` — the scratch Identity Center group
 *   id. The test reads it with the operator's own credentials, so it does not
 *   need the scratch group's ARN added to any production grant.
 * - `GROUP_SYNC_SCRATCH_ALLOWLIST` — optional comma-separated override,
 *   default `@goodparty.org`.
 * - `GROUP_SYNC_SCRATCH_EXPECTED_MEMBER` — optional address that must appear
 *   in the source set, so an empty scratch group is not silently "green".
 * - `GROUP_SYNC_INTEGRATION_IDENTITY_ROLE_ARN` — optional role to assume for
 *   the Identity Store calls. Without it the ambient AWS credential chain is
 *   used (`AWS_PROFILE`, SSO, instance role, ...).
 *
 * Run it with:
 *
 * ```sh
 * GROUP_SYNC_INTEGRATION=1 \
 * GROUP_SYNC_GOOGLE_KEY_FILE=/path/to/key.json \
 * GROUP_SYNC_SCRATCH_SOURCE_GROUP=group-sync-test@goodparty.org \
 * GROUP_SYNC_SCRATCH_TARGET_GROUP_ID=<scratch-group-id> \
 *   npx tsx --test deploy-infrastructure/group-sync-integration.test.ts
 * ```
 *
 * To use a management-account role rather than the ambient session, add:
 *
 * ```sh
 * GROUP_SYNC_INTEGRATION_IDENTITY_ROLE_ARN=arn:aws:iam::333022194791:role/<role>
 * ```
 *
 * ## Why it is dry-run only, and how it proves nothing was written
 *
 * The pair is `mode: "dry-run"`, so the test never mutates the scratch group
 * and needs no `finally` cleanup: the only directory calls it makes are reads
 * (`GetUserId`, `ListGroupMemberships`). That is deliberate. The step that
 * applies is the rollout's reviewed `apply` change, and an apply path in a test
 * would either need cleanup that can itself fail (leaving the scratch group
 * mutated) or would duplicate the production write path outside the reviewed
 * rollout. The dry-run is what the rollout's diff review depends on, so that is
 * what is tested. The test snapshots the target's membership ids before and
 * after the run and asserts they are identical, and asserts `Added`/`Removed`
 * are zero.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

import {
  RESERVED_TARGET_GROUP_IDS,
  SYNC_PAIRS,
  type SyncConfig,
  type SyncPair,
} from "./group-sync/config";
import { createDirectoryClient } from "./group-sync/google";
import {
  createIdentityDirectory,
  REGION as IDENTITY_STORE_REGION,
  type IdentityDirectory,
  type IdentityStoreClientLike,
} from "./group-sync/identity";
import { memoryLogger } from "./group-sync/log";
import { memoryMetrics } from "./group-sync/metrics";
import { runSync } from "./group-sync/run";
import {
  fetchSourceMembers,
  isAllowlisted,
  type DirectoryClient,
} from "./group-sync/source";

/** The opt-in. Anything other than `1` means "do not run". */
export const INTEGRATION_OPT_IN_ENV = "GROUP_SYNC_INTEGRATION";

/** Its own id, so it is obviously not the real pair in metrics or audit logs. */
export const INTEGRATION_PAIR_ID = "scratch-integration";

/** The `Admins` group id, pinned in `deploy/components/identity-center.ts`. */
const ADMINS_GROUP_ID = "88c1b330-a001-707a-06ca-94e289013bf5";

/** The stack's configured impersonation admin; see the file header. */
const DEFAULT_IMPERSONATION_EMAIL = "svc-identity-group-sync@goodparty.org";

const ENABLED = process.env[INTEGRATION_OPT_IN_ENV] === "1";

const SKIP_REASON =
  `${INTEGRATION_OPT_IN_ENV} is not 1, so the group-sync integration test did ` +
  "not run. It needs real Google domain-wide delegation " +
  "(GROUP_SYNC_GOOGLE_KEY_FILE, GOOGLE_IMPERSONATION_EMAIL) and AWS " +
  "credentials with Identity Store reads on the scratch group (ambient, or " +
  "GROUP_SYNC_INTEGRATION_IDENTITY_ROLE_ARN). See the header of " +
  "deploy-infrastructure/group-sync-integration.test.ts.";

if (!ENABLED) {
  // Loud on purpose: a silent skip in a long `npm test` run reads as a pass.
  console.error(`[group-sync integration] SKIPPED: ${SKIP_REASON}`);
}

const requireEnv = (name: string, why: string): string => {
  const value = process.env[name];
  if (!value || !value.trim()) {
    assert.fail(
      `${name} must be set when ${INTEGRATION_OPT_IN_ENV}=1: ${why}`,
    );
  }
  return value.trim();
};

/** The scratch pair. Every run of the suite builds it fresh from the env. */
const scratchPair = (): SyncPair => {
  const sourceGroupEmail = requireEnv(
    "GROUP_SYNC_SCRATCH_SOURCE_GROUP",
    "the scratch Google group this test reads (never the real engineering@ group)",
  );
  const targetGroupId = requireEnv(
    "GROUP_SYNC_SCRATCH_TARGET_GROUP_ID",
    "the scratch Identity Center group this test diffs against",
  );
  const allowlist = (process.env.GROUP_SYNC_SCRATCH_ALLOWLIST ?? "@goodparty.org")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    id: INTEGRATION_PAIR_ID,
    sourceGroupEmail,
    targetGroupId,
    // Always dry-run. The rollout owns the apply; see the header.
    mode: "dry-run",
    // Wide enough that a scratch group's expected removals are reported, not
    // treated as a misconfigured source. The cap still evaluates.
    removalCap: { maxCount: 100, maxFraction: 1 },
    allowlist: allowlist.length > 0 ? allowlist : ["@goodparty.org"],
    removalAlertThreshold: 0,
  };
};

/** The live Google read. Needs only the delegated service-account key. */
const liveGoogleDirectory = async (): Promise<DirectoryClient> => {
  const keyFile = requireEnv(
    "GROUP_SYNC_GOOGLE_KEY_FILE",
    "path to the service-account key JSON with domain-wide delegation",
  );
  const impersonationEmail =
    process.env.GOOGLE_IMPERSONATION_EMAIL?.trim() ||
    DEFAULT_IMPERSONATION_EMAIL;

  return createDirectoryClient({
    keyJson: fs.readFileSync(keyFile, "utf8"),
    impersonationEmail,
  });
};

/**
 * The Identity Store client the test runs with: the role the operator named,
 * or the ambient credential chain. Never the Lambda's grant role -- its trust
 * admits only `identity-group-sync` in the infrastructure account, so a test
 * runner cannot assume it.
 */
const liveIdentityClient = async (): Promise<IdentityStoreClientLike> => {
  const roleArn = process.env.GROUP_SYNC_INTEGRATION_IDENTITY_ROLE_ARN?.trim();
  if (!roleArn) {
    // `AWS_PROFILE`, SSO or whatever the operator's shell already has.
    return new IdentitystoreClient({ region: IDENTITY_STORE_REGION });
  }

  const sts = new STSClient({ region: IDENTITY_STORE_REGION });
  const result = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      // Its own name, so CloudTrail separates these reads from the Lambda's
      // `identity-group-sync` assumes.
      RoleSessionName: "identity-group-sync-integration",
    }),
  );
  const credentials = result.Credentials;
  if (
    !credentials?.AccessKeyId ||
    !credentials.SecretAccessKey ||
    !credentials.SessionToken
  ) {
    throw new Error(`AssumeRole ${roleArn} returned no usable credentials`);
  }
  return new IdentitystoreClient({
    region: IDENTITY_STORE_REGION,
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
  });
};

/** The scratch target's Identity Store adapter. */
const liveIdentityDirectory = async (
  pair: SyncPair,
): Promise<IdentityDirectory> =>
  createIdentityDirectory({
    client: await liveIdentityClient(),
    groupId: pair.targetGroupId,
  });

describe(
  "group sync integration against the scratch pair",
  { skip: ENABLED ? false : SKIP_REASON },
  () => {
    it("cannot collide with a configured pair or with Admins", () => {
      const pair = scratchPair();
      // The safety property of the whole file: this test's writes (if any were
      // ever added) and its reads stay on the scratch group.
      assert.equal(pair.mode, "dry-run");
      assert.ok(
        SYNC_PAIRS.every((configured) => configured.id !== pair.id),
        `pair id ${pair.id} is also configured in SYNC_PAIRS`,
      );
      assert.ok(
        SYNC_PAIRS.every(
          (configured) => configured.targetGroupId !== pair.targetGroupId,
        ),
        `target ${pair.targetGroupId} is also a configured pair's target`,
      );
      assert.ok(!RESERVED_TARGET_GROUP_IDS.includes(pair.targetGroupId));
      assert.notEqual(pair.targetGroupId, ADMINS_GROUP_ID);
    });

    it("reads the scratch Google group's members, page by page, through real delegation", async () => {
      const pair = scratchPair();
      // Google only: no AWS credential is needed for this property.
      const directory = await liveGoogleDirectory();

      // The raw read, independent of the adapter, so the assertion compares
      // the adapter against Google rather than against itself.
      const rawEmails: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await directory.listMembers({
          groupKey: pair.sourceGroupEmail,
          ...(pageToken ? { pageToken } : {}),
        });
        for (const member of page.members) {
          if ((member.type ?? "") === "USER" && member.email) {
            rawEmails.push(member.email.trim().toLowerCase());
          }
        }
        pageToken = page.nextPageToken ?? undefined;
      } while (pageToken);

      const source = await fetchSourceMembers({
        client: directory,
        groupEmail: pair.sourceGroupEmail,
        allowlist: pair.allowlist,
      });

      const expected = [...new Set(rawEmails)].filter((email) =>
        isAllowlisted(email, pair.allowlist),
      );
      assert.deepEqual(source.emails, expected);

      // Node cannot know the scratch group's intended membership, so it is
      // supplied. Without it, an empty scratch group would make every other
      // assertion vacuously true.
      const expectedMember = process.env.GROUP_SYNC_SCRATCH_EXPECTED_MEMBER;
      if (expectedMember?.trim()) {
        assert.ok(
          source.emails.includes(expectedMember.trim().toLowerCase()),
          `${expectedMember.trim()} is not in the source set read from ${pair.sourceGroupEmail}`,
        );
      }
    });

    it("diffs against the real scratch target, and a dry run writes nothing", async () => {
      const pair = scratchPair();
      const directory = await liveGoogleDirectory();
      const identity = await liveIdentityDirectory(pair);

      const source = await fetchSourceMembers({
        client: directory,
        groupEmail: pair.sourceGroupEmail,
        allowlist: pair.allowlist,
      });
      const before = await identity.listMemberships();

      // The expected diff, computed straight from the plan's steps 3-5
      // against the live directory. `runSync` has to agree with this, not with
      // its own internals.
      const resolved: Array<{ email: string; userId: string | null }> = [];
      for (const email of source.emails) {
        resolved.push({ email, userId: await identity.resolveUserId(email) });
      }
      const targetIds = new Set(before.map((membership) => membership.userId));
      const sourceIds = new Set(
        resolved.flatMap((member) => (member.userId ? [member.userId] : [])),
      );
      const expectedWouldAdd = resolved.filter(
        (member) => !member.userId || !targetIds.has(member.userId),
      ).length;
      const expectedWouldRemove = before.filter(
        (membership) => !sourceIds.has(membership.userId),
      ).length;

      const { metrics } = memoryMetrics();
      const { log, events } = memoryLogger();
      const config: SyncConfig = {
        pollIntervalSeconds: 15 * 60,
        pairs: [pair],
      };
      const outcomes = await runSync({
        config,
        directory,
        identityFor: () => identity,
        metrics,
        log,
        now: () => Date.now(),
      });

      assert.equal(outcomes.length, 1);
      const [outcome] = outcomes;
      assert.equal(outcome.pairId, INTEGRATION_PAIR_ID);
      assert.equal(
        outcome.aborted,
        null,
        `the scratch pair aborted: ${JSON.stringify(outcome.aborted)}`,
      );
      assert.equal(outcome.counts.sourceMembers, source.emails.length);
      assert.equal(outcome.counts.targetMembers, before.length);
      assert.equal(outcome.counts.wouldAdd, expectedWouldAdd);
      assert.equal(outcome.counts.wouldRemove, expectedWouldRemove);

      // The property this test exists for: a dry run is a read, not a write.
      assert.equal(outcome.counts.added, 0);
      assert.equal(outcome.counts.removed, 0);

      const after = await identity.listMemberships();
      assert.deepEqual(
        after.map((membership) => membership.membershipId).sort(),
        before.map((membership) => membership.membershipId).sort(),
        "the scratch group's membership changed during a dry run",
      );

      const completed = events.find((event) => event.event === "sync.completed");
      assert.ok(completed, "the run did not record sync.completed");
      assert.equal(completed.fields.pairId, INTEGRATION_PAIR_ID);
      assert.equal(completed.fields.mode, "dry-run");
    });

    it("refuses the reserved Admins group before reading or writing anything", async () => {
      const pair: SyncPair = {
        id: INTEGRATION_PAIR_ID,
        sourceGroupEmail: "group-sync-test@goodparty.org",
        targetGroupId: ADMINS_GROUP_ID,
        // Deliberately `apply`: the guard must hold on the mode that writes.
        mode: "apply",
        removalCap: { maxCount: 100, maxFraction: 1 },
        allowlist: ["@goodparty.org"],
        removalAlertThreshold: 0,
      };

      let directoryCalls = 0;
      let identityBuilds = 0;
      const directory: DirectoryClient = {
        async getGroup() {
          directoryCalls += 1;
          return {};
        },
        async listMembers() {
          directoryCalls += 1;
          return { members: [] };
        },
      };

      const { metrics } = memoryMetrics();
      const { log } = memoryLogger();
      const outcomes = await runSync({
        config: { pollIntervalSeconds: 15 * 60, pairs: [pair] },
        directory,
        identityFor: () => {
          identityBuilds += 1;
          throw new Error("the reserved-target guard must run before this");
        },
        metrics,
        log,
        now: () => Date.now(),
      });

      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].aborted?.reason, "reserved-target");
      assert.equal(directoryCalls, 0);
      assert.equal(identityBuilds, 0);
      assert.ok(RESERVED_TARGET_GROUP_IDS.includes(ADMINS_GROUP_ID));
    });
  },
);
