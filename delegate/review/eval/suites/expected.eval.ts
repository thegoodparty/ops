import { rmSync } from "node:fs";
import { join } from "node:path";
import { isCacheable } from "../cache";
import { checkoutFor, loadRecord, readManifest, selectCases, scoreRun } from "../expect";
import { replayCase } from "../replay";
import { defineReplaySuite, readReplayRun } from "../suite";

const run = readReplayRun();
const manifestPath = run.manifest;
if (!manifestPath) throw new Error("The expected suite requires a manifest");
const cases = selectCases(readManifest(manifestPath), { case: run.case, split: run.split });
if (cases.length === 0) {
  throw new Error(
    `no expected case matches${run.case ? ` --case ${run.case}` : ""}${run.split ? ` --split ${run.split}` : ""}`,
  );
}

const records = new Map(cases.map((c) => [c.id, loadRecord(c, manifestPath)]));
// A bundle case is simulated unless its source says it is a real PR, whose head
// commit GitHub still serves.
const synthetic = new Set(
  cases.filter((c) => c.source === "simulated").map((c) => records.get(c.id)!.bundle.headSha),
);
const checkout = checkoutFor(synthetic, run.mirrorDir);

defineReplaySuite({
  name: "expected",
  cases,
  id: (c) => c.id,
  out: run.out,
  replays: run.replays,
  fromRun: run.fromRun,
  canReuse: isCacheable,
  planOnly: run.planOnly,
  replay: (c, runNumber) =>
    replayCase(
      records.get(c.id)!,
      { workDir: join(run.workDir, `run-${runNumber}`), variant: run.variant },
      undefined,
      checkout,
    ),
  after: (c, runNumber, result) => {
    // This run slot's checkout is finished with, so the next replay in it starts
    // clean and a long suite does not fill the disk.
    rmSync(join(run.workDir, `run-${runNumber}`, c.id), { recursive: true, force: true });
    // The same line the loops printed. A block reads "reason not judged" here:
    // replay does not call the block judge, scoring does.
    console.error(`  ${c.id} run ${runNumber}: ${scoreRun(c.expect, result).outcome}`);
  },
});
