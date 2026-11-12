import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  delegateSwarmBedrockPolicy,
  delegateSwarmBedrockTrust,
  DISK_METRICS_NAMESPACE,
  diskMetricsPutStatement,
  hostFiles,
  hostFilesHash,
  infraLogsReadStatements,
  panelRepliesPutStatement,
  SWARM_BEDROCK_READ_ACTIONS,
  SWARM_BEDROCK_READ_RESOURCES,
  SWARM_HOSTNAME,
  swarmHostPolicy,
  syncCommand,
  userData,
} from "./agent-swarm";
import { INFRA_ZONE_NAME } from "./dns";
import { SWARM_MODEL_IDS } from "../utils/bedrock-models";

const HOST_DIR = path.resolve(__dirname, "../agent-swarm/host");

// render-env.sh is the only place the agent-swarm version lives; the compose
// fallbacks have to agree, or a .env without the variable pulls an old image.
function pinnedVersion(): string {
  const renderEnv = fs.readFileSync(
    path.join(HOST_DIR, "render-env.sh"),
    "utf8",
  );
  const match = renderEnv.match(/^AGENT_SWARM_VERSION=(\d+\.\d+\.\d+)$/m);
  assert.ok(match, "render-env.sh pins AGENT_SWARM_VERSION");
  return match[1];
}

describe("delegate swarm hostname", () => {
  it("is delegate-swarm in the account's own zone", () => {
    assert.equal(INFRA_ZONE_NAME, "infra.goodparty.org");
    assert.equal(SWARM_HOSTNAME, "delegate-swarm.infra.goodparty.org");
  });

  // Caddy only gets a certificate for its site address, and oauth2-proxy
  // rejects a callback on any other host, so a record that drifts from these
  // takes the dashboard down.
  it("matches the Caddy site address and the oauth2-proxy host", () => {
    const caddyfile = fs.readFileSync(path.join(HOST_DIR, "Caddyfile"), "utf8");
    assert.match(caddyfile, new RegExp(`^${SWARM_HOSTNAME.replaceAll(".", "\\.")} \\{$`, "m"));

    const compose = fs.readFileSync(
      path.join(HOST_DIR, "docker-compose.yml"),
      "utf8",
    );
    assert.ok(
      compose.includes(
        `OAUTH2_PROXY_REDIRECT_URL: https://${SWARM_HOSTNAME}/oauth2/callback`,
      ),
    );
    assert.ok(
      compose.includes(`OAUTH2_PROXY_WHITELIST_DOMAINS: ${SWARM_HOSTNAME}`),
    );
  });
});

describe("delegate swarm host files", () => {
  // The association runs install.sh from the synced copy; without it the
  // deploy fails on every host change.
  it("ships the entry point the association runs", () => {
    assert.ok(hostFiles().includes("install.sh"));
  });

  // up.sh runs it on every deploy; without it a merge to
  // global-setup-script.sh or the model never reaches the agents.
  it("ships the agent config sync up.sh runs", () => {
    assert.ok(hostFiles().includes("sync-agent-config.sh"));
    const up = fs.readFileSync(path.join(HOST_DIR, "up.sh"), "utf8");
    assert.match(up, /^\.\/sync-agent-config\.sh$/m);
  });

  // Scripts, skills and souls belong to the swarm's own database and are
  // changed from Slack. Shipping them would let a deploy push over those
  // changes.
  it("ships no swarm-owned content", () => {
    const files = hostFiles();
    assert.ok(files.length > 0);
    for (const file of files) {
      assert.ok(!/^(scripts|skills|soul)\//.test(file), file);
    }
  });

  // The upstream worker image ships a Node with known CVEs; the agents run
  // the image up.sh builds from worker-patch/ instead.
  it("runs every agent on the patched worker image", () => {
    assert.ok(hostFiles().includes("worker-patch/Dockerfile"));
    const compose = fs.readFileSync(
      path.join(HOST_DIR, "docker-compose.yml"),
      "utf8",
    );
    assert.ok(!compose.includes("ghcr.io/desplega-ai/agent-swarm-worker"));
    assert.ok(
      compose.includes(
        `image: "delegate-swarm-worker:\${AGENT_SWARM_VERSION:-${pinnedVersion()}}-\${WORKER_PATCH_HASH:?rendered by render-env.sh}"`,
      ),
    );
  });

  it("falls back to the pinned version on every image tag", () => {
    const compose = fs.readFileSync(
      path.join(HOST_DIR, "docker-compose.yml"),
      "utf8",
    );
    const defaults = [...compose.matchAll(/\$\{AGENT_SWARM_VERSION:-([0-9.]+)\}/g)].map(
      (match) => match[1],
    );
    assert.ok(defaults.length >= 2, "compose keeps a default per image tag");
    for (const fallback of defaults) assert.equal(fallback, pinnedVersion());
  });

  it("puts the content hash in the command, so a file change reruns it", () => {
    const hash = hostFilesHash();
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.ok(syncCommand(hash).includes(hash));
    assert.notEqual(syncCommand(hash), syncCommand("0".repeat(64)));
  });
});

describe("delegate swarm user data", () => {
  it("substitutes the data volume id for every placeholder", () => {
    const script = userData("vol-0123456789abcdef0");
    assert.ok(script.includes("vol-0123456789abcdef0"));
    assert.ok(!script.includes("__DATA_VOLUME_ID__"));
  });
});

describe("panel replies grant", () => {
  it("only puts objects under agent-replies/ in the dev and prod buckets", () => {
    assert.equal(panelRepliesPutStatement.Action, "s3:PutObject");
    assert.deepEqual(panelRepliesPutStatement.Resource, [
      "arn:aws:s3:::tevyn-poll-csvs-develop/agent-replies/*",
      "arn:aws:s3:::tevyn-poll-csvs-master/agent-replies/*",
    ]);
  });

  it("is in the host role's policy", () => {
    const { Statement } = swarmHostPolicy("arn:aws:secretsmanager:secret", "arn:aws:s3:::bucket");
    assert.ok(Statement.includes(panelRepliesPutStatement));
  });
});

describe("data volume cleanup", () => {
  // Without it the agents' node_modules fill the volume and SQLite stops
  // taking writes, as on 2026-11-06.
  it("ships the cleanup script and a timer install.sh enables", () => {
    assert.ok(hostFiles().includes("disk-cleanup.sh"));
    assert.ok(hostFiles().includes("systemd/agent-swarm-disk-cleanup.service"));
    assert.ok(hostFiles().includes("systemd/agent-swarm-disk-cleanup.timer"));
    const install = fs.readFileSync(path.join(HOST_DIR, "install.sh"), "utf8");
    assert.match(install, /systemd\/\*\.timer/);
    assert.match(install, /^systemctl enable --now agent-swarm-disk-cleanup\.timer$/m);
  });

  // A worker image built by up.sh has no container until compose starts it,
  // and pull_policy: never means a pruned one cannot come back.
  it("never prunes images while up.sh holds the deploy lock", () => {
    const up = fs.readFileSync(path.join(HOST_DIR, "up.sh"), "utf8");
    const script = fs.readFileSync(path.join(HOST_DIR, "disk-cleanup.sh"), "utf8");
    const lock = up.indexOf("flock 9");
    assert.ok(lock > 0 && lock < up.indexOf("docker build"));
    assert.ok(script.indexOf("flock -n 9") < script.indexOf("docker image prune"));
    assert.match(script, /exec 9>>\/opt\/agent-swarm\/\.deploy\.lock/);
  });

  // A deploy holds the lock for its whole run, and the api it swaps in spends
  // that time applying migrations. Walking every checkout and pruning images
  // at the same time competes for the same volume (ENG-11612). The metrics
  // still go out: the alarms breach on missing data.
  it("skips the sweep too while a deploy runs, but still reports", () => {
    const script = fs.readFileSync(path.join(HOST_DIR, "disk-cleanup.sh"), "utf8");
    const gate = script.indexOf("if ((deploy_in_progress == 0)); then");
    assert.ok(gate > 0, "the sweep is behind the deploy lock");
    assert.ok(gate < script.indexOf('clean "$IDLE_MINUTES"'));
    assert.ok(gate < script.indexOf("docker image prune"));
    // Col 0 means outside the gate's block, which is indented by two spaces.
    assert.match(script, /^used="\$\(used_percent\)"$/m);
    assert.match(script, /^aws cloudwatch put-metric-data/m);
    // A deploy waits on the lock in up.sh, so a hung metric call must not hold it.
    assert.ok(script.indexOf("exec 9>&-") < script.indexOf("put-metric-data"));
  });

  it("lets the host put metrics only in its own namespace", () => {
    const { Statement } = swarmHostPolicy("arn:aws:secretsmanager:secret", "arn:aws:s3:::bucket");
    assert.ok(Statement.includes(diskMetricsPutStatement));
    assert.deepEqual(diskMetricsPutStatement.Condition, {
      StringEquals: { "cloudwatch:namespace": DISK_METRICS_NAMESPACE },
    });
    const script = fs.readFileSync(path.join(HOST_DIR, "disk-cleanup.sh"), "utf8");
    assert.ok(script.includes(`--namespace ${DISK_METRICS_NAMESPACE}`));
  });
});

describe("infrastructure account log read access", () => {
  const { Statement } = swarmHostPolicy("arn:aws:secretsmanager:secret", "arn:aws:s3:::bucket");

  it("is in the host role's policy", () => {
    for (const statement of infraLogsReadStatements) {
      assert.ok(Statement.includes(statement), statement.Sid);
    }
  });

  it("is read-only and scopes stream and event reads to this account's log groups", () => {
    const actions = infraLogsReadStatements.flatMap((s) => [s.Action].flat());
    const write = /Put|Create|Delete|Set|Update|Tag|Associate|Disable|Enable/;
    assert.deepEqual(actions.filter((a) => write.test(a.split(":")[1])), []);
    const reads = infraLogsReadStatements.find((s) => s.Sid === "ReadAccountLogs");
    for (const arn of [reads?.Resource].flat()) {
      assert.match(String(arn), /^arn:aws:logs:[a-z0-9-]+:\d{12}:log-group:\*/);
    }
  });
});

// The swarm's model grant. `docs/swarm-bedrock.md` is the plan; this describe
// is step 1's policy and trust, read as data rather than through a Pulumi
// resource, the same way the host policy above is.
describe("delegate swarm bedrock role", () => {
  const HOST_ROLE_ARN =
    "arn:aws:iam::394495727159:role/delegate-swarm-host";
  const statements = delegateSwarmBedrockPolicy.Statement;
  const asList = (value: string | string[]) =>
    Array.isArray(value) ? value : [value];

  const actions = statements.flatMap((s) => asList(s.Action));
  const resources = statements.flatMap((s) => asList(s.Resource));

  it("admits the swarm host role and nothing else", () => {
    // The account root is the principal only because the host role may not
    // exist when this applies; the condition is what narrows it. Same shape as
    // delegate-swarm-prod-read, whose test reads it the same way.
    assert.deepEqual(delegateSwarmBedrockTrust, {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: "arn:aws:iam::394495727159:root" },
          Action: "sts:AssumeRole",
          Condition: { ArnEquals: { "aws:PrincipalArn": HOST_ROLE_ARN } },
        },
      ],
    });
    // One statement, one condition: a second statement without one, or the
    // role as a bare principal, would widen who may invoke the models.
    assert.equal(delegateSwarmBedrockTrust.Statement.length, 1);
    for (const statement of delegateSwarmBedrockTrust.Statement) {
      assert.equal(statement.Action, "sts:AssumeRole");
      assert.deepEqual(Object.keys(statement.Condition), ["ArnEquals"]);
    }
  });

  it("allows exactly the four invoke actions on exactly four ARNs", () => {
    assert.equal(statements.length, 2);
    const invoke = statements.find(
      (s) => s.Sid === "InvokeSwarmBedrockModels"
    );
    assert.ok(invoke);
    assert.equal(invoke.Effect, "Allow");
    assert.deepEqual(invoke.Action, [
      "bedrock:Converse",
      "bedrock:ConverseStream",
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]);
    // Two inference profiles and two foundation models, in this account for the
    // profiles and with an empty account field for the foundation models.
    assert.deepEqual(invoke.Resource, [
      "arn:aws:bedrock:*:394495727159:inference-profile/global.openai.gpt-6.1-sol",
      "arn:aws:bedrock:*:394495727159:inference-profile/global.anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:*::foundation-model/openai.gpt-6.1-sol",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-5-5",
    ]);
    // The invoke half is four ARNs and no wildcard resource. The wildcard
    // count below is `resources`, which includes the read statement's `*`.
    assert.equal(invoke.Resource.length, 4);
  });

  // The swarm worker's `BEDROCK_AUTH_MODE=sdk` probe calls
  // `ListFoundationModels` and `ListInferenceProfiles` before any per-key
  // check, and a probe failure parks the worker in credential-wait. Both are
  // required, and the second is not in the Bifrost task role's read set because
  // Bifrost's provider never calls it.
  it("allows exactly the two catalog reads the sdk probe makes", () => {
    assert.deepEqual([...SWARM_BEDROCK_READ_ACTIONS], [
      "bedrock:ListFoundationModels",
      "bedrock:ListInferenceProfiles",
    ]);
    const probe = statements.find((s) => s.Sid === "ProbeBedrockCatalog");
    assert.ok(probe);
    assert.equal(probe.Effect, "Allow");
    assert.deepEqual(probe.Action, [...SWARM_BEDROCK_READ_ACTIONS]);
    // `*` for both: IAM defines no resource type for either action, so a
    // narrower Resource fails rather than scoping the call. Named through the
    // constant, as `deploy-workbench/ecs.ts` does with
    // TASK_BEDROCK_READ_RESOURCES, so this wildcard is distinguishable from an
    // edit that widens something else.
    assert.deepEqual(probe.Resource, [...SWARM_BEDROCK_READ_RESOURCES]);
    assert.deepEqual([...SWARM_BEDROCK_READ_RESOURCES], ["*"]);
  });

  // Six actions in total: four invoke, two read. Pinned as a set so neither a
  // quiet addition nor a quiet removal passes.
  it("grants six actions and no more", () => {
    assert.deepEqual([...actions].sort(), [
      "bedrock:Converse",
      "bedrock:ConverseStream",
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:ListFoundationModels",
      "bedrock:ListInferenceProfiles",
    ]);
  });

  // The grant exists to reach two models, so every model ARN has to name one of
  // them by id. This is what would catch a third model, or a profile whose
  // entry in utils/bedrock-models.ts moved without the swarm following. The
  // read statement's `*` is excluded: it names no model at all, and the test
  // above pins it instead.
  it("names one of the two swarm models in every model ARN", () => {
    assert.deepEqual([...SWARM_MODEL_IDS], [
      "openai.gpt-6.1-sol",
      "anthropic.claude-haiku-5-5",
    ]);
    const modelArns = resources.filter((r) => r !== "*");
    assert.equal(modelArns.length, 4);
    for (const arn of modelArns) {
      const named = SWARM_MODEL_IDS.filter(
        (id) => arn.endsWith(`/${id}`) || arn.endsWith(`/global.${id}`)
      );
      assert.equal(named.length, 1, arn);
      assert.match(arn, /^arn:aws:bedrock:\*:/, arn);
    }
  });

  // Nothing wilder. Each of these is the line someone would add next, and each
  // one makes the two-model list decoration.
  it("carries no wildcard action, and one named wildcard resource", () => {
    for (const action of actions) {
      assert.match(action, /^bedrock:/, action);
      assert.equal(action.includes("*"), false, action);
    }

    // Exactly one wildcard resource, and it is the read statement's, which is
    // the one IAM forces. Every other resource is a Bedrock ARN whose only
    // wildcard is the region (spelled "*" in the middle of the ARN, so counted
    // separately from a bare `*`).
    assert.deepEqual(
      resources.filter((r) => r === "*"),
      [...SWARM_BEDROCK_READ_RESOURCES]
    );
    for (const resource of resources.filter((r) => r !== "*")) {
      assert.match(resource, /^arn:aws:bedrock:\*:/, resource);
      assert.equal(
        resource.split("*").length - 1,
        1,
        `${resource} has more than the region wildcard`
      );
    }

    // No `Get`, no service wildcard, and nothing beyond the two named reads.
    assert.equal(
      actions.some((a) => a.startsWith("bedrock:Get")),
      false,
      "the probe lists; it does not describe"
    );
    assert.equal(
      actions.filter((a) => a.startsWith("bedrock:List")).sort().join(","),
      [...SWARM_BEDROCK_READ_ACTIONS].sort().join(","),
      "a Bedrock List action is granted beyond the two the sdk probe makes"
    );
    assert.equal(
      JSON.stringify(delegateSwarmBedrockPolicy).includes("marketplace"),
      false
    );
    assert.equal(
      JSON.stringify(delegateSwarmBedrockPolicy).includes('"bedrock:*"'),
      false,
      "the policy names bedrock:* ; the six named actions are the allowlist"
    );
  });

  // The host assumes the role, so the grant has to be on the host's policy as
  // well. Both halves are required for a same-account assume, and a missing
  // half is an AccessDenied at the first model call rather than a diff.
  it("is assumable by the host role, which the host policy grants", () => {
    const { Statement } = swarmHostPolicy(
      "arn:aws:secretsmanager:secret",
      "arn:aws:s3:::bucket"
    );
    const assume = Statement.find((s) => s.Sid === "AssumeSwarmBedrock");
    assert.ok(assume);
    assert.equal(assume.Action, "sts:AssumeRole");
    assert.equal(
      assume.Resource,
      "arn:aws:iam::394495727159:role/delegate-swarm-bedrock"
    );
  });
});
