// Entry point for the GitHub stand-in: `npx tsx bugboss-evals/sim/standins/github/server.ts`.
//
// Two listeners. `PORT` is the https one BugBoss reaches, and serves git,
// REST and GraphQL. `CONTROL_PORT` is plain http for the orchestrator only,
// and nothing under `/__control` is served on the public port, so an agent
// that can reach the stand-in still cannot reset it or read its state.
//
// `PORT` must be 443 in any run where `gh` is used from a checkout: `gh`
// matches the checkout's remote to GH_HOST by hostname alone, then calls
// that host on the default port.
//
// Environment:
//   PORT, HOST                  public https listener (443, 0.0.0.0)
//   CONTROL_PORT, CONTROL_HOST  control listener (9002, 0.0.0.0)
//   CONTROL_TOKEN               when set, required as Bearer on /__control
//   TLS_CERT_FILE, TLS_KEY_FILE required
//   GITHUB_PUBLIC_URL           the origin BugBoss uses (https://github)
//   GITHUB_DATA_DIR             bare repos and checkouts (a new tmp dir)
//   GITHUB_SEED_BUNDLE          a bundle or repo to seed from at boot
//   GITHUB_SEED_REPO            owner/name to seed (thegoodparty/omni)
//   GITHUB_SEED_MAIN            commit main starts at (the bundle's HEAD)
//   GITHUB_STANDIN_HUMANS       JSON {token: login} for human users
//   GITHUB_APP_SLUG             the App's slug; its bot is "<slug>[bot]"
//   GITHUB_STANDIN_ACTIONS_WRITE  "true" lets the bot re-run CI. Off by default
//                               because the production App holds actions: read
//   CI_MODE                     run | scripted
//   CI_VISIBLE                  JSON array of shell commands, one job each
//   CI_TIMEOUT_SECONDS          per command (3600)
//   CI_UID                      uid (and gid) visible CI runs as when this
//                               process is root (65534, nobody)
//   DEPLOY_HOOK_COMMAND         run as `<cmd> <mergeSha> <checkoutPath>`
//   REVIEWER_LOGIN              the delegate bot (delegate-reviewer[bot])
//   REVIEWER_REQUEST_CHANGES_ONCE  "true" makes its first verdict request changes

import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitHubStandin, type StandinConfig } from "./standin";

/**
 * What CI commands and the deploy hook may see of this process's
 * environment. CI runs code the agent wrote, so it must never hold the
 * control token, and nothing else here is its business either.
 */
export const CI_ENV_NAMES = [
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "npm_config_registry",
  "PRISMA_ENGINES_MIRROR",
  "OMNI_TEST_POSTGRES_URL",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
] as const;

export const ciEnvFrom = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = { CI: "true", GITHUB_ACTIONS: "true" };
  for (const name of CI_ENV_NAMES) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
};

const parseJson = <T>(name: string, raw: string | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${name} is not valid JSON: ${(err as Error).message}`);
  }
};

const ciUidFrom = (raw: string | undefined): number => {
  const uid = Number(raw ?? 65534);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error(`CI_UID must be a uid other than root's, got ${raw}`);
  return uid;
};

export const configFromEnv = (env: NodeJS.ProcessEnv): StandinConfig => {
  const ciMode = env.CI_MODE ?? "run";
  if (ciMode !== "run" && ciMode !== "scripted") throw new Error(`CI_MODE must be run or scripted, got ${ciMode}`);
  const ciVisible = parseJson<string[]>("CI_VISIBLE", env.CI_VISIBLE, []);
  if (!Array.isArray(ciVisible) || ciVisible.some((c) => typeof c !== "string")) {
    throw new Error("CI_VISIBLE must be a JSON array of shell commands");
  }
  if (ciMode === "run" && ciVisible.length === 0) {
    throw new Error("CI_VISIBLE is required when CI_MODE is run: a CI that runs nothing is green for every change");
  }
  return {
    publicUrl: env.GITHUB_PUBLIC_URL ?? "https://github",
    dataDir: env.GITHUB_DATA_DIR ?? mkdtempSync(join(tmpdir(), "github-standin-")),
    humans: parseJson<Record<string, string>>("GITHUB_STANDIN_HUMANS", env.GITHUB_STANDIN_HUMANS, {}),
    appLogin: `${env.GITHUB_APP_SLUG ?? "bugboss-gp"}[bot]`,
    actionsWrite: env.GITHUB_STANDIN_ACTIONS_WRITE === "true",
    ciMode,
    ciVisible,
    ciTimeoutSeconds: Number(env.CI_TIMEOUT_SECONDS ?? 3600),
    ciEnv: ciEnvFrom(env),
    ciUid: process.getuid?.() === 0 ? ciUidFrom(env.CI_UID) : undefined,
    deployHookCommand: env.DEPLOY_HOOK_COMMAND || null,
    reviewerLogin: env.REVIEWER_LOGIN ?? "delegate-reviewer[bot]",
    requestChangesOnce: env.REVIEWER_REQUEST_CHANGES_ONCE === "true",
  };
};

export const startServers = async (
  env: NodeJS.ProcessEnv,
): Promise<{ publicServer: Server; controlServer: Server; standin: ReturnType<typeof createGitHubStandin> }> => {
  const config = configFromEnv(env);
  const standin = createGitHubStandin(config);

  if (env.GITHUB_SEED_BUNDLE) {
    await standin.seed({
      repo: env.GITHUB_SEED_REPO ?? "thegoodparty/omni",
      source: env.GITHUB_SEED_BUNDLE,
      main: env.GITHUB_SEED_MAIN || undefined,
    });
  }

  const handler = (req: Parameters<typeof standin.handle>[0], res: Parameters<typeof standin.handle>[1]) => {
    if ((req.url ?? "").startsWith("/__control")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
      return;
    }
    void standin.handle(req, res);
  };
  const publicServer =
    env.TLS_CERT_FILE && env.TLS_KEY_FILE
      ? createHttpsServer({ cert: readFileSync(env.TLS_CERT_FILE), key: readFileSync(env.TLS_KEY_FILE) }, handler)
      : createHttpServer(handler);

  const token = env.CONTROL_TOKEN;
  const controlServer = createHttpServer((req, res) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "control token required" }));
      return;
    }
    void standin.control(req, res);
  });

  await new Promise<void>((resolve) => publicServer.listen(Number(env.PORT ?? 443), env.HOST ?? "0.0.0.0", resolve));
  await new Promise<void>((resolve) =>
    controlServer.listen(Number(env.CONTROL_PORT ?? 9002), env.CONTROL_HOST ?? "0.0.0.0", resolve),
  );
  return { publicServer, controlServer, standin };
};

if (require.main === module) {
  if (!process.env.TLS_CERT_FILE || !process.env.TLS_KEY_FILE) {
    // gh and git refuse plain http for a host that is not github.com, so a
    // stand-in without TLS is one BugBoss cannot use. Refused, not defaulted.
    console.error("TLS_CERT_FILE and TLS_KEY_FILE are required");
    process.exit(1);
  }
  startServers(process.env).then(
    ({ publicServer, controlServer }) => {
      console.log(JSON.stringify({ component: "github-standin", event: "listening", public: publicServer.address(), control: controlServer.address() }));
    },
    (err: unknown) => {
      console.error(JSON.stringify({ component: "github-standin", event: "boot_failed", error: String(err) }));
      process.exit(1);
    },
  );
}
