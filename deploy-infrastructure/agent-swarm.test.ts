import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hostFiles,
  hostFilesHash,
  syncCommand,
  userData,
} from "./agent-swarm";

describe("delegate swarm host files", () => {
  // The association runs install.sh from the synced copy; without it the
  // deploy fails on every host change.
  it("ships the entry point the association runs", () => {
    assert.ok(hostFiles().includes("install.sh"));
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
