import { strict as assert } from "node:assert";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { loadScenario } from "../core/scenario";
import { OPS_ROOT, buildBugbossImage, buildSimImage, localDefaults, omniBundle, runScenario, scenarioJsonFor } from "./orchestrator";

/**
 * The whole stack, up, with a real BugBoss image, and nothing sent: no alert
 * fires and the persona never starts, so this costs no model spend. It proves
 * that every endpoint BugBoss and its agents use lands on a stand-in, from
 * inside the BugBoss container, as the agent's own user.
 *
 * Opt-in, because it builds images and needs an omni checkout:
 *   BUGBOSS_EVALS_STACK_TEST=1 OMNI_DIR=~/Repos/thegoodparty/omni \
 *     npx tsx --test --test-timeout=1800000 bugboss-evals/sim/stack.integration.test.ts
 * STACK_TEST_REF picks the ops ref BugBoss is built from (default HEAD) and
 * STACK_TEST_SCENARIO the scenario (default the first one).
 */

const enabled = process.env.BUGBOSS_EVALS_STACK_TEST === "1";

describe("the Tier 1 stack", { skip: enabled ? false : "set BUGBOSS_EVALS_STACK_TEST=1 to bring up the whole stack" }, () => {
  test("comes up, and BugBoss's every endpoint is a stand-in", async () => {
    const scenarioId = process.env.STACK_TEST_SCENARIO ?? "ecanvasser-sync-timeout";
    const scenarioJson = scenarioJsonFor(scenarioId);
    assert.ok(existsSync(scenarioJson), `no scenario at ${scenarioJson}`);
    const { scenario } = loadScenario(scenarioJson);
    const image = await buildBugbossImage(process.env.STACK_TEST_REF ?? "HEAD", OPS_ROOT);
    const sim = await buildSimImage();
    const defaults = localDefaults();
    const bundle = await omniBundle(process.env.OMNI_DIR ?? join(OPS_ROOT, "..", "omni"), scenario.omni.baseSha, defaults.bundleCache);
    const checks: Record<string, string> = {};

    const result = await runScenario({
      scenarioJson,
      bugbossImage: image.tag,
      simImage: sim,
      rep: 1,
      runId: `stack-${Date.now().toString(36)}`,
      workRoot: defaults.workRoot,
      omniBundle: bundle,
      modelCredentials: "none",
      afterBringUp: async ({ compose, gateway, prepared }) => {
        const inBugboss = async (name: string, script: string) => {
          const out = await compose(["exec", "-T", "--user", "agent", "bugboss", "bash", "-lc", `${script} 2>&1; echo "exit=$?"`]).catch(
            (error: Error & { stdout?: string }) => ({ stdout: error.stdout ?? error.message }),
          );
          checks[name] = out.stdout.trim();
        };
        await inBugboss("s3", "aws s3 ls s3://bugboss-sim/");
        await inBugboss("ecs", "aws ecs list-clusters --output text");
        await inBugboss("cloudwatch", "aws cloudwatch list-metrics --namespace AWS/RDS --output text | head -3");
        await inBugboss("uvx", "uvx mcp-grafana --version");
        await inBugboss("npm", "cd /tmp && npm view left-pad version");
        await inBugboss("git", "git ls-remote https://github/thegoodparty/omni.git");
        await inBugboss("proxy", "curl -sS -o /dev/null -w '%{http_code}' --http2 https://proxy:8443/");
        await inBugboss("control", "curl -sS -m 3 http://github:9002/__control/state");
        await inBugboss("postgres", "pg_isready -h 127.0.0.1 -p 5432");
        await inBugboss("internet", "curl -sS -m 5 https://registry.npmjs.org/ -o /dev/null");
        // The model session lives where only the proxy and the persona mount
        // it. A canary written there now must reach the proxy and nothing
        // BugBoss's shell can read, and neither metadata endpoint (the EC2
        // host role, the ECS task role) may answer it. On a laptop there is
        // no metadata endpoint to reach; on an eval host this is the check
        // that hop limit 1 holds (deploy/components/bugboss-evals.ts).
        writeFileSync(
          join(prepared.runDir, "model-aws", "session.json"),
          JSON.stringify({ Version: 1, AccessKeyId: "AKIACANARYSESSION", SecretAccessKey: "canary" }),
        );
        const proxySees = await compose(["exec", "-T", "proxy", "cat", "/sim/model-aws/session.json"]);
        checks.proxySession = proxySees.stdout;
        await inBugboss("session", "cat /sim/model-aws/session.json; ls -la /sim; grep -rl AKIACANARYSESSION /sim /home/agent /app /etc /tmp 2>/dev/null; true");
        await inBugboss("imds", "curl -sS -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token");
        await inBugboss("ecsCreds", "curl -sS -m 3 http://169.254.170.2/v2/credentials/");
        await inBugboss("containerCredsEnv", "env | grep -E '^AWS_CONTAINER_|^AWS_WEB_IDENTITY' || echo none");
        await inBugboss("identity", "aws sts get-caller-identity --output json");
        const health = await gateway.call("/telemetry/__control/state");
        checks.telemetry = await health.text();
      },
    });

    assert.equal(result.end.detail, "stopped after bring-up, as asked", JSON.stringify(result.end));
    assert.match(checks.s3, /exit=0/, `S3 reaches MinIO by virtual host: ${checks.s3}`);
    assert.match(checks.ecs, /arn:aws:ecs/, `ECS reaches the AWS stand-in: ${checks.ecs}`);
    assert.match(checks.cloudwatch, /exit=0/, `CloudWatch reaches the AWS stand-in: ${checks.cloudwatch}`);
    assert.match(checks.uvx, /v\d+\.\d+/, `mcp-grafana starts offline from the warmed cache: ${checks.uvx}`);
    assert.match(checks.npm, /^\d+\.\d+\.\d+/m, `npm goes through the npm exit: ${checks.npm}`);
    assert.match(checks.git, /401|Authentication|could not read Username/i, `git reaches the GitHub stand-in over TLS: ${checks.git}`);
    assert.match(checks.proxy, /^404/, `the model proxy answers over TLS: ${checks.proxy}`);
    assert.doesNotMatch(checks.control, /exit=0/, `the GitHub control port is not reachable from BugBoss: ${checks.control}`);
    assert.match(checks.postgres, /accepting connections/, `the agents' test database is on loopback: ${checks.postgres}`);
    assert.doesNotMatch(checks.internet, /exit=0/, `BugBoss cannot reach the internet: ${checks.internet}`);
    assert.match(checks.proxySession, /AKIACANARYSESSION/, "the proxy reads the model session");
    assert.doesNotMatch(checks.session, /AKIACANARYSESSION/, `BugBoss's shell cannot read the model session: ${checks.session}`);
    assert.doesNotMatch(checks.imds, /exit=0/, `BugBoss cannot reach the EC2 metadata endpoint: ${checks.imds}`);
    assert.doesNotMatch(checks.ecsCreds, /exit=0/, `BugBoss cannot reach the ECS credential endpoint: ${checks.ecsCreds}`);
    assert.match(checks.containerCredsEnv, /^none/m, `BugBoss has no container credential variables: ${checks.containerCredsEnv}`);
    assert.doesNotMatch(checks.identity, /"Arn"/, `BugBoss's AWS identity is fake: ${checks.identity}`);
    assert.match(checks.telemetry, /"backfilled":\{/, `telemetry backfilled: ${checks.telemetry}`);
    const egress = result.gates.find((gate) => gate.name === "no_reach_outside_sim");
    assert.equal(egress?.pass, false, "the deliberate internet probe above must show up in the egress gate");
    assert.match(egress?.detail ?? "", /registry\.npmjs\.org/);
  });
});
