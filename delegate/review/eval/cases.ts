import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ReviewRecordSchema } from "../schema";
import type { ReviewRecord } from "../schema";
import { KindSchema, SourceSchema, SplitSchema } from "./expect";

const loadFromDir = (dir: string): ReviewRecord[] => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const records: ReviewRecord[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf-8"));
    } catch {
      console.warn(`cases: invalid JSON in ${file}`);
      continue;
    }
    const result = ReviewRecordSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(`cases: invalid ReviewRecord in ${file}: ${result.error.message}`);
      continue;
    }
    records.push(result.data);
  }
  return records;
};

export const loadCases = (dir: string): ReviewRecord[] => loadFromDir(dir);

// A scenario is a recorded production run picked on purpose: its bundle is
// the fixed input, so every eval replays the same cases. The manifest names a
// record file next to it, so a scenario needs no AWS access to load.
export const ScenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  suite: z.string().regex(/^[a-z0-9-]+$/),
  record: z.string().endsWith(".record.json"),
  tests: z.string().min(1),
  split: SplitSchema,
  source: SourceSchema,
  kind: KindSchema,
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const ScenarioManifestSchema = z
  .array(ScenarioSchema)
  .refine((s) => new Set(s.map((x) => x.id)).size === s.length, "scenario ids must be unique");

export const readManifest = (path: string): Scenario[] =>
  ScenarioManifestSchema.parse(JSON.parse(readFileSync(path, "utf-8")));

export interface LoadedScenario {
  scenario: Scenario;
  record: ReviewRecord;
}

// Fails loudly on a missing or invalid scenario: a suite that silently
// shrinks is the moving-corpus problem this replaces.
export const loadScenarios = (
  manifestPath: string,
  opts: { suite?: string; split?: string } = {},
): LoadedScenario[] => {
  const split = opts.split === undefined ? undefined : SplitSchema.parse(opts.split);
  const selected = readManifest(manifestPath).filter(
    (s) => (!opts.suite || s.suite === opts.suite) && (!split || s.split === split),
  );
  if (selected.length === 0) {
    throw new Error(
      `no scenarios${opts.suite ? ` in suite "${opts.suite}"` : ""}${split ? ` in split "${split}"` : ""}`,
    );
  }
  return selected.map((scenario) => {
    const path = join(dirname(manifestPath), scenario.record);
    const parsed = ReviewRecordSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
    if (!parsed.success) {
      throw new Error(`scenario ${scenario.id}: invalid ReviewRecord at ${scenario.record}: ${parsed.error.message}`);
    }
    return { scenario, record: parsed.data };
  });
};

// The report names a case by its scenario id rather than its run id.
export const scenarioNames = (loaded: LoadedScenario[]): Map<string, string> =>
  new Map(loaded.map(({ scenario, record }) => [record.runId, scenario.id]));

// Keyed like scenarioNames, so the report can split cases without a lookup.
export const scenarioSplits = (loaded: LoadedScenario[]): Map<string, Scenario["split"]> =>
  new Map(loaded.map(({ scenario, record }) => [record.runId, scenario.split]));

export const saveCases = (records: ReviewRecord[], dir: string): void => {
  mkdirSync(dir, { recursive: true });
  for (const record of records) {
    writeFileSync(
      join(dir, `${record.runId}.json`),
      JSON.stringify(record, null, 2),
    );
  }
};
