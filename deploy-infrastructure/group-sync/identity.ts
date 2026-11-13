/**
 * The Identity Store boundary for the group sync, steps 3, 4 and 7 of "The
 * sync algorithm" in `docs/google-group-sync.md`.
 *
 * This is the `deploy-infrastructure/sheriff/identity.ts` pattern applied to a
 * different job: assume the management-account grant role, then make every
 * directory call with the assumed credentials. The Lambda's own role holds no
 * `identitystore` action at all (`group-sync-lambda.ts`), so this file is the
 * only path to the directory.
 *
 * The caller sees an interface (`IdentityDirectory`) rather than an SDK client,
 * which is what lets `run.ts` be driven by a fake in the tests without AWS.
 * The idempotency the plan requires lives here, next to the calls it protects:
 *
 * - `GetUserId` before every create, so a user that appeared since the read is
 *   reused rather than duplicated.
 * - `ConflictException` on `CreateUser` is success *only* after a re-resolve
 *   finds the user; if it still does not, the pair aborts with `ambiguous-user`
 *   rather than adding a duplicate (non-goal 6: de-dupe on `emails.value`,
 *   which is a unique attribute).
 * - `ConflictException` on `CreateGroupMembership` means already a member and
 *   is success; `ResourceNotFoundException` on `DeleteGroupMembership` means
 *   already gone and is success. That is what makes a whole-run retry after a
 *   partial failure converge.
 *
 * Region: Identity Center is global and its ARNs carry no region, but the SDK
 * needs one to pick an endpoint. `us-west-2` is the home region, confirmed by
 * the engineer (open question 2 resolved in step 3), and the same value
 * `sheriff/identity.ts` uses.
 */
import {
  ConflictException,
  CreateGroupMembershipCommand,
  CreateUserCommand,
  DeleteGroupMembershipCommand,
  GetUserIdCommand,
  IdentitystoreClient,
  ListGroupMembershipsCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-identitystore";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

import { IDENTITY_STORE_ID, MANAGEMENT_ACCOUNT_ID } from "../../utils/accounts";
import type { TargetMembership } from "./diff";
import { SyncAbortError } from "./errors";
import type { DirectoryUserName } from "./source";

export const REGION = "us-west-2";

/** The one role the Lambda may assume. Mirrors `deploy/components/identity-group-sync-grant.ts`. */
export const GROUP_SYNC_GRANT_ROLE_ARN = `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/identity-group-sync-grant`;

/**
 * The operations the sync algorithm needs from the directory, and nothing
 * else. Everything the assumed role is *not* granted (`ListUsers`,
 * `DescribeUser`, `DeleteUser`, every group mutation) has no method here
 * either, so a future change cannot reach it without widening both.
 */
export interface IdentityDirectory {
  /** `GetUserId` on `emails.value`; `null` when the user does not exist yet. */
  resolveUserId(email: string): Promise<string | null>;
  /** Resolves, then creates if needed. Returns the user id either way. */
  createUser(email: string, name?: DirectoryUserName): Promise<string>;
  /** `CreateGroupMembership`; an existing membership is success. */
  addMembership(userId: string): Promise<void>;
  /** `DeleteGroupMembership` by membership id; already gone is success. */
  removeMembership(membershipId: string): Promise<void>;
  /** `ListGroupMemberships`, every page, before the diff is computed. */
  listMemberships(): Promise<TargetMembership[]>;
}

/** The subset of the SDK client the adapter uses, so a fake is one method. */
export type IdentityStoreClientLike = Pick<IdentitystoreClient, "send">;

/** How many times a throttled call is retried before it counts as failed. */
export const RETRY_ATTEMPTS = 4;

/** The first backoff, doubled per attempt. */
export const RETRY_BASE_MS = 200;

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether an error is throttling rather than a real failure. The Identity
 * Store API documents `ThrottlingException`, `TooManyRequestsException` and
 * the generic `RequestLimitExceeded`; the check is on the error name because
 * the SDK models differ by call and a name match is what the SDK's own
 * `retryable` classification reduces to.
 */
export const isThrottling = (err: unknown): boolean => {
  const name = (err as { name?: string } | null)?.name ?? "";
  return (
    name.includes("Throttl") ||
    name.includes("TooManyRequests") ||
    name.includes("RequestLimitExceeded")
  );
};

/** Exponential backoff on throttling only; anything else propagates at once. */
export const withRetry = async <T>(
  fn: () => Promise<T>,
  options: { attempts?: number; baseMs?: number; sleep?: Sleep } = {},
): Promise<T> => {
  const attempts = options.attempts ?? RETRY_ATTEMPTS;
  const baseMs = options.baseMs ?? RETRY_BASE_MS;
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt >= attempts || !isThrottling(err)) throw err;
      await sleep(baseMs * 2 ** (attempt - 1));
    }
  }
};

/**
 * Assumes `identity-group-sync-grant` and returns a client scoped to its
 * credentials.
 *
 * The session name is imported from the grant, not retyped: the management
 * account's CloudTrail entries are the audit record for every directory
 * mutation this job makes, and a drifting session name would break the one
 * query an incident starts with.
 */
export const assumeGrantRole = async (
  options: { sessionName: string; sts?: Pick<STSClient, "send"> },
): Promise<IdentitystoreClient> => {
  const sts = options.sts ?? new STSClient({ region: REGION });
  const result = await sts.send(
    new AssumeRoleCommand({
      RoleArn: GROUP_SYNC_GRANT_ROLE_ARN,
      RoleSessionName: options.sessionName,
    }),
  );
  const credentials = result.Credentials;
  if (
    !credentials?.AccessKeyId ||
    !credentials.SecretAccessKey ||
    !credentials.SessionToken
  ) {
    throw new SyncAbortError(
      "identity-read-failed",
      "AssumeRole returned no usable credentials",
    );
  }
  return new IdentitystoreClient({
    region: REGION,
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
  });
};

/**
 * The `DisplayName` and `Name` for a create request.
 *
 * The job prefers the user's real name from their Google public profile (open
 * question 3, resolved 2026-11-13). Every field the store is sent must be
 * non-empty: a `Name` without `FamilyName` is a `ValidationException` that
 * aborts the whole run, which is what a single-token local part used to cause.
 * So the Google name is used only when it supplies both halves, and anything
 * less falls back to `deriveDisplayName` rather than sending a half name.
 */
export type CreateUserName = {
  displayName: string;
  givenName: string;
  familyName: string;
  /** Which of the two paths produced it, for the audit log. */
  source: "google" | "derived";
};

/**
 * Derives `DisplayName` and `Name` from the email's local part.
 *
 * This is the fallback now that the job reads the real name, but it is the one
 * that runs whenever the profile read comes back empty -- contact sharing off
 * for the domain, a profile with no `familyName`, or a failed lookup -- so it
 * has to produce a valid request on its own.
 *
 * `givenName` and `familyName` are both always non-empty, because the live
 * identity store rejects a `CreateUser` whose `Name` omits `FamilyName` with a
 * `ValidationException`, which aborted every run that reached a member with a
 * single-token local part (`swain@goodparty.org`). A single token is therefore
 * duplicated into both fields: a syntactically valid placeholder the store
 * accepts, which a human corrects later if it matters. The fallback to the
 * address covers a local part that is empty or only separators (`...@`), which
 * would otherwise leave the token list empty and both fields blank.
 */
export const deriveDisplayName = (
  email: string,
): { displayName: string; givenName: string; familyName: string } => {
  const local = email.split("@")[0] ?? "";
  const tokens = local.split(/[._-]+/).filter(Boolean);
  const capitalized = tokens.map(
    (token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase(),
  );
  // A local part that is empty or only separators yields no tokens at all, so
  // the whole address becomes the placeholder rather than an empty `Name`.
  const fallback = local || email;
  const displayName = capitalized.join(" ") || fallback;
  const givenName = capitalized[0] ?? fallback;
  const familyName =
    capitalized.length > 1 ? capitalized.slice(1).join(" ") : givenName;
  return { displayName, givenName, familyName };
};

/** Trims a profile field, treating whitespace-only as absent. */
const cleaned = (value: string | null | undefined): string =>
  typeof value === "string" ? value.trim() : "";

/**
 * The name to send to `CreateUser`: the Google profile's when it carries both
 * halves, the derived one otherwise. Never returns an empty `givenName` or
 * `familyName`.
 */
export const resolveCreateUserName = (
  email: string,
  profile?: DirectoryUserName,
): CreateUserName => {
  const givenName = cleaned(profile?.givenName);
  const familyName = cleaned(profile?.familyName);
  if (givenName && familyName) {
    return {
      displayName: `${givenName} ${familyName}`,
      givenName,
      familyName,
      source: "google",
    };
  }
  return { ...deriveDisplayName(email), source: "derived" };
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const createIdentityDirectory = (options: {
  client: IdentityStoreClientLike;
  groupId: string;
  identityStoreId?: string;
  sleep?: Sleep;
}): IdentityDirectory => {
  const { client, groupId } = options;
  const identityStoreId = options.identityStoreId ?? IDENTITY_STORE_ID;
  const retryOptions = options.sleep ? { sleep: options.sleep } : {};

  const resolveUserId = async (email: string): Promise<string | null> => {
    try {
      const result = await withRetry(
        () =>
          client.send(
            new GetUserIdCommand({
              IdentityStoreId: identityStoreId,
              AlternateIdentifier: {
                UniqueAttribute: {
                  AttributePath: "emails.value",
                  AttributeValue: normalizeEmail(email),
                },
              },
            }),
          ),
        retryOptions,
      );
      return result.UserId ?? null;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw new SyncAbortError(
        "identity-read-failed",
        `GetUserId failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return {
    resolveUserId,

    async createUser(email: string, name?: DirectoryUserName): Promise<string> {
      const normalized = normalizeEmail(email);
      // Immediately before the create, not only in the caller's earlier pass:
      // a user provisioned since then is reused rather than duplicated.
      const existing = await resolveUserId(normalized);
      if (existing) return existing;

      const { displayName, givenName, familyName } = resolveCreateUserName(
        normalized,
        name,
      );
      try {
        const result = await withRetry(
          () =>
            client.send(
              new CreateUserCommand({
                IdentityStoreId: identityStoreId,
                UserName: normalized,
                DisplayName: displayName,
                // Both are always set: the store requires `FamilyName`, and
                // a create that omits it is a `ValidationException` that aborts
                // the whole run.
                Name: {
                  GivenName: givenName,
                  FamilyName: familyName,
                },
                Emails: [{ Value: normalized, Primary: true, Type: "work" }],
              }),
            ),
          retryOptions,
        );
        if (!result.UserId) {
          throw new SyncAbortError(
            "apply-failed",
            "CreateUser returned no UserId",
          );
        }
        return result.UserId;
      } catch (err) {
        if (err instanceof SyncAbortError) throw err;
        if (err instanceof ConflictException) {
          // The attribute is already in use. That is success if the user is
          // now resolvable; if it is not, the store holds an email we cannot
          // address, and adding a second user would duplicate a person.
          const again = await resolveUserId(normalized);
          if (again) return again;
          throw new SyncAbortError(
            "ambiguous-user",
            "CreateUser conflicted on emails.value but GetUserId still finds no user",
          );
        }
        throw new SyncAbortError(
          "apply-failed",
          `CreateUser failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async addMembership(userId: string): Promise<void> {
      try {
        await withRetry(
          () =>
            client.send(
              new CreateGroupMembershipCommand({
                IdentityStoreId: identityStoreId,
                GroupId: groupId,
                MemberId: { UserId: userId },
              }),
            ),
          retryOptions,
        );
      } catch (err) {
        if (err instanceof ConflictException) return;
        throw new SyncAbortError(
          "apply-failed",
          `CreateGroupMembership failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async removeMembership(membershipId: string): Promise<void> {
      try {
        await withRetry(
          () =>
            client.send(
              new DeleteGroupMembershipCommand({
                IdentityStoreId: identityStoreId,
                MembershipId: membershipId,
              }),
            ),
          retryOptions,
        );
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return;
        throw new SyncAbortError(
          "apply-failed",
          `DeleteGroupMembership failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async listMemberships(): Promise<TargetMembership[]> {
      const memberships: TargetMembership[] = [];
      let nextToken: string | undefined;
      try {
        do {
          const page = await withRetry(
            () =>
              client.send(
                new ListGroupMembershipsCommand({
                  IdentityStoreId: identityStoreId,
                  GroupId: groupId,
                  ...(nextToken ? { NextToken: nextToken } : {}),
                }),
              ),
            retryOptions,
          );
          for (const membership of page.GroupMemberships ?? []) {
            const userId = membership.MemberId?.UserId;
            const membershipId = membership.MembershipId;
            // A non-user member cannot come from a group the job manages, but
            // skipping it silently would hide one; the diff is user-keyed, so
            // anything without a user id is dropped here deliberately rather
            // than compared as an empty string.
            if (userId && membershipId) {
              memberships.push({ userId, membershipId });
            }
          }
          nextToken = page.NextToken;
        } while (nextToken);
      } catch (err) {
        throw new SyncAbortError(
          "identity-read-failed",
          `ListGroupMemberships failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // A paginated read is the whole target or nothing: a partial one would
      // compute a diff against a truncated target and add members who are
      // already there, or remove members past the page boundary next run.
      return memberships;
    },
  };
};
