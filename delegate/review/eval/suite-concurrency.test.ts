import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runReplaySuite } from "./suite";

test("Vitest overlaps 25 of 30 independent runs, including repeats of the same case", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "replay-concurrency-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "out");
  mkdirSync(out);
  const fixture = join(dir, "probe.eval.ts");
  writeFileSync(fixture, `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { defineReplaySuite, readReplayRun } from ${JSON.stringify(join(__dirname, "suite"))};
const { out, replays } = readReplayRun();
let inFlight = 0;
let release;
const firstWave = new Promise((resolve) => { release = resolve; });
const deadline = setTimeout(() => release(), 1000);
defineReplaySuite({
  name: "probe", cases: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
  id: (id) => id, out, replays, canReuse: () => true,
  replay: async (caseId) => {
    appendFileSync(join(out, "trace"), ++inFlight + "\\n");
    if (inFlight === 25) { clearTimeout(deadline); release(); }
    await firstWave;
    inFlight--;
    return { caseId };
  },
});
`);
  await runReplaySuite(fixture, { out, workDir: dir, replays: 3 }, 25);
  const starts = readFileSync(join(out, "trace"), "utf-8").trim().split("\n").map(Number);
  assert.equal(starts.length, 30);
  assert.equal(Math.max(...starts), 25);
});
