// The end-to-end contract. Written in Phase 0, before the fan-out, so the
// interfaces in types.ts are exercised rather than merely declared.
//
// This SHOULD FAIL until Phase 2 wires the composition root. That is the
// point: it is the acceptance gate for the whole build, and the place where
// nine chunks find out whether they fit.
//
// Design spec: docs/bugboss/design.md

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createBugBoss, type BugBoss } from "../index";
import type { BugBossConfig, TriageDecision } from "../types";

// --- fakes -----------------------------------------------------------------

/** Stands in for Bedrock. Triage and the Slack agent call this. */
const fakeModel = {
  triageDecisions: [] as TriageDecision[],
  next(): TriageDecision {
    const d = this.triageDecisions.shift();
    if (!d) throw new Error("fakeModel: no triage decision queued");
    return d;
  },
};

/** Captures what would have been posted, so assertions can read the thread. */
const fakeSlack = {
  posts: [] as { threadTs: string | null; text: string }[],
  post(threadTs: string | null, text: string) {
    this.posts.push({ threadTs, text });
    return Promise.resolve({ ts: `ts-${this.posts.length}` });
  },
};

/**
 * Stands in for a spawned incident agent. Rather than running Pi, it drives
 * the tool API through the same sequence a real agent would.
 */
const fakeAgent = async (tools: BugBoss["toolApiFor"] extends never ? never : any) => {
  await tools.reportRootCause({
    cause: "Pro upgrade webhook wrote to the wrong column",
    explainedSignalIds: ["sig-1"],
    usersImpacted: 3,
    impactQuery: '{service_name="gp-api"} |= "pro_upgrade"',
  });
  await tools.reportResolved({
    prUrls: ["https://github.com/thegoodparty/omni/pull/9999"],
    evidence: "two clean runs through the flow after deploy",
  });
  await tools.reportAnalysis({
    postmortem: "# Summary\nBad column in the upgrade webhook.",
    usersImpacted: 3,
    impactQuery: '{service_name="gp-api"} |= "pro_upgrade"',
  });
};

// --- setup -----------------------------------------------------------------

let dir: string;
let boss: BugBoss;

const config = (path: string): BugBossConfig => ({
  env: "prod",
  s3Bucket: "bugboss-test",
  dbPath: path,
  slackChannelId: "C0TEST",
  dispatcher: {
    maxConcurrentAgents: 15,
    tickSeconds: 30,
    agentTimeoutSeconds: 1800,
    maxAttempts: 3,
  },
  prodCriticalSlugs: [],
});

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-e2e-"));
  boss = await createBugBoss({
    config: config(join(dir, "test.db")),
    // Every external dependency is injected, which is what makes this test
    // possible and what keeps the composition root honest.
    model: fakeModel as never,
    slack: fakeSlack as never,
    spawnAgent: fakeAgent as never,
    s3: undefined,
  });
});

after(() => {
  boss?.stop();
  rmSync(dir, { recursive: true, force: true });
});

// --- the happy path --------------------------------------------------------

test("a Grafana alert becomes a resolved, written-up incident", async () => {
  fakeModel.triageDecisions.push({
    action: "new_incident",
    reason: "500s on /campaigns, no matching open incident",
  });

  await boss.ingest("grafana", {
    headers: { "x-grafana-alerting-signature": "valid-in-test" },
    rawBody: JSON.stringify({
      status: "firing",
      alerts: [
        {
          status: "firing",
          fingerprint: "fp-1",
          labels: { alert_slug: "campaigns-route-errors", environment: "prod" },
          annotations: { summary: "[PROD] Route errors detected" },
          startsAt: new Date().toISOString(),
        },
      ],
    }),
  });

  const open = boss.db.query<{ id: string; status: string }>(
    "SELECT id, status FROM incident WHERE status NOT IN ('CLOSED','MERGED')",
  );
  assert.equal(open.length, 1, "triage should have opened exactly one incident");

  await boss.dispatchOnce();

  const [incident] = boss.db.query<{
    status: string;
    rootCause: string | null;
    usersImpacted: number | null;
    postmortem: string | null;
    resolvedAt: number | null;
  }>("SELECT status, rootCause, usersImpacted, postmortem, resolvedAt FROM incident");

  assert.equal(incident.status, "CLOSED");
  assert.match(incident.rootCause ?? "", /wrong column/);
  assert.equal(incident.usersImpacted, 3);
  assert.ok(incident.postmortem, "a post-mortem is required to reach CLOSED");
  assert.ok(incident.resolvedAt, "resolvedAt must be set before CLOSED");
});

test("a second alert for the same cause attaches rather than opening", async () => {
  fakeModel.triageDecisions.push({
    action: "new_incident",
    reason: "first of its kind",
  });
  await boss.ingest("grafana", grafanaBody("fp-2", "briefings-route-errors"));

  fakeModel.triageDecisions.push({
    action: "attach",
    incidentId: boss.db.get<{ id: string }>(
      "SELECT id FROM incident WHERE status = 'INVESTIGATING' LIMIT 1",
    )!.id,
    reason: "same shape as the open incident",
  });
  await boss.ingest("grafana", grafanaBody("fp-3", "briefings-route-errors"));

  const investigating = boss.db.query(
    "SELECT id FROM incident WHERE status = 'INVESTIGATING'",
  );
  assert.equal(investigating.length, 1, "the second alert must not open a second incident");

  const signals = boss.db.query("SELECT id FROM signal WHERE incidentId IS NOT NULL");
  assert.ok(signals.length >= 2, "both signals should be attached");
});

test("nothing auto-closes when a signal goes quiet", async () => {
  fakeModel.triageDecisions.push({ action: "new_incident", reason: "real" });
  await boss.ingest("grafana", grafanaBody("fp-4", "people-route-errors"));

  await boss.tickResolution();

  const still = boss.db.get<{ status: string }>(
    "SELECT status FROM incident WHERE id = (SELECT incidentId FROM signal WHERE sourceId = 'fp-4')",
  );
  assert.notEqual(
    still?.status,
    "RESOLVED",
    "a quiet signal is evidence for an agent, never an automatic transition",
  );
});

const grafanaBody = (fingerprint: string, slug: string) => ({
  headers: { "x-grafana-alerting-signature": "valid-in-test" },
  rawBody: JSON.stringify({
    status: "firing",
    alerts: [
      {
        status: "firing",
        fingerprint,
        labels: { alert_slug: slug, environment: "prod" },
        annotations: { summary: `[PROD] ${slug}` },
        startsAt: new Date().toISOString(),
      },
    ],
  }),
});
