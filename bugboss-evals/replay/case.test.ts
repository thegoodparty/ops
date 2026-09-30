import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { compare, type PairRecord } from "../core/aggregate";
import { renderComparison } from "../core/report";
import { loadCase, referenceFor, ReplayCaseSchema, SCENARIOS_DIR } from "./case";

const CASES_DIR = join(__dirname, "cases");
const cases = readdirSync(CASES_DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({ name, replayCase: loadCase(join(CASES_DIR, name)) }));

test("every case names an existing scenario for its own incident, or carries the no-vetted-reference flag", () => {
  assert.ok(cases.length > 0);
  for (const { name, replayCase } of cases) {
    if (replayCase.scenario === null) {
      assert.equal(replayCase.noVettedReference, true, `${name} has no scenario and no flag`);
      assert.deepEqual(referenceFor(replayCase), { vetted: false });
      continue;
    }
    assert.ok(existsSync(join(SCENARIOS_DIR, replayCase.scenario, "scenario.json")), `${name} names ${replayCase.scenario}`);
    const reference = referenceFor(replayCase);
    assert.equal(reference.vetted, true);
    if (reference.vetted) assert.ok(reference.reference.trim() !== "", `${name}: empty reference.md`);
  }
});

test("the three vetted scenarios are the ones incidents 2, 10 and 5 point at", () => {
  const byIncident = Object.fromEntries(cases.map(({ replayCase }) => [replayCase.sourceIncident, replayCase.scenario]));
  assert.equal(byIncident[2], "ecanvasser-sync-timeout");
  assert.equal(byIncident[10], "users-read-invalid-zip");
  assert.equal(byIncident[5], "p2p-phone-list-late-cap");
  for (const incident of [3, 80, 83]) assert.equal(byIncident[incident], null);
});

test("a case sets exactly one of scenario and the flag", () => {
  const base = cases[0].replayCase;
  assert.equal(ReplayCaseSchema.safeParse({ ...base, scenario: null, noVettedReference: undefined }).success, false);
  assert.equal(ReplayCaseSchema.safeParse({ ...base, scenario: "ecanvasser-sync-timeout", noVettedReference: true }).success, false);
});

test("a scenario from another incident, or one that is missing, is an error rather than a silent no-reference", () => {
  const base = cases.find(({ replayCase }) => replayCase.sourceIncident === 2)?.replayCase;
  assert.ok(base);
  assert.throws(() => referenceFor({ ...base, sourceIncident: 99 }), /is incident 99 but scenario/);
  assert.throws(() => referenceFor({ ...base, scenario: "no-such-scenario" }), /has no/);
});

test("every flagged case shows up as no vetted reference in the Tier 2 report", () => {
  const run = { status: "completed" as const, costUsd: 5, wallClockSeconds: 600, gates: { merged: true } };
  const pairs: PairRecord[] = cases.map(({ replayCase }) => ({
    pairId: `${replayCase.id}/rep-1`,
    scenarioId: replayCase.id,
    rep: 1,
    baseline: run,
    candidate: run,
    verdict: null,
    vettedReference: referenceFor(replayCase).vetted,
  }));
  const text = renderComparison({ comparison: compare(pairs), tier: "Tier 2", baselineRef: "main", candidateRef: "feat/x" });
  for (const { replayCase } of cases) {
    const flagged = new RegExp(`\\| ${replayCase.id}/rep-1 \\| ${replayCase.id} \\| no vetted reference \\|`).test(text);
    assert.equal(flagged, replayCase.noVettedReference === true, replayCase.id);
  }
});
