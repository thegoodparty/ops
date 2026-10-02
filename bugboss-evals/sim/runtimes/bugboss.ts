import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

import { asUser } from "../run";
import type { Runtime, RuntimeBuild } from "./types";

const OPS_ROOT = resolve(__dirname, "..", "..", "..");

/** BugBoss from its own commit, built as production builds it. */
const build = async (ref: string, out: string): Promise<RuntimeBuild> => {
  const sha = execFileSync("git", ["-C", OPS_ROOT, "rev-parse", `${ref}^{commit}`], { encoding: "utf8" }).trim();
  const dir = join(out, "build", sha.slice(0, 12));
  if (!existsSync(join(dir, "dist", "bugboss", "index.js"))) {
    if (!existsSync(dir)) execFileSync("git", ["-C", OPS_ROOT, "worktree", "add", "--detach", dir, sha], { stdio: "inherit" });
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit" });
    execFileSync("npx", ["tsc", "-p", "."], { cwd: dir, stdio: "inherit" });
    copyFileSync(join(dir, "bugboss", "db", "schema.sql"), join(dir, "dist", "bugboss", "db", "schema.sql"));
  }
  return { dir, sha };
};

/**
 * The one read of BugBoss's insides the harness still makes: whether the
 * incident closed. Every other fact about a run comes from Slack, GitHub, the
 * hidden check and the model proxy. The incident service, once it exists, is
 * what every runtime will have to tell about a close, and this read goes away.
 */
const incidentClosed = (dbPath: string): boolean => {
  if (!existsSync(dbPath)) return false;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT status FROM incident WHERE mergedInto IS NULL ORDER BY firstSignalAt LIMIT 1").get() as { status: string } | undefined;
    return row?.status === "CLOSED";
  } catch {
    return false;
  } finally {
    db.close();
  }
};

export const bugboss: Runtime = {
  id: "bugboss",
  modelProtocol: "bedrock",
  build,
  launch: async ({ build, env, ports, workRoot, world, runAs }) => {
    const url = `http://127.0.0.1:${ports.http}`;
    const dbPath = join(world.stateDir, "bugboss.db");
    const loopbackPort = ports.spare[0] ?? ports.http + 1;
    const full: Record<string, string> = {
      ...env,
      PORT: String(ports.http),
      BUGBOSS_LOOPBACK_PORT: String(loopbackPort),
      BUGBOSS_BUCKET: "bugboss-eval",
      BUGBOSS_DB_PATH: dbPath,
      BUGBOSS_SLACK_CHANNEL_ID: world.slack.channel,
      BUGBOSS_TICK_SECONDS: "10",
      BUGBOSS_OMNI_REPO: world.github.repoUrl,
      BUGBOSS_WORK_ROOT: workRoot,
      BUGBOSS_GITHUB_TOKEN_FILE: world.github.tokenFile,
      BUGBOSS_REVIEW_SETTLE_SECONDS: "5",
      NODE_EXTRA_CA_CERTS: world.github.caFile,
      SLACK_BOT_TOKEN: world.slack.botToken,
      SLACK_SIGNING_SECRET: world.slack.signingSecret,
      SLACK_BOT_USER_ID: world.slack.botUserId,
      SLACK_API_URL: world.slack.apiUrl,
      GRAFANA_URL: world.grafana.url,
      GRAFANA_SERVICE_ACCOUNT_TOKEN: world.grafana.serviceAccountToken,
      GRAFANA_WEBHOOK_SECRET: world.grafana.webhookSecret,
      AWS_REGION: world.aws.region,
      AWS_CONTAINER_CREDENTIALS_FULL_URI: world.aws.credentialsUrl,
      AWS_ENDPOINT_URL_S3: world.aws.s3Url,
      OMNI_TEST_POSTGRES_URL: world.postgresUrl,
    };
    const launch = asUser(runAs, "node", [join(build.dir, "dist", "bugboss", "index.js")], full);
    const logPath = join(world.stateDir, "bugboss.log");
    writeFileSync(logPath, "");
    const child = spawn(launch.command, launch.args, { env: launch.env ?? process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const append = (chunk: Buffer) => writeFileSync(logPath, chunk, { flag: "a" });
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    return {
      child,
      healthUrl: `${url}/health`,
      alertUrl: `${url}/grafana`,
      slackEventsUrl: `${url}/slack`,
      closed: async () => incidentClosed(dbPath),
    };
  },
};
