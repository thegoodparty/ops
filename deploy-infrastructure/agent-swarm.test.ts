import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  hostFiles,
  hostFilesHash,
  SWARM_HOSTNAME,
  syncCommand,
  userData,
} from "./agent-swarm";
import { INFRA_ZONE_NAME } from "./dns";

const HOST_DIR = path.resolve(__dirname, "../agent-swarm/host");

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

  // bootstrap.sh reads the lead's soul from /opt/agent-swarm/soul on the host.
  it("ships bootstrap.sh and the soul files it reads", () => {
    const files = hostFiles();
    for (const file of ["bootstrap.sh", "soul/SOUL.md", "soul/IDENTITY.md"]) {
      assert.ok(files.includes(file), file);
    }
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
