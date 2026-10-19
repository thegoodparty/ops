/**
 * The Google Workspace read adapter for the group sync, section 2 of
 * `docs/google-group-sync.md`: "Fetch the source, completely or not at all".
 *
 * This is the guard the whole job hangs on. A strict mirror empties a group
 * only if the source read says the group is empty, so a failed read, a
 * partially paginated read or a member that cannot be represented by email
 * must abort the pair rather than produce a source set that is missing
 * people. `fetchSourceMembers` therefore either resolves with the complete
 * effective source or throws `SourceReadError`; it never resolves with a
 * partial result.
 *
 * The plan keeps the Google read behind one module so the open question about
 * which API the org's edition serves (Admin SDK Directory vs Cloud Identity,
 * open question 1) is a one-file change. That is why the client is a
 * structural interface here and not the `googleapis` types: step 3 supplies a
 * thin wrapper over the real client, and the tests supply a fake. This module
 * imports no Google or AWS dependency.
 *
 * `fetchSourceMembers` stops at the source set. Resolving emails to Identity
 * Store user ids is step 3, and `diff` (in `./diff`) is a separate pure
 * module.
 */
import type { SyncAbortReason } from "./config";

/** The member types the Directory API documents, per non-goal 2 of the plan. */
export type GoogleMemberType = "USER" | "GROUP" | "CUSTOMER" | "EXTERNAL";

export type DirectoryMember = {
  email?: string | null;
  /** `Member.type`; the API documents the four values above. */
  type?: string | null;
};

export type DirectoryMemberPage = {
  members: DirectoryMember[];
  nextPageToken?: string | null;
};

export type DirectoryGroup = {
  id?: string | null;
  email?: string | null;
};

/**
 * The slice of the Admin SDK Directory API this job reads. `googleapis`
 * exposes `directory.groups.get` and `directory.members.list`; step 3 adapts
 * them to this shape, and the tests implement it directly.
 */
export interface DirectoryClient {
  getGroup(request: { groupKey: string }): Promise<DirectoryGroup>;
  listMembers(request: {
    groupKey: string;
    pageToken?: string;
  }): Promise<DirectoryMemberPage>;
}

/** The reasons the read itself can abort a pair. */
export type SourceAbortReason =
  | "source-read-failed"
  | "domain-wide-membership";

/** A member filtered out of the source, for `member.skipped` logging. */
export type SkippedMember = {
  /** The Google `Member.type`, or `USER` for an allowlist skip. */
  type: string;
  reason: "nested-group" | "external" | "not-allowlisted";
  /**
   * The member's domain only, never the local part. The plan's logging rule
   * is that membership is personal data and the logs say so by not containing
   * it, so the adapter hands the caller something safe to log rather than an
   * address it might.
   */
  domain: string;
};

export type SourceReadResult = {
  /** The effective source set: lowercased, deduped and allowlisted. */
  emails: string[];
  /** Members the read filtered out. Never a full member list. */
  skipped: SkippedMember[];
};

/**
 * Thrown when the pair must abort and change nothing. The reason is the
 * `sync.aborted` reason the handler logs and dimensions the `Aborted` metric
 * by, so it is typed rather than a bare string.
 */
export class SourceReadError extends Error {
  readonly reason: SourceAbortReason;

  constructor(reason: SourceAbortReason, message: string) {
    super(message);
    this.name = "SourceReadError";
    this.reason = reason;
  }
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** Trims and lowercases; the plan lowercases the source set before diffing. */
const normalizeEmail = (email: string | null | undefined): string =>
  (email ?? "").trim().toLowerCase();

/** The domain of an email, for a log line that carries no local part. */
const domainOf = (email: string | null | undefined): string => {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf("@");
  return at >= 0 ? normalized.slice(at + 1) : "";
};

/**
 * Whether an email is covered by the allowlist. An entry is either a full
 * address or a domain written with a leading `@` (`@goodparty.org`). Matching
 * is case-insensitive, and a domain entry matches only that exact domain:
 * `@goodparty.org` does not cover `@sub.goodparty.org`.
 */
export const isAllowlisted = (email: string, allowlist: string[]): boolean => {
  const normalized = normalizeEmail(email);
  return allowlist.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    if (!candidate) return false;
    return candidate.startsWith("@")
      ? normalized.endsWith(candidate)
      : normalized === candidate;
  });
};

/**
 * Reads one Google group's members completely, or not at all.
 *
 * The sequence, from section 2 of the plan:
 *
 * 1. `groups.get`: a miss aborts. A typo in the config must not read as "the
 *    group is empty", which is the difference between "no change" and
 *    "remove everyone".
 * 2. `members.list` with the `pageToken` loop, following `nextPageToken`
 *    until it is absent. Every page is accumulated in memory and nothing is
 *    returned until the chain is exhausted, so a throw on page two discards
 *    the pages already read.
 * 3. Partition by `Member.type`. `USER` members are kept; `GROUP` and
 *    `EXTERNAL` are out of scope and are skipped and logged; a `CUSTOMER`
 *    member carries no email and would silently shrink the source set, so it
 *    aborts the pair; a `USER` member with no email cannot be represented in
 *    an email-keyed source set, so it aborts too.
 * 4. Lowercase and dedupe the kept emails.
 * 5. Apply the allowlist, skipping and logging anything not covered.
 *
 * An unknown member type is not one of the four the API documents; it is
 * treated as a failed read rather than skipped, because skipping a type that
 * turns out to carry users would compute a source set missing people and then
 * mass-remove them. Failing closed is the only safe reading.
 */
export const fetchSourceMembers = async ({
  client,
  groupEmail,
  allowlist,
}: {
  client: DirectoryClient;
  groupEmail: string;
  allowlist: string[];
}): Promise<SourceReadResult> => {
  try {
    await client.getGroup({ groupKey: groupEmail });
  } catch (err) {
    throw new SourceReadError(
      "source-read-failed",
      `groups.get failed for ${groupEmail}: ${errorMessage(err)}`,
    );
  }

  const rawMembers: DirectoryMember[] = [];
  let pageToken: string | undefined;
  try {
    do {
      const page = await client.listMembers({
        groupKey: groupEmail,
        ...(pageToken ? { pageToken } : {}),
      });
      rawMembers.push(...(page.members ?? []));
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    // Nothing accumulated above is returned: the caller sees only the throw,
    // so a partially paginated read can never become a source set.
    throw new SourceReadError(
      "source-read-failed",
      `members.list failed for ${groupEmail}: ${errorMessage(err)}`,
    );
  }

  const skipped: SkippedMember[] = [];
  const userEmails: string[] = [];

  for (const member of rawMembers) {
    const type = member.type ?? "";
    switch (type) {
      case "USER": {
        const email = normalizeEmail(member.email);
        if (!email) {
          throw new SourceReadError(
            "domain-wide-membership",
            `USER member of ${groupEmail} has no email`,
          );
        }
        userEmails.push(email);
        break;
      }
      case "GROUP":
        skipped.push({
          type,
          reason: "nested-group",
          domain: domainOf(member.email),
        });
        break;
      case "EXTERNAL":
        skipped.push({
          type,
          reason: "external",
          domain: domainOf(member.email),
        });
        break;
      case "CUSTOMER":
        // No email and a whole domain of users; dropping it would compute a
        // source set that omits the domain and then mass-remove the target.
        // Refusing is the only handling that keeps "never empty a group by
        // accident" true (non-goal 2).
        throw new SourceReadError(
          "domain-wide-membership",
          `${groupEmail} has a CUSTOMER member (domain-wide); refusing to diff against a source that cannot be expanded`,
        );
      default:
        throw new SourceReadError(
          "source-read-failed",
          `${groupEmail} has a member with unknown type ${JSON.stringify(type)}`,
        );
    }
  }

  // Lowercase (done above) and dedupe, preserving first-seen order so the
  // diff and the audit log are deterministic.
  const deduped = [...new Set(userEmails)];

  const emails: string[] = [];
  for (const email of deduped) {
    if (!isAllowlisted(email, allowlist)) {
      skipped.push({
        type: "USER",
        reason: "not-allowlisted",
        domain: domainOf(email),
      });
      continue;
    }
    emails.push(email);
  }

  return { emails, skipped };
};
