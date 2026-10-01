// Entry point of the "sqlrunner" container. Same image as the Boss, its own
// process, its own log group, and the only place the gp-api read-only
// password exists. See CLAUDE.md.

import { serve } from "@hono/node-server";

import { makeAlarm, makeLog } from "../logging";
import { createPgExecutor } from "./execute";
import { createSqlRunner } from "./runner";
import { createSqlRunnerSlack } from "./slack";

const log = makeLog("sqlrunner");
const alarm = makeAlarm("sqlrunner");

const DEFAULT_PORT = 8790;
const POLL_INTERVAL_MS = 10_000;

const fail = (message: string): never => {
  alarm("boot_failed", { error: message });
  process.exit(1);
};

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value) return fail(`${name} is not set`);
  return value;
};

// The same merge the Boss's settingsEnv does, blob wins. Copied rather than
// imported: index.ts is the Boss's composition root and would pull the whole
// Boss into this process.
const mergedEnv = (): NodeJS.ProcessEnv => {
  const blob = required(process.env, "BUGBOSS_SECRETS");
  let parsed: Record<string, string | undefined>;
  try {
    parsed = JSON.parse(blob) as Record<string, string | undefined>;
  } catch {
    return fail("BUGBOSS_SECRETS is not valid JSON");
  }
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
};

const main = () => {
  const env = mergedEnv();
  const port = Number(env.SQL_RUNNER_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail("SQL_RUNNER_PORT is not a port number");
  }

  const db = {
    host: required(env, "GP_API_READONLY_DB_HOST"),
    database: required(env, "GP_API_READONLY_DB_NAME"),
    user: required(env, "GP_API_READONLY_DB_USER"),
    password: required(env, "GP_API_READONLY_DB_PASSWORD"),
  };
  const token = required(env, "SLACK_BOT_TOKEN");
  const channelId = required(env, "BUGBOSS_SLACK_CHANNEL_ID");
  const botUserId = required(env, "SLACK_BOT_USER_ID");
  const rotationGroupId = env.SLACK_ROTATION_GROUP_ID || null;
  if (!rotationGroupId) {
    // Not fatal: the Boss still runs, and every request answers 503 saying
    // why. But it means the tool cannot work, so it is said at boot.
    alarm("rotation_group_unset", {});
  }

  const runner = createSqlRunner({
    slack: createSqlRunnerSlack(token),
    execute: createPgExecutor(db),
    channelId,
    botUserId,
    rotationGroupId,
  });

  const server = serve(
    { fetch: runner.app.fetch, port, hostname: "127.0.0.1" },
    () => log("listening", { port }),
  );

  const loop = setInterval(() => {
    runner.tick().catch((err: unknown) =>
      alarm("tick_failed", { error: err instanceof Error ? err.message : String(err) }),
    );
  }, POLL_INTERVAL_MS);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      clearInterval(loop);
      server.close();
      process.exit(0);
    });
  }
};

if (require.main === module) {
  const die = (event: string) => (error: unknown) => {
    alarm(event, {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    process.exit(1);
  };
  process.on("unhandledRejection", die("unhandled_rejection"));
  process.on("uncaughtException", die("uncaught_exception"));
  main();
}
