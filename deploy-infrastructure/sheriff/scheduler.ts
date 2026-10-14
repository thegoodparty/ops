/**
 * EventBridge Scheduler one-shot management for the break-glass tool, step 5
 * ("scheduled revocation") of `docs/sheriff.md`.
 *
 * One schedule per grant, fired at the grant's `expiresAt`, invoking the same
 * sheriff Lambda with `{ action: "revoke", requestId }`. The schedule carries a
 * retry policy and a dead-letter queue, so a transient revoke failure is
 * retried and, once the attempts are exhausted, captured rather than lost. The
 * step-4 sweeper stays as the backstop.
 *
 * The Lambda's own role holds `scheduler:CreateSchedule`, `GetSchedule` and
 * `DeleteSchedule` scoped to the one schedule group, plus `iam:PassRole` on the
 * one schedule-execution role. The execution role is what invokes the function
 * and writes the DLQ; the Lambda never assumes it. See
 * `deploy-infrastructure/sheriff-lambda.ts`.
 *
 * The client is injectable so the tests can drive the create/get/delete
 * commands and the already-exists and already-gone paths without AWS, the same
 * `createStore` pattern `store.ts` uses.
 */
import {
  ActionAfterCompletion,
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  FlexibleTimeWindowMode,
  GetScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  ScheduleState,
} from "@aws-sdk/client-scheduler";

import {
  SCHEDULE_MAX_EVENT_AGE_SECONDS,
  SCHEDULE_MAX_RETRY_ATTEMPTS,
} from "./config";
import { REGION } from "./identity";
import {
  expiryScheduleName,
  scheduleAtExpression,
  type GrantRecord,
} from "./policy";

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} env var`);
  return value;
};

export const createScheduler = (
  client: SchedulerClient = new SchedulerClient({ region: REGION }),
) => {
  const scheduleGroup = () => requireEnv("SCHEDULE_GROUP");
  const functionArn = () => requireEnv("FUNCTION_ARN");
  const scheduleRoleArn = () => requireEnv("SCHEDULE_ROLE_ARN");
  const scheduleDlqArn = () => requireEnv("SCHEDULE_DLQ_ARN");

  /**
   * Whether a schedule already exists. `GetSchedule`'s only job is to make
   * `createExpirySchedule` idempotent without relying on an error for the
   * common case; the create still tolerates a lost race.
   */
  const expiryScheduleExists = async (name: string): Promise<boolean> => {
    try {
      await client.send(
        new GetScheduleCommand({ Name: name, GroupName: scheduleGroup() }),
      );
      return true;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return false;
      throw err;
    }
  };

  /**
   * Creates the one-shot revoke schedule for a grant at its `expiresAt`, if it
   * does not already exist. Idempotent: a retry, or the sweeper recovering a
   * `granting` record whose approve path crashed before scheduling, sees the
   * schedule and returns.
   *
   * `ActionAfterCompletion: DELETE` removes the schedule once it has fired, so
   * the normal path leaves nothing behind. The explicit delete in
   * `deleteExpirySchedule` covers an early revoke and a failed schedule.
   */
  const createExpirySchedule = async (
    grant: GrantRecord,
  ): Promise<string> => {
    const name = grant.scheduleName ?? expiryScheduleName(grant.requestId);
    if (await expiryScheduleExists(name)) return name;
    try {
      await client.send(
        new CreateScheduleCommand({
          Name: name,
          GroupName: scheduleGroup(),
          Description: `Break-glass expiry for request ${grant.requestId}`,
          ScheduleExpression: scheduleAtExpression(grant.expiresAt),
          // `at()` is evaluated in this timezone; the ISO timestamp is UTC.
          ScheduleExpressionTimezone: "UTC",
          FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
          ActionAfterCompletion: ActionAfterCompletion.DELETE,
          State: ScheduleState.ENABLED,
          Target: {
            Arn: functionArn(),
            RoleArn: scheduleRoleArn(),
            Input: JSON.stringify({
              action: "revoke",
              requestId: grant.requestId,
            }),
            RetryPolicy: {
              MaximumEventAgeInSeconds: SCHEDULE_MAX_EVENT_AGE_SECONDS,
              MaximumRetryAttempts: SCHEDULE_MAX_RETRY_ATTEMPTS,
            },
            DeadLetterConfig: { Arn: scheduleDlqArn() },
          },
        }),
      );
    } catch (err) {
      // A concurrent create won the race. The name is deterministic and the
      // target is identical, so the existing schedule is the one we wanted.
      if (err instanceof ConflictException) return name;
      throw err;
    }
    return name;
  };

  /**
   * Deletes a grant's expiry schedule. `ResourceNotFoundException` is the
   * already-gone case -- the schedule fired and `ActionAfterCompletion: DELETE`
   * removed it, or an earlier revoke deleted it -- and is treated as success,
   * so a double revoke is harmless and schedules do not accumulate.
   */
  const deleteExpirySchedule = async (grant: GrantRecord): Promise<void> => {
    const name = grant.scheduleName ?? expiryScheduleName(grant.requestId);
    try {
      await client.send(
        new DeleteScheduleCommand({ Name: name, GroupName: scheduleGroup() }),
      );
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return;
      throw err;
    }
  };

  return { expiryScheduleExists, createExpirySchedule, deleteExpirySchedule };
};

export const scheduler = createScheduler();

export const {
  expiryScheduleExists,
  createExpirySchedule,
  deleteExpirySchedule,
} = scheduler;
