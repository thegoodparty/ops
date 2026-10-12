/**
 * DynamoDB access for the break-glass dry run, single table.
 *
 * Step 3 writes request records and per-user rate counters only. Grant items
 * (the `granting`/`granted` records with a `membershipId`) arrive in step 4;
 * the key prefixes here leave room for them without a migration.
 */
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  ratePk,
  RECORD_SK,
  requestPk,
  type Decision,
  type RequestRecord,
} from "./policy";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const tableName = (): string => {
  const name = process.env.REQUEST_TABLE;
  if (!name) throw new Error("Missing REQUEST_TABLE env var");
  return name;
};

export const putRequest = async (request: RequestRecord): Promise<void> => {
  await documentClient.send(
    new PutCommand({
      TableName: tableName(),
      Item: { pk: requestPk(request.id), sk: RECORD_SK, ...request },
      // A request id is a fresh UUID; a collision means a bug, not a retry.
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );
};

export const getRequest = async (
  id: string,
): Promise<RequestRecord | null> => {
  const result = await documentClient.send(
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
export const setRequestMessageRef = async (
  id: string,
  channel: string,
  messageTs: string,
): Promise<void> => {
  await documentClient.send(
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
 * Records the decision with a conditional write on `state = requested`, so two
 * concurrent clicks cannot both decide. Returns false when the condition
 * failed, which the caller reports as "already decided".
 */
export const decideRequest = async (args: {
  id: string;
  decision: Decision;
  approverSlackId: string;
  decidedAt: string;
}): Promise<boolean> => {
  try {
    await documentClient.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { pk: requestPk(args.id), sk: RECORD_SK },
        UpdateExpression:
          "SET #state = :state, approverSlackId = :approver, decidedAt = :decidedAt, dryRun = :dryRun",
        ConditionExpression: "#state = :requested",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":state": args.decision,
          ":approver": args.approverSlackId,
          ":decidedAt": args.decidedAt,
          ":dryRun": true,
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
 * Increments the requester's counter for the UTC day and returns the new
 * value. The increment happens even when the result is over the cap, so a
 * burst is visible in the counter rather than hidden by the rejection.
 */
export const incrementRateCount = async (
  slackUserId: string,
  date: string,
  ttlSeconds: number,
): Promise<number> => {
  const result = await documentClient.send(
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

export const readRateCount = async (
  slackUserId: string,
  date: string,
): Promise<number> => {
  const result = await documentClient.send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: ratePk(slackUserId, date), sk: RECORD_SK },
    }),
  );
  return Number(result.Item?.count ?? 0);
};
