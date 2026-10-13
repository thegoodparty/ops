/**
 * DynamoDB access for the break-glass tool, single table.
 *
 * Request items, grant items, per-user active-grant locks and per-user rate
 * counters share the table. Grants live under a fixed partition (`GRANT`) so
 * the sweeper can `Query` them all; the active-grant lock is a per-requester
 * item whose conditional write is the race-safe "at most one active grant"
 * guard.
 *
 * The client is injected so the tests can drive the conditional write and the
 * key shapes with a fake, the same `createStore` pattern
 * `delegate/review/store.ts` uses.
 */
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  activePk,
  GRANT_PK,
  grantSk,
  ratePk,
  RECORD_SK,
  requestPk,
  type Decision,
  type GrantRecord,
  type GrantState,
  type RequestRecord,
  type RequestState,
} from "./policy";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const tableName = (): string => {
  const name = process.env.REQUEST_TABLE;
  if (!name) throw new Error("Missing REQUEST_TABLE env var");
  return name;
};

export const createStore = (
  client: DynamoDBDocumentClient = documentClient,
) => {
  const putRequest = async (request: RequestRecord): Promise<void> => {
    await client.send(
      new PutCommand({
        TableName: tableName(),
        Item: { pk: requestPk(request.id), sk: RECORD_SK, ...request },
        // A request id is a fresh UUID; a collision means a bug, not a retry.
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  };

  const getRequest = async (id: string): Promise<RequestRecord | null> => {
    const result = await client.send(
      new GetCommand({
        TableName: tableName(),
        Key: { pk: requestPk(id), sk: RECORD_SK },
      }),
    );
    if (!result.Item) return null;
    const { pk: _pk, sk: _sk, ...request } = result.Item;
    return request as RequestRecord;
  };

  /** Stamped after the approval post so a decision can update that message. */
  const setRequestMessageRef = async (
    id: string,
    channel: string,
    messageTs: string,
  ): Promise<void> => {
    await client.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { pk: requestPk(id), sk: RECORD_SK },
        UpdateExpression: "SET #channel = :channel, #messageTs = :messageTs",
        ExpressionAttributeNames: {
          "#channel": "channel",
          "#messageTs": "messageTs",
        },
        ExpressionAttributeValues: {
          ":channel": channel,
          ":messageTs": messageTs,
        },
      }),
    );
  };

  /**
   * Records the decision with a conditional write on `state = requested`, so
   * two concurrent clicks cannot both decide. An approval moves the request to
   * `granting`, not to the dry-run `approved`. Returns false when the condition
   * failed, which the caller reports as "already decided".
   */
  const decideRequest = async (args: {
    id: string;
    decision: Decision;
    approverSlackId: string;
    decidedAt: string;
  }): Promise<boolean> => {
    const state: RequestState =
      args.decision === "approved" ? "granting" : "denied";
    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName(),
          Key: { pk: requestPk(args.id), sk: RECORD_SK },
          UpdateExpression:
            "SET #state = :state, approverSlackId = :approver, decidedAt = :decidedAt",
          ConditionExpression: "#state = :requested",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":state": state,
            ":approver": args.approverSlackId,
            ":decidedAt": args.decidedAt,
            ":requested": "requested",
          },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  };

  /**
   * Follows a request through the grant lifecycle (`granted`, `revoked`,
   * `failed`).
   *
   * `fromState` makes the write conditional, so a sweeper that computed its
   * plan against an older state cannot clobber a record that changed in the
   * meantime. Returns false when the condition failed; the caller treats that
   * as "someone else moved it" and skips the rest of its transition.
   */
  const setRequestState = async (
    id: string,
    state: RequestState,
    fromState?: RequestState | RequestState[],
  ): Promise<boolean> => {
    const names: Record<string, string> = { "#state": "state" };
    const values: Record<string, string> = { ":state": state };
    let condition = "attribute_exists(pk)";
    if (fromState) {
      const froms = Array.isArray(fromState) ? fromState : [fromState];
      froms.forEach((from, index) => {
        values[`:from${index}`] = from;
      });
      condition = `#state IN (${froms
        .map((_from, index) => `:from${index}`)
        .join(", ")})`;
    }
    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName(),
          Key: { pk: requestPk(id), sk: RECORD_SK },
          UpdateExpression: "SET #state = :state",
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  };

  /**
   * Increments the requester's counter for the UTC day and returns the new
   * value. The increment happens even when the result is over the cap, so a
   * burst is visible in the counter rather than hidden by the rejection.
   */
  const incrementRateCount = async (
    slackUserId: string,
    date: string,
    ttlSeconds: number,
  ): Promise<number> => {
    const result = await client.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { pk: ratePk(slackUserId, date), sk: RECORD_SK },
        UpdateExpression: "ADD #count :one SET #ttl = :ttl",
        ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
        ExpressionAttributeValues: {
          ":one": 1,
          ":ttl": Math.floor(Date.now() / 1000) + ttlSeconds,
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return Number(result.Attributes?.count ?? 0);
  };

  /**
   * The at-most-one-active-grant guard.
   *
   * One per-requester item, claimed with `attribute_not_exists(pk) OR state =
   * released`. The `OR` lets a new grant reuse the key after a revoke or a
   * failure without deleting the item. The condition is evaluated by DynamoDB
   * atomically, so two concurrent approvals for the same requester cannot both
   * pass: without this the second `CreateGroupMembership` would return
   * `ConflictException`, both grants would resolve the same `MembershipId`, and
   * the first expiry would silently end the second grant early.
   */
  const beginActiveGrant = async (
    identityStoreUserId: string,
    requestId: string,
  ): Promise<boolean> => {
    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName(),
          Key: { pk: activePk(identityStoreUserId), sk: RECORD_SK },
          UpdateExpression:
            "SET #state = :active, requestId = :requestId, updatedAt = :now",
          ConditionExpression:
            "attribute_not_exists(pk) OR #state = :released",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":active": "active",
            ":released": "released",
            ":requestId": requestId,
            ":now": new Date().toISOString(),
          },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  };

  /** Marks the active-grant lock released so a new grant may claim it. */
  const releaseActiveGrant = async (
    identityStoreUserId: string,
  ): Promise<void> => {
    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName(),
          Key: { pk: activePk(identityStoreUserId), sk: RECORD_SK },
          UpdateExpression: "SET #state = :released, updatedAt = :now",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":released": "released",
            ":now": new Date().toISOString(),
          },
        }),
      );
    } catch (err) {
      // Nothing to release is the already-released case.
      if (err instanceof ConditionalCheckFailedException) return;
      throw err;
    }
  };

  const getActiveGrant = async (
    identityStoreUserId: string,
  ): Promise<{ requestId?: string; state?: string } | null> => {
    const result = await client.send(
      new GetCommand({
        TableName: tableName(),
        Key: { pk: activePk(identityStoreUserId), sk: RECORD_SK },
      }),
    );
    return result.Item ?? null;
  };

  /**
   * Writes the grant record in its `granting` state, before the membership
   * exists. The request id is fresh, so the condition only guards a bug.
   */
  const putGrant = async (grant: GrantRecord): Promise<void> => {
    await client.send(
      new PutCommand({
        TableName: tableName(),
        Item: { pk: GRANT_PK, sk: grantSk(grant.requestId), ...grant },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  };

  /**
   * Flips a grant record's state, optionally recording the `membershipId`.
   *
   * `fromState` is the conditional guard the sweeper uses so it cannot clobber
   * a record the approve path moved after the plan was computed. Returns false
   * when the condition failed.
   */
  const setGrantState = async (args: {
    requestId: string;
    state: GrantState;
    membershipId?: string;
    fromState?: GrantState | GrantState[];
  }): Promise<boolean> => {
    const names: Record<string, string> = { "#state": "state" };
    const values: Record<string, string> = {
      ":state": args.state,
      ":updatedAt": new Date().toISOString(),
    };
    const sets = ["#state = :state", "updatedAt = :updatedAt"];
    if (args.membershipId) {
      sets.push("membershipId = :membershipId");
      values[":membershipId"] = args.membershipId;
    }
    let condition = "attribute_exists(pk)";
    if (args.fromState) {
      const froms = Array.isArray(args.fromState)
        ? args.fromState
        : [args.fromState];
      froms.forEach((from, index) => {
        values[`:from${index}`] = from;
      });
      condition = `#state IN (${froms
        .map((_from, index) => `:from${index}`)
        .join(", ")})`;
    }
    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName(),
          Key: { pk: GRANT_PK, sk: grantSk(args.requestId) },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  };

  /**
   * Claims the one approval-message post for a request. The async
   * `post-request` invocation is at-least-once, so this conditional write makes
   * the post at-most-once: a duplicate delivery sees the claim and returns
   * without posting a second message with live buttons.
   */
  const claimRequestPost = async (id: string): Promise<boolean> => {
    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName(),
          Key: { pk: requestPk(id), sk: RECORD_SK },
          UpdateExpression: "SET #postClaimed = :true",
          ConditionExpression: "attribute_not_exists(#postClaimed)",
          ExpressionAttributeNames: { "#postClaimed": "postClaimed" },
          ExpressionAttributeValues: { ":true": true },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  };

  /** Clears the post claim after a failed post, so an async retry can post. */
  const releaseRequestPost = async (id: string): Promise<void> => {
    await client.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { pk: requestPk(id), sk: RECORD_SK },
        UpdateExpression: "REMOVE #postClaimed",
        ExpressionAttributeNames: { "#postClaimed": "postClaimed" },
      }),
    );
  };

  /** Every grant record, for the sweeper. Paginated. */
  const listGrants = async (): Promise<GrantRecord[]> => {
    const grants: GrantRecord[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName(),
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": GRANT_PK },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      for (const item of result.Items ?? []) {
        const { pk: _pk, sk: _sk, ...grant } = item;
        grants.push(grant as GrantRecord);
      }
      startKey = result.LastEvaluatedKey;
    } while (startKey);
    return grants;
  };

  return {
    putRequest,
    getRequest,
    setRequestMessageRef,
    decideRequest,
    setRequestState,
    incrementRateCount,
    beginActiveGrant,
    releaseActiveGrant,
    getActiveGrant,
    putGrant,
    setGrantState,
    listGrants,
    claimRequestPost,
    releaseRequestPost,
  };
};

export const store = createStore();

export const {
  putRequest,
  getRequest,
  setRequestMessageRef,
  decideRequest,
  setRequestState,
  incrementRateCount,
  beginActiveGrant,
  releaseActiveGrant,
  getActiveGrant,
  putGrant,
  setGrantState,
  listGrants,
  claimRequestPost,
  releaseRequestPost,
} = store;
