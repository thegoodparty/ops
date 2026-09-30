import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { claimWorkRoot, hostProblem, SIDE_LOCK } from "./run-phase";

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
