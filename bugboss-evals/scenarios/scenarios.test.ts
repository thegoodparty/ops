import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { loadScenario } from "../core/scenario";
import type { AwsData } from "../sim/standins/aws-data";
import type { TelemetryBatch, TelemetryGenerator } from "../sim/telemetry/types";

// Fast, always-on checks over every scenario directory. The slow proof that
// each hidden check fails at baseSha and passes at provingFixSha is in
// prove.test.ts.

const SCENARIOS = __dirname;
const ids = readdirSync(SCENARIOS).filter((id) =>
  existsSync(join(SCENARIOS, id, "scenario.json")),
);

const HOUR = 3_600_000;
const ALERT_AT = Date.UTC(2026, 0, 1, 12);

// Shapes that only production data would carry. A synthetic scenario has no
// reason to contain any of them, so finding one means something was copied.
const PROD_MARKERS: [string, RegExp][] = [
  ["a Slack user group mention", /<!subteam\^/],
  ["a Slack user id", /\bU0[0-9A-Z]{8,}\b/],
  ["the production Grafana host", /goodparty\.grafana\.net/],
  ["a goodparty.org email other than a test one", /\b(?!tests@|oncall@|bugboss@)[a-z0-9.+-]+@goodparty\.org\b/i],
  ["a Clerk user id", /\buser_[A-Za-z0-9]{24,}\b/],
];

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

const loadGenerator = (dir: string, file: string): TelemetryGenerator => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(join(dir, file));
  return (mod.default ?? mod) as TelemetryGenerator;
};

const byteCount = (batch: TelemetryBatch) =>
  JSON.stringify(batch).length;

for (const id of ids) {
  const { scenario, dir } = loadScenario(join(SCENARIOS, id, "scenario.json"));

  test(`${id}: scenario.json is valid and names files that exist`, () => {
    assert.equal(scenario.id, id, "the id matches the directory name");
    for (const file of [
      scenario.alert.file,
      scenario.telemetry.generator,
      scenario.aws.data,
      scenario.check.command,
      scenario.persona.file,
      scenario.reference,
      ...(scenario.check.setup ? [scenario.check.setup] : []),
    ]) {
      assert.ok(existsSync(join(dir, file)), `${file} exists`);
    }
    assert.notEqual(scenario.omni.baseSha, scenario.omni.provingFixSha);
    const [lo, hi] = scenario.persona.replyDelaySeconds;
    assert.ok(lo <= hi, "reply delay range is ordered");
  });

  test(`${id}: the hidden check is never shown to the agent's CI`, () => {
    for (const command of scenario.ci.visible) {
      assert.doesNotMatch(command, /check\//, "visible CI does not run the hidden check");
    }
    assert.match(scenario.check.command, /^check\//);
  });

  test(`${id}: alert.json is a firing Grafana delivery BugBoss can ingest`, () => {
    const body = JSON.parse(readFileSync(join(dir, scenario.alert.file), "utf8"));
    assert.equal(body.status, "firing");
    assert.ok(Array.isArray(body.alerts) && body.alerts.length > 0);
    for (const alert of body.alerts) {
      assert.equal(alert.status, "firing");
      assert.ok(alert.fingerprint, "a fingerprint is BugBoss's dedup key");
      assert.ok(alert.labels?.alertname && alert.labels?.alert_slug);
      assert.equal(alert.labels.environment, "prod");
      assert.ok(alert.annotations?.summary);
      assert.ok(!Number.isNaN(Date.parse(alert.startsAt)));
    }
  });

  test(`${id}: aws.json has the AwsData shape`, () => {
    const data = JSON.parse(readFileSync(join(dir, scenario.aws.data), "utf8")) as AwsData;
    assert.ok(Array.isArray(data.cloudwatch));
    for (const series of data.cloudwatch) {
      assert.ok(series.namespace && series.metricName && series.unit);
      assert.equal(typeof series.dimensions, "object");
      for (const point of series.datapoints) {
        assert.equal(typeof point.ts, "number");
        assert.equal(typeof point.value, "number");
      }
    }
    assert.ok(data.ecs.clusters.length > 0);
    for (const service of data.ecs.services) {
      assert.ok(data.ecs.clusters.includes(service.cluster), `${service.name}'s cluster is listed`);
    }
    assert.ok(Array.isArray(data.secretsManager.names));
  });

  test(`${id}: nothing in the scenario looks copied from production`, () => {
    for (const file of filesUnder(dir)) {
      const text = readFileSync(file, "utf8");
      for (const [what, pattern] of PROD_MARKERS) {
        assert.doesNotMatch(text, pattern, `${file} contains ${what}`);
      }
    }
  });

  test(`${id}: the telemetry generator is deterministic and tells fault from healthy`, () => {
    const gen = loadGenerator(dir, scenario.telemetry.generator);
    const hoursBefore = scenario.telemetry.backfillHoursBefore;

    const a = gen.backfill({ alertAt: ALERT_AT, hoursBefore, seed: 7 });
    const b = gen.backfill({ alertAt: ALERT_AT, hoursBefore, seed: 7 });
    assert.deepEqual(a, b, "same seed, same world");
    assert.ok(a.logs.length > 0, "the backfill has logs");
    for (const line of a.logs) {
      assert.ok(line.ts >= ALERT_AT - hoursBefore * HOUR && line.ts <= ALERT_AT, "backfill stays in its window");
      assert.ok(line.labels.service_name && line.labels.deployment_environment_name);
    }
    for (const sample of a.samples) {
      assert.ok(sample.ts >= ALERT_AT - hoursBefore * HOUR && sample.ts <= ALERT_AT);
      assert.ok(Number.isFinite(sample.value));
    }

    const window = { from: ALERT_AT, to: ALERT_AT + HOUR, seed: 7 };
    const fault = gen.live({ ...window, state: "fault" });
    const healthy = gen.live({ ...window, state: "healthy" });
    assert.deepEqual(fault, gen.live({ ...window, state: "fault" }));
    for (const batch of [fault, healthy]) {
      for (const line of batch.logs) {
        assert.ok(line.ts >= window.from && line.ts < window.to, "live stays in its window");
      }
    }
    assert.notDeepEqual(fault, healthy, "the fault changes what the world shows");
    assert.ok(healthy.logs.length > 0, "a healthy service still logs");
    // Generous: an hour of one service's synthetic logs has no business
    // approaching what Loki would reject in a single push.
    assert.ok(byteCount(fault) < 64 * 1024 * 1024);
  });
}
