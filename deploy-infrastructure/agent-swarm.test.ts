import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DISK_METRICS_NAMESPACE,
  diskMetricsPutStatement,
  hostFiles,
  hostFilesHash,
  infraLogsReadStatements,
  panelRepliesPutStatement,
  SWARM_HOSTNAME,
  swarmHostPolicy,
  syncCommand,
  userData,
} from "./agent-swarm";
import { INFRA_ZONE_NAME } from "./dns";

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
