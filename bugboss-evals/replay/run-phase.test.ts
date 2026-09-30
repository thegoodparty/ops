import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ReplayCase } from "./case";
import { claimWorkRoot, hostProblem, loadCheckpoint, SIDE_LOCK } from "./run-phase";

test("a side refuses to run anywhere but Linux", () => {
  assert.equal(hostProblem("linux"), null);
  assert.match(hostProblem("darwin") ?? "", /only on Linux.*darwin/);
});

test("a second side on the same work root is refused while the first holds it, and allowed after", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-"));
  try {
    const release = await claimWorkRoot(root, "incident-2-post-pr rep 1 (main)");
    await assert.rejects(claimWorkRoot(root, "incident-2-post-pr rep 1 (feat/x)"), /incident-2-post-pr rep 1 \(main\).*own container/s);
    await release();
    assert.equal(existsSync(join(root, SIDE_LOCK)), false);
    const again = await claimWorkRoot(root, "incident-2-post-pr rep 1 (feat/x)");
    await again();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a side reads its checkpoint from a local file when given one, and never touches the case's S3 URI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "checkpoint-"));
  try {
    // A small synthetic Pi session. No production data.
    const entry = (id: string, body: Record<string, unknown>) =>
      JSON.stringify({ id, parentId: null, timestamp: "2026-09-29T00:00:00.000Z", ...body });
    const view = { incident: { id: "7", status: "FIXING", rootCause: "a cause" }, signals: [] };
    const session = [
      JSON.stringify({ type: "session", version: 3, id: "7", timestamp: "2026-09-29T00:00:00.000Z", cwd: "/work/7/omni" }),
      entry("a1", { type: "message", message: { role: "assistant", timestamp: 1000, content: [{ type: "toolCall", id: "c1", name: "get_incident", arguments: {} }] } }),
      entry("r1", { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "get_incident", isError: false, content: [{ type: "text", text: `ok\n\n${JSON.stringify(view)}` }] } }),
      entry("a2", { type: "message", message: { role: "assistant", timestamp: 2000, content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: 'gh pr create --base main --head fix/pool --title "Bound the pool" --body "Why."' } }] } }),
      entry("r2", { type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", isError: false, content: [{ type: "text", text: "https://github.com/thegoodparty/omni/pull/2213" }] } }),
    ].join("\n");
    const path = join(dir, "session.jsonl");
    await writeFile(path, session);
    const replayCase = {
      checkpoint: { session: "s3://no-such-bucket-for-this-test/sessions/incident/7/session.jsonl", prOrdinal: 1 },
    } as unknown as ReplayCase;
    const checkpoint = await loadCheckpoint(replayCase, path);
    assert.equal(checkpoint.incidentId, "7");
    assert.equal(checkpoint.cwd, "/work/7/omni");
    assert.equal(checkpoint.pr.number, 2213);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
