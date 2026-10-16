import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  RESERVED_TARGET_GROUP_IDS,
  type RemovalCap,
} from "./group-sync/config";
import { diff, type SourceMember, type TargetMembership } from "./group-sync/diff";
import { evaluateRemovalCap, isReservedTarget } from "./group-sync/guards";
import {
  fetchSourceMembers,
  isAllowlisted,
  SourceReadError,
  type DirectoryClient,
  type DirectoryMember,
  type DirectoryMemberPage,
  type DirectoryGroup,
} from "./group-sync/source";

// ---------------------------------------------------------------------------
// Fixtures and fakes.
//
// The Google client is a structural interface (`./group-sync/source`), so the
// tests implement it directly. Nothing here reaches Google or AWS; the point
// of step 2 is that the correctness of the job is testable without either.
// ---------------------------------------------------------------------------

const member = (
  email: string | null,
  type: string | null,
): DirectoryMember => ({ email, type });

const user = (email: string): DirectoryMember => member(email, "USER");

/** A fake Directory client driven by a queue of pages. */
const fakeDirectory = (options: {
  group?: DirectoryGroup;
  groupError?: Error;
  pages?: Array<DirectoryMemberPage | Error>;
  calls?: string[];
}): DirectoryClient => {
  const calls = options.calls ?? [];
  let pageIndex = 0;
  return {
    async getGroup(request) {
      calls.push(`getGroup:${request.groupKey}`);
      if (options.groupError) throw options.groupError;
      return options.group ?? { id: "group-1", email: request.groupKey };
    },
    async listMembers(request) {
      calls.push(
        `listMembers:${request.groupKey}:${request.pageToken ?? ""}`,
      );
      const page = options.pages?.[pageIndex++] ?? { members: [] };
      if (page instanceof Error) throw page;
      return page;
    },
  };
};

const source = (
  email: string,
  userId: string | null = null,
): SourceMember => ({ email, userId });

const target = (userId: string, membershipId: string): TargetMembership => ({
  userId,
  membershipId,
});

// The plan's worked-example cap, so the arithmetic tests read against the
// same numbers the config ships with.
const CAP: RemovalCap = { maxCount: 5, maxFraction: 0.1 };

// ---------------------------------------------------------------------------
// The pure diff, section 5.
// ---------------------------------------------------------------------------

describe("diff", () => {
  it("adds a source member with no Identity Store user yet", () => {
    const result = diff([source("alice@goodparty.org")], []);
    assert.deepEqual(result, {
      toCreate: ["alice@goodparty.org"],
      add: [source("alice@goodparty.org")],
      remove: [],
    });
  });

  it("removes a target member absent from the source", () => {
    const result = diff([], [target("u-1", "m-1")]);
    assert.deepEqual(result, {
      toCreate: [],
      add: [],
      remove: [target("u-1", "m-1")],
    });
  });

  it("computes adds and removes together", () => {
    const result = diff(
      [source("alice@goodparty.org"), source("bob@goodparty.org", "u-bob")],
      [target("u-carol", "m-carol")],
    );
    assert.deepEqual(result, {
      toCreate: ["alice@goodparty.org"],
      add: [
        source("alice@goodparty.org"),
        source("bob@goodparty.org", "u-bob"),
      ],
      remove: [target("u-carol", "m-carol")],
    });
  });

  it("is a no-op when source and target already agree", () => {
    const result = diff(
      [source("alice@goodparty.org", "u-alice")],
      [target("u-alice", "m-alice")],
    );
    assert.deepEqual(result, { toCreate: [], add: [], remove: [] });
  });

  it("removes every target membership when the source is empty", () => {
    // The empty source is a valid read of an empty group; the removal cap
    // (not the diff) is what stops it from emptying a non-empty target.
    const result = diff(
      [],
      [target("u-1", "m-1"), target("u-2", "m-2")],
    );
    assert.deepEqual(result.remove, [
      target("u-1", "m-1"),
      target("u-2", "m-2"),
    ]);
    assert.deepEqual(result.add, []);
    assert.deepEqual(result.toCreate, []);
  });

  it("adds every source member when the target is empty", () => {
    const result = diff(
      [source("alice@goodparty.org"), source("bob@goodparty.org", "u-bob")],
      [],
    );
    assert.deepEqual(result.toCreate, ["alice@goodparty.org"]);
    assert.deepEqual(result.add, [
      source("alice@goodparty.org"),
      source("bob@goodparty.org", "u-bob"),
    ]);
    assert.deepEqual(result.remove, []);
  });

  it("lists a to-create member in both toCreate and add", () => {
    // The handler creates the user from toCreate and adds it from add; the
    // plan is explicit that the same member appears in both.
    const result = diff([source("new@goodparty.org")], []);
    assert.ok(result.toCreate.includes("new@goodparty.org"));
    assert.deepEqual(result.add, [source("new@goodparty.org")]);
  });

  it("does not add a source member already in the target", () => {
    const result = diff(
      [source("alice@goodparty.org", "u-alice")],
      [target("u-alice", "m-alice")],
    );
    assert.deepEqual(result.add, []);
    assert.deepEqual(result.remove, []);
  });

  it("removes by membershipId, never by user id", () => {
    const result = diff([], [target("u-1", "m-1")]);
    assert.equal(result.remove[0].membershipId, "m-1");
  });

  it("is pure: it does not mutate its inputs", () => {
    const src = [source("alice@goodparty.org", "u-alice")];
    const tgt = [target("u-other", "m-other")];
    const srcBefore = structuredClone(src);
    const tgtBefore = structuredClone(tgt);
    diff(src, tgt);
    assert.deepEqual(src, srcBefore);
    assert.deepEqual(tgt, tgtBefore);
  });
});

// ---------------------------------------------------------------------------
// The removal cap, section 6.
// ---------------------------------------------------------------------------

describe("evaluateRemovalCap", () => {
  it("passes at the absolute bound and trips one over it", () => {
    // n == maxCount passes; n == maxCount + 1 trips. Here the absolute bound
    // is the stricter one (maxCount 5 < ceil(0.1 * 100) = 10).
    const atBound = evaluateRemovalCap(5, 100, CAP);
    assert.equal(atBound.tripped, false);
    assert.equal(atBound.allowedRemovals, 5);

    const overBound = evaluateRemovalCap(6, 100, CAP);
    assert.equal(overBound.tripped, true);
  });

  it("uses the fraction bound when it is the stricter of the two", () => {
    const cap: RemovalCap = { maxCount: 100, maxFraction: 0.1 };
    const atBound = evaluateRemovalCap(10, 100, cap);
    assert.equal(atBound.fractionBound, 10);
    assert.equal(atBound.allowedRemovals, 10);
    assert.equal(atBound.tripped, false);

    assert.equal(evaluateRemovalCap(11, 100, cap).tripped, true);
  });

  it("rounds the fraction bound up", () => {
    // ceil(0.1 * 15) = 2, not 1. A floor would allow one fewer removal than
    // the config's fraction, which is a fail-open in the wrong direction.
    const result = evaluateRemovalCap(2, 15, CAP);
    assert.equal(result.fractionBound, 2);
    assert.equal(result.tripped, false);
    assert.equal(evaluateRemovalCap(3, 15, CAP).tripped, true);
  });

  it("trips on a mass removal from an empty source against a non-empty target", () => {
    const result = evaluateRemovalCap(200, 200, CAP);
    assert.equal(result.tripped, true);
    assert.equal(result.allowedRemovals, 5);
  });

  it("trips on any removal when the fraction bound is zero", () => {
    const cap: RemovalCap = { maxCount: 5, maxFraction: 0 };
    assert.equal(evaluateRemovalCap(0, 100, cap).tripped, false);
    assert.equal(evaluateRemovalCap(1, 100, cap).tripped, true);
  });

  it("never trips on a no-removal run", () => {
    assert.equal(evaluateRemovalCap(0, 0, CAP).tripped, false);
    assert.equal(evaluateRemovalCap(0, 100, CAP).tripped, false);
  });
});

// ---------------------------------------------------------------------------
// The reserved-target guard, section 6.
// ---------------------------------------------------------------------------

describe("isReservedTarget", () => {
  it("reserves the Admins group and nothing else in the example set", () => {
    assert.equal(
      isReservedTarget("88c1b330-a001-707a-06ca-94e289013bf5"),
      true,
    );
    // The Engineers group the plan uses as its worked example is a legal
    // target.
    assert.equal(
      isReservedTarget("383193a0-7001-70d9-a321-ffe6d8af7378"),
      false,
    );
    assert.equal(isReservedTarget(""), false);
  });

  it("keeps the reserved list to the one Admins id today", () => {
    assert.deepEqual(RESERVED_TARGET_GROUP_IDS, [
      "88c1b330-a001-707a-06ca-94e289013bf5",
    ]);
  });

  // The literal is duplicated from identity-center.ts because the group is
  // created out of band and that file does not export its group map. Read the
  // source so the two cannot drift silently, the way sheriff-grant.test.ts
  // does. A future sheriff-managed group has to be added to both.
  it("mirrors the Admins group id in identity-center.ts", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../deploy/components/identity-center.ts"),
      "utf8",
    );
    assert.match(source, /Admins: "88c1b330-a001-707a-06ca-94e289013bf5"/);
    assert.ok(
      RESERVED_TARGET_GROUP_IDS.includes(
        "88c1b330-a001-707a-06ca-94e289013bf5",
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// The Google read adapter, section 2: "completely or not at all".
// ---------------------------------------------------------------------------

describe("isAllowlisted", () => {
  it("matches a domain entry against the exact domain, case-insensitively", () => {
    assert.equal(isAllowlisted("Alice@GoodParty.org", ["@goodparty.org"]), true);
    assert.equal(isAllowlisted("alice@goodparty.org", ["@goodparty.org"]), true);
    assert.equal(isAllowlisted("alice@evil.org", ["@goodparty.org"]), false);
    // A suffix match on the bare string would wrongly admit this.
    assert.equal(isAllowlisted("alice@notgoodparty.org", ["@goodparty.org"]), false);
    assert.equal(isAllowlisted("alice@sub.goodparty.org", ["@goodparty.org"]), false);
  });

  it("matches a full-address entry exactly", () => {
    assert.equal(
      isAllowlisted("alice@goodparty.org", ["alice@goodparty.org"]),
      true,
    );
    assert.equal(
      isAllowlisted("bob@goodparty.org", ["alice@goodparty.org"]),
      false,
    );
  });

  it("ignores blank entries", () => {
    assert.equal(isAllowlisted("alice@goodparty.org", ["", "  "]), false);
  });
});

describe("fetchSourceMembers", () => {
  const GROUP = "engineers@goodparty.org";
  const ALLOW = ["@goodparty.org"];

  it("reads every page, lowercases and dedupes", async () => {
    const calls: string[] = [];
    const client = fakeDirectory({
      pages: [
        {
          members: [user("Alice@GoodParty.org"), user("bob@goodparty.org")],
          nextPageToken: "page-2",
        },
        {
          members: [user("ALICE@goodparty.org"), user("carol@goodparty.org")],
        },
      ],
      calls,
    });

    const result = await fetchSourceMembers({
      client,
      groupEmail: GROUP,
      allowlist: ALLOW,
    });

    assert.deepEqual(result.emails, [
      "alice@goodparty.org",
      "bob@goodparty.org",
      "carol@goodparty.org",
    ]);
    assert.deepEqual(result.skipped, []);
    // The pageToken loop follows the token and then stops.
    assert.deepEqual(calls, [
      `getGroup:${GROUP}`,
      `listMembers:${GROUP}:`,
      `listMembers:${GROUP}:page-2`,
    ]);
  });

  it("treats an empty group as an empty source, not a failure", async () => {
    const client = fakeDirectory({ pages: [{ members: [] }] });
    const result = await fetchSourceMembers({
      client,
      groupEmail: GROUP,
      allowlist: ALLOW,
    });
    assert.deepEqual(result, { emails: [], skipped: [] });
  });

  it("skips a nested GROUP member as out of scope", async () => {
    const client = fakeDirectory({
      pages: [
        {
          members: [
            user("alice@goodparty.org"),
            member("nested@goodparty.org", "GROUP"),
          ],
        },
      ],
    });
    const result = await fetchSourceMembers({
      client,
      groupEmail: GROUP,
      allowlist: ALLOW,
    });
    assert.deepEqual(result.emails, ["alice@goodparty.org"]);
    assert.deepEqual(result.skipped, [
      { type: "GROUP", reason: "nested-group", domain: "goodparty.org" },
    ]);
  });

  it("skips an EXTERNAL member as out of scope", async () => {
    const client = fakeDirectory({
      pages: [
        {
          members: [
            user("alice@goodparty.org"),
            member("contractor@outside.example", "EXTERNAL"),
          ],
        },
      ],
    });
    const result = await fetchSourceMembers({
      client,
      groupEmail: GROUP,
      allowlist: ALLOW,
    });
    assert.deepEqual(result.emails, ["alice@goodparty.org"]);
    assert.deepEqual(result.skipped, [
      { type: "EXTERNAL", reason: "external", domain: "outside.example" },
    ]);
  });

  it("skips a member outside the allowlist and logs only its domain", async () => {
    const client = fakeDirectory({
      pages: [
        {
          members: [
            user("alice@goodparty.org"),
            user("outsider@elsewhere.example"),
          ],
        },
      ],
    });
    const result = await fetchSourceMembers({
      client,
      groupEmail: GROUP,
      allowlist: ALLOW,
    });
    assert.deepEqual(result.emails, ["alice@goodparty.org"]);
    assert.deepEqual(result.skipped, [
      {
        type: "USER",
        reason: "not-allowlisted",
        domain: "elsewhere.example",
      },
    ]);
    // The skip record carries no local part.
    assert.ok(!JSON.stringify(result.skipped).includes("outsider"));
  });

  it("aborts when the group cannot be read", async () => {
    const client = fakeDirectory({
      groupError: new Error("404 notFound"),
    });
    await assert.rejects(
      fetchSourceMembers({ client, groupEmail: GROUP, allowlist: ALLOW }),
      (err: unknown) => {
        assert.ok(err instanceof SourceReadError);
        assert.equal(err.reason, "source-read-failed");
        return true;
      },
    );
  });

  it("aborts on a CUSTOMER (domain-wide) member", async () => {
    const client = fakeDirectory({
      pages: [{ members: [member(null, "CUSTOMER")] }],
    });
    await assert.rejects(
      fetchSourceMembers({ client, groupEmail: GROUP, allowlist: ALLOW }),
      (err: unknown) => {
        assert.ok(err instanceof SourceReadError);
        assert.equal(err.reason, "domain-wide-membership");
        return true;
      },
    );
  });

  it("aborts on a USER member with no email", async () => {
    const client = fakeDirectory({
      pages: [{ members: [member(null, "USER")] }],
    });
    await assert.rejects(
      fetchSourceMembers({ client, groupEmail: GROUP, allowlist: ALLOW }),
      (err: unknown) => {
        assert.ok(err instanceof SourceReadError);
        assert.equal(err.reason, "domain-wide-membership");
        return true;
      },
    );
  });

  it("aborts on an unknown member type rather than dropping it", async () => {
    // Skipping a type that turns out to carry users would compute a source
    // set missing people and then mass-remove them. Fail closed.
    const client = fakeDirectory({
      pages: [{ members: [member("x@goodparty.org", "SOMETHING_NEW")] }],
    });
    await assert.rejects(
      fetchSourceMembers({ client, groupEmail: GROUP, allowlist: ALLOW }),
      (err: unknown) => {
        assert.ok(err instanceof SourceReadError);
        assert.equal(err.reason, "source-read-failed");
        return true;
      },
    );
  });

  it("aborts the whole read when a later page throws, discarding the pages already read", async () => {
    // The single most important test in the job: a partially paginated read
    // must never become a source set, because a source set missing people is
    // a mass removal. The handler-level assertion that this produces no
    // CreateUser/CreateGroupMembership/DeleteGroupMembership call is step 3;
    // here the property is that the adapter rejects and yields nothing.
    const calls: string[] = [];
    const client = fakeDirectory({
      pages: [
        {
          members: [user("alice@goodparty.org")],
          nextPageToken: "page-2",
        },
        new Error("500 backendError"),
      ],
      calls,
    });

    await assert.rejects(
      fetchSourceMembers({ client, groupEmail: GROUP, allowlist: ALLOW }),
      (err: unknown) => {
        assert.ok(err instanceof SourceReadError);
        assert.equal(err.reason, "source-read-failed");
        return true;
      },
    );
    // The second page was attempted, so the failure is mid-chain, not a
    // short-circuit before pagination.
    assert.deepEqual(calls, [
      `getGroup:${GROUP}`,
      `listMembers:${GROUP}:`,
      `listMembers:${GROUP}:page-2`,
    ]);
  });

  it("keeps paginating through a page with no members but a token", async () => {
    const client = fakeDirectory({
      pages: [
        { members: [], nextPageToken: "page-2" },
        { members: [user("alice@goodparty.org")] },
      ],
    });
    const result = await fetchSourceMembers({
      client,
      groupEmail: GROUP,
      allowlist: ALLOW,
    });
    assert.deepEqual(result.emails, ["alice@goodparty.org"]);
  });
});
