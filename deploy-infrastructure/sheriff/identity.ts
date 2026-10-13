/**
 * The AWS calls the break-glass tool makes into the management account, through
 * the `sheriff-grant` role.
 *
 * Step 4 resolves the requester from their Slack email and gates them on the
 * `Engineers` group, then grants by adding them to `Admins`. Everything here
 * uses the same assumed-role credentials; the Lambda's own role holds no
 * `identitystore` action, only `sts:AssumeRole` on the one `sheriff-grant` ARN
 * (see `deploy-infrastructure/sheriff-lambda.ts`).
 *
 * Region: Identity Center is a global service and its ARNs carry no region, but
 * the SDK still needs one to pick an endpoint. `us-west-2` is the region every
 * other resource in this repo uses, including the STS call into the management
 * account.
 */
import {
  ConflictException,
  CreateGroupMembershipCommand,
  DeleteGroupMembershipCommand,
  GetUserIdCommand,
  IdentitystoreClient,
  IsMemberInGroupsCommand,
  ListGroupMembershipsCommand,
  ListGroupMembershipsForMemberCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-identitystore";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

import {
  IDENTITY_STORE_ID,
  MANAGEMENT_ACCOUNT_ID,
} from "../../utils/accounts";
import { ADMINS_GROUP_ID, ENGINEERS_GROUP_ID } from "./config";

export const REGION = "us-west-2";

/** The one role the Lambda may assume. Mirrors `deploy/components/sheriff-grant.ts`. */
export const GRANT_ROLE_ARN = `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/sheriff-grant`;

/**
 * A fixed session name so CloudTrail records every assume under one
 * distinguishable name rather than `AWS-Reserved-Session` or a random string.
 */
export const GRANT_SESSION_NAME = "sheriff-grant-tool";

/** Assumes `sheriff-grant` and returns a client scoped to its credentials. */
export const assumeGrantRole = async (): Promise<IdentitystoreClient> => {
  const sts = new STSClient({ region: REGION });
  const result = await sts.send(
    new AssumeRoleCommand({
      RoleArn: GRANT_ROLE_ARN,
      RoleSessionName: GRANT_SESSION_NAME,
    }),
  );
  const credentials = result.Credentials;
  if (
    !credentials?.AccessKeyId ||
    !credentials.SecretAccessKey ||
    !credentials.SessionToken
  ) {
    throw new Error("AssumeRole returned no usable credentials");
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
 * Resolves a Slack email to an Identity Store user id.
 *
 * `emails.value` and `userName` are the only two valid `AttributePath` values;
 * the email is the one that ties the Slack identity to the directory. A miss is
 * `ResourceNotFoundException`, returned as `null` so the caller can name the
 * email in an inline error. No negative cache: the engineer decided the
 * directory is the source of truth, so a user created after a failed request
 * works on the next one.
 */
export const lookupIdentityStoreUserId = async (
  client: IdentitystoreClient,
  email: string,
): Promise<string | null> => {
  try {
    const result = await client.send(
      new GetUserIdCommand({
        IdentityStoreId: IDENTITY_STORE_ID,
        AlternateIdentifier: {
          UniqueAttribute: {
            AttributePath: "emails.value",
            AttributeValue: email,
          },
        },
      }),
    );
    return result.UserId ?? null;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return null;
    throw err;
  }
};

/** Whether the user is a member of `Engineers`, the requester gate. */
export const isEngineersMember = async (
  client: IdentitystoreClient,
  identityStoreUserId: string,
): Promise<boolean> => {
  const result = await client.send(
    new IsMemberInGroupsCommand({
      IdentityStoreId: IDENTITY_STORE_ID,
      GroupIds: [ENGINEERS_GROUP_ID],
      MemberId: { UserId: identityStoreUserId },
    }),
  );
  return (
    result.Results?.find((entry) => entry.GroupId === ENGINEERS_GROUP_ID)
      ?.MembershipExists === true
  );
};

/**
 * The `Admins` membership of a user, or null when they are not a member.
 *
 * Paginated: `ListGroupMembershipsForMember` returns a page at a time, and a
 * user in many groups can have their `Admins` membership past the first page.
 * A single-page read would miss it on the `ConflictException` recovery path and
 * fail the grant closed for exactly the users most likely to be standing
 * admins.
 */
export const resolveAdminsMembershipId = async (
  client: IdentitystoreClient,
  identityStoreUserId: string,
): Promise<string | null> => {
  let nextToken: string | undefined;
  do {
    const result = await client.send(
      new ListGroupMembershipsForMemberCommand({
        IdentityStoreId: IDENTITY_STORE_ID,
        MemberId: { UserId: identityStoreUserId },
        ...(nextToken ? { NextToken: nextToken } : {}),
      }),
    );
    const match = result.GroupMemberships?.find(
      (membership) => membership.GroupId === ADMINS_GROUP_ID,
    );
    if (match?.MembershipId) return match.MembershipId;
    nextToken = result.NextToken;
  } while (nextToken);
  return null;
};

/**
 * Adds the user to `Admins` and returns the `MembershipId`.
 *
 * `ConflictException` means the user is already a member, which is a success
 * for this tool: the member is in the group regardless of who added them, so
 * the existing membership id is resolved and returned. Any other error
 * propagates and the caller fails the grant closed.
 */
export const createAdminsMembership = async (
  client: IdentitystoreClient,
  identityStoreUserId: string,
): Promise<string> => {
  try {
    const result = await client.send(
      new CreateGroupMembershipCommand({
        IdentityStoreId: IDENTITY_STORE_ID,
        GroupId: ADMINS_GROUP_ID,
        MemberId: { UserId: identityStoreUserId },
      }),
    );
    if (!result.MembershipId) {
      throw new Error("CreateGroupMembership returned no MembershipId");
    }
    return result.MembershipId;
  } catch (err) {
    if (err instanceof ConflictException) {
      const existing = await resolveAdminsMembershipId(
        client,
        identityStoreUserId,
      );
      if (existing) return existing;
      // Eventual consistency: the conflict says the user is already a member,
      // but the member-scoped listing can lag the membership write. Fall back
      // to the group listing before giving up, so a grant is not marked failed
      // while the membership actually exists, which would leave untracked
      // Admins access the sweeper never revokes.
      const members = await listAdminsMemberships(client);
      const fromGroup = members.find(
        (member) => member.userId === identityStoreUserId,
      );
      if (fromGroup) return fromGroup.membershipId;
    }
    throw err;
  }
};

/**
 * Removes a membership by id. `ResourceNotFoundException` is the already-gone
 * case and returns false; any other error propagates so the sweeper can mark
 * the grant an orphan and alarm. Returns true when a membership was deleted.
 */
export const deleteAdminsMembership = async (
  client: IdentitystoreClient,
  membershipId: string,
): Promise<boolean> => {
  try {
    await client.send(
      new DeleteGroupMembershipCommand({
        IdentityStoreId: IDENTITY_STORE_ID,
        MembershipId: membershipId,
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return false;
    throw err;
  }
};

/** Every membership of the `Admins` group, for the sweeper. Paginated. */
export const listAdminsMemberships = async (
  client: IdentitystoreClient,
): Promise<{ userId: string; membershipId: string }[]> => {
  const members: { userId: string; membershipId: string }[] = [];
  let nextToken: string | undefined;
  do {
    const result = await client.send(
      new ListGroupMembershipsCommand({
        IdentityStoreId: IDENTITY_STORE_ID,
        GroupId: ADMINS_GROUP_ID,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }),
    );
    for (const membership of result.GroupMemberships ?? []) {
      const userId = membership.MemberId?.UserId;
      if (userId && membership.MembershipId) {
        members.push({ userId, membershipId: membership.MembershipId });
      }
    }
    nextToken = result.NextToken;
  } while (nextToken);
  return members;
};
