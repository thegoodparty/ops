import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { main } from "./cli";
import { fixture, postPrRun } from "./fixtures";
import { billedTurns, coldCause, isCold, milestones } from "./metrics";
import { contextTokens, deriveRates, ratesFor, type Rates } from "./price";
import { renderReport } from "./report";
import { parsePiSession } from "./adapters/pi-session";
import {
  keepAlive,
  phaseReset,
  prefixTrim,
  priceWorld,
  reprice,
  todayWorld,
  type PhaseReset,
} from "./whatif";

const RATES: Rates = ratesFor("us.anthropic.claude-opus-5");

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !== ${expected}`);

test("today's world turns a 5m-TTL miss inside an hour warm and writes at the 1h rate", () => {
  const run = parsePiSession(
    "t",
    fixture()
      .launch(0)
      .turn({ at: 0, read: 0, write: 70_000, api: "bedrock-converse-stream", calls: [{ name: "monitor" }] })
      .turn({ at: 10, read: 0, write: 75_000, api: "bedrock-converse-stream" })
      .jsonl(),
  );
  const second = billedTurns(run)[1];
  assert.equal(isCold(second.turn), true);
  assert.equal(coldCause(second), "wait_over_ttl");

  const world = todayWorld(run);
  assert.deepEqual(world.turns[1], {
    input: 2,
    output: 100,
    cacheRead: 70_000,
    cacheWrite: 5_000,
    writeTtl: "1h",
  });
  assert.equal(world.turns[0].writeTtl, "1h");
});

test("keep-alive warms a 3h in-process wait and pays for its pings", () => {
  const run = postPrRun();
  const waited = billedTurns(run).find((entry) => entry.turn.index === 6)!;
  assert.equal(isCold(waited.turn), true);
  assert.equal(coldCause(waited), "wait_over_ttl");
  assert.equal(waited.relaunched, false);
  assert.ok(waited.gapMs > 60 * 60_000);

  const base = todayWorld(run);
  const warm = keepAlive(run, base, { everyMinutes: 55, ttlMinutes: 60 });
  assert.equal(warm.extras.length, 3);
  assert.equal(warm.turns[5].cacheRead, 150_000);
  assert.equal(warm.turns[5].cacheWrite, 2_000);

  const ping = 150_000 * RATES.cacheRead + RATES.output;
  const expected =
    150_000 * RATES.cacheWrite1h - 150_000 * RATES.cacheRead - 3 * ping;
  close(reprice(base, warm, RATES).savingUsd, expected);
});

test("keep-alive never pings or warms a relaunch gap", () => {
  const run = postPrRun();
  const relaunches = billedTurns(run).filter(
    (entry) => entry.relaunched && isCold(entry.turn),
  );
  assert.deepEqual(
    relaunches.map((entry) => [entry.turn.index, entry.gapMs > 60 * 60_000]),
    [
      [11, true],
      [13, true],
    ],
  );
  const base = todayWorld(run);
  const warm = keepAlive(run, base, { everyMinutes: 5, ttlMinutes: 60 });
  assert.deepEqual(warm.turns[10], base.turns[10]);
  assert.deepEqual(warm.turns[12], base.turns[12]);
  const inProcessPings = billedTurns(run)
    .filter((entry) => entry.previous && !entry.relaunched)
    .reduce(
      (sum, entry) => sum + Math.max(0, Math.ceil(entry.gapMs / (5 * 60_000)) - 1),
      0,
    );
  assert.equal(warm.extras.length, inProcessPings);
});

test("prefix trim takes the tokens from the read on warm turns and the write on cold ones", () => {
  const run = postPrRun();
  const base = todayWorld(run);
  assert.equal(base.frozen[12], true);
  const cold = base.turns
    .map((turn, slot) => ({ turn, slot }))
    .filter(({ turn }) => contextTokens(turn) > 0)
    .filter(({ turn }) => turn.cacheWrite > 0.5 * contextTokens(turn));
  assert.deepEqual(
    cold.map(({ slot }) => slot + 1),
    [1, 6, 11, 13, 14],
  );
  const warmTurns = base.turns.filter(
    (turn) => contextTokens(turn) > 0 && turn.cacheRead > 0.5 * contextTokens(turn),
  ).length;
  assert.equal(warmTurns, 8);

  const trimmed = prefixTrim(base, 10_000);
  const expected =
    4 * 10_000 * RATES.cacheWrite1h + warmTurns * 10_000 * RATES.cacheRead;
  close(reprice(base, trimmed, RATES).savingUsd, expected);
  assert.deepEqual(trimmed.turns[12], base.turns[12]);
});

const resetRun = () =>
  parsePiSession(
    "r",
    fixture()
      .launch(0)
      .turn({ at: 0, read: 0, write: 70_000 })
      .turn({ at: 1, read: 70_000, write: 50_000, calls: [{ name: "report_root_cause" }] })
      .turn({ at: 2, read: 120_000, write: 10_000 })
      .turn({
        at: 3,
        read: 130_000,
        write: 20_000,
        calls: [{ name: "bash", args: { command: "gh pr create -f" } }],
      })
      .turn({ at: 4, read: 150_000, write: 10_000 })
      .turn({ at: 5, read: 160_000, write: 10_000 })
      .jsonl(),
  );

const RESET: PhaseReset = {
  handoffTokens: 10_000,
  handoffOutputTokens: 0,
  reorientTurns: 0,
  reorientOutputTokens: 0,
  reorientWriteTokens: 0,
  prefixCached: false,
  minContextTokens: 0,
};

test("a phase reset carries prefix + handoff + growth instead of the history", () => {
  const run = resetRun();
  assert.deepEqual(milestones(run), { rootCauseTurn: 2, prOpenTurn: 4 });
  const base = todayWorld(run);
  const fresh = 70_002 + 10_000;
  assert.ok(contextTokens(base.turns[5]) > fresh);

  const reset = phaseReset(run, base, RESET);
  assert.equal(contextTokens(reset.turns[2]), 90_002);
  assert.equal(reset.turns[2].cacheRead, 0);
  assert.equal(contextTokens(reset.turns[3]), 110_002);
  assert.equal(contextTokens(reset.turns[4]), 90_002);
  assert.equal(contextTokens(reset.turns[5]), 100_002);
  assert.equal(reset.turns[5].cacheWrite, 10_000);
  assert.deepEqual(
    reset.extras.map((extra) => extra.cacheRead),
    [120_002, 150_002],
  );
  close(
    reprice(base, reset, RATES).savingUsd,
    109_996 * RATES.cacheRead - 160_000 * RATES.cacheWrite1h,
  );
});

test("a gated reset skips a milestone whose context is under the gate", () => {
  const run = resetRun();
  const base = todayWorld(run);
  assert.ok(contextTokens(base.turns[1]) < 140_000);
  assert.ok(contextTokens(base.turns[3]) >= 140_000);
  const gated = phaseReset(run, base, { ...RESET, minContextTokens: 140_000 });
  assert.deepEqual(gated.turns[2], base.turns[2]);
  assert.equal(gated.extras.length, 1);
});

test("a run that never reaches a milestone is priced the same with a reset", () => {
  const run = parsePiSession(
    "n",
    fixture()
      .launch(0)
      .turn({ at: 0, read: 0, write: 70_000 })
      .turn({ at: 1, read: 70_000, write: 90_000 })
      .jsonl(),
  );
  assert.deepEqual(milestones(run), { rootCauseTurn: null, prOpenTurn: null });
  const base = todayWorld(run);
  close(priceWorld(phaseReset(run, base, RESET), RATES).total, priceWorld(base, RATES).total);
});

test("the report and CLI run end to end over a directory of transcripts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bugboss-evals-"));
  try {
    await writeFile(join(dir, "a.jsonl"), fixture().launch(0).turn({ at: 0, read: 0, write: 10 }).jsonl());
    const out = join(dir, "report.md");
    assert.equal(await main([dir, "--out", out]), 0);
    const report = await readFile(out, "utf8");
    assert.match(report, /## Ranked levers/);
    assert.match(report, /Cache keep-alive during long waits/);
    const { rates } = deriveRates([postPrRun()]);
    assert.ok(rates.cacheRead > 0);
    assert.match(renderReport([postPrRun()]), /\| 13 \(.*\)|relaunch_after_crash_loop/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the CLI refuses a flag with no value and a source with no transcripts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bugboss-evals-"));
  try {
    assert.equal(await main([dir, "--out"]), 2);
    assert.equal(await main(["--focus", "--out", "x.md", dir]), 2);
    assert.equal(await main([dir]), 2);
    assert.throws(() => renderReport([]), /at least one transcript/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
