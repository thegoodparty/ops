import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ReviewRecord } from "../../schema";
import { loadCases, loadScenarios, scenarioNames } from "../cases";
import { SplitSchema } from "../expect";
import { replayCase } from "../replay";
import { defineReplaySuite, readReplayRun } from "../suite";

const run = readReplayRun();
const casesDir = run.casesDir;
if (casesDir === undefined) {
  throw new Error("no cases directory; `review:eval replay --cases <dir>` is what provides it");
}

let records = loadCases(casesDir);
if (run.split !== undefined) {
  // The scenarios manifest is the only mapping from a case record to its split,
  // the same one `--split` read before.
  if (run.manifest === undefined) {
    throw new Error(`--split needs --manifest, the scenarios.json that labels each case`);
  }
  const inSplit = scenarioNames(loadScenarios(run.manifest, { split: SplitSchema.parse(run.split) }));
  records = records.filter((r) => inSplit.has(r.runId));
}
if (run.case !== undefined) {
  const ids = new Set(run.case.split(","));
  records = records.filter((r) => ids.has(r.runId));
}
if (records.length === 0) {
  throw new Error(
    `no pairwise case in ${casesDir}${run.case ? ` matching --case ${run.case}` : ""}${run.split ? ` in split ${run.split}` : ""}`,
  );
}

defineReplaySuite<ReviewRecord>({
  name: "pairwise",
  cases: records,
  id: (r) => r.runId,
  out: run.out,
  replays: run.replays,
  canReuse: () => true,
  force: run.force,
  planOnly: run.planOnly,
  replay: (record, runNumber) =>
    replayCase(record, { workDir: join(run.workDir, `run-${runNumber}`), variant: run.variant }),
  after: (record, runNumber) => {
    rmSync(join(run.workDir, `run-${runNumber}`, record.runId), { recursive: true, force: true });
  },
});
