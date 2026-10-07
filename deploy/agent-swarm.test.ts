import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hostFiles,
  hostFilesHash,
  syncCommand,
} from "./components/agent-swarm";
import { formatAlarm } from "./components/agent-swarm-notifier.mjs";

describe("agent-swarm host files", () => {
  // The association runs install.sh from the synced copy and install.sh
  // hands off to up.sh; without either the deploy succeeds and the host
  // never changes.
  it("ships the entry points the association runs", () => {
    const files = hostFiles();
    for (const required of [
      "install.sh",
      "up.sh",
      "render-env.sh",
      "docker-compose.yml",
      "Caddyfile",
      "systemd/agent-swarm.service",
    ]) {
      assert.ok(files.includes(required), `missing host file ${required}`);
    }
  });

  it("puts the content hash in the command, so a file change reruns it", () => {
    const hash = hostFilesHash();
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.ok(syncCommand(hash).includes(hash));
    assert.notEqual(syncCommand(hash), syncCommand("0".repeat(64)));
  });
});

describe("agent-swarm alarm notifier", () => {
  const alarm = {
    AlarmName: "agent-swarm-api-unhealthy",
    AlarmDescription: "The API has failed /health.",
    NewStateValue: "ALARM",
    OldStateValue: "OK",
    NewStateReason: "Threshold Crossed: 5 datapoints were less than 1.",
  };

  it("names the alarm, the transition, and why", () => {
    assert.equal(
      formatAlarm(alarm),
      [
        "*agent-swarm-api-unhealthy* is ALARM (was OK)",
        "The API has failed /health.",
        "> Threshold Crossed: 5 datapoints were less than 1.",
      ].join("\n"),
    );
  });

  it("drops the reason on recovery", () => {
    assert.equal(
      formatAlarm({ ...alarm, NewStateValue: "OK", OldStateValue: "ALARM" }),
      "*agent-swarm-api-unhealthy* is OK (was ALARM)\nThe API has failed /health.",
    );
  });
});
