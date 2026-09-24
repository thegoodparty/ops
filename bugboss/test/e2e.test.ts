// The end-to-end contract. Written in Phase 0, before the fan-out, so the
// interfaces in types.ts are exercised rather than merely declared.
//
// Four fakes stand in for everything outside the process: the model, Slack,
// the spawned agent, and S3. Everything between them is the real thing —
// real webhook parsing, real triage rules, real assign, real tool API, real
// dispatcher, real SQLite with its snapshot write path.
//
// Design spec: docs/bugboss/design.md

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createBugBoss, type BugBoss } from "../index";
import { createBossClient } from "../agent/run";
import type { AgentSpawnContext } from "../dispatcher";
import type { ModelReply, ModelRequest } from "../triage";
import type { BugBossConfig, TriageDecision } from "../types";

// --- fakes -----------------------------------------------------------------

/**
 * Stands in for Bedrock. Answers triage's `decide` tool from a queue, which
 * means the real prompt, the real answer schema and the real rule enforcement
 * in triage/triage.ts all run against these decisions.
 */
const fakeModel = {
  triageDecisions: [] as TriageDecision[],
  next(): TriageDecision {
    const d = this.triageDecisions.shift();
    if (!d) throw new Error("fakeModel: no triage decision queued");
    return d;
  },
  complete(request: ModelRequest): Promise<ModelReply> {
    const call = (name: string, input: Record<string, unknown>) =>
      Promise.resolve({
        text: "",
        toolCalls: [{ id: `call-${name}`, name, input }],
      });
    // Correlation asks a different question and must not eat a queued triage
    // decision. Nothing in these tests expects a merge.
    if (request.tools.some((tool) => tool.name === "propose")) {
      return call("propose", { merges: [] });
    }
    return call("decide", { ...this.next() });
  },
};

/** Captures what would have been posted, so assertions can read the thread. */
const fakeSlack = {
  posts: [] as { threadTs: string | null; text: string }[],
  post(threadTs: string | null, text: string) {
    this.posts.push({ threadTs, text });
    return Promise.resolve({ ts: `ts-${this.posts.length}` });
  },
  /** The Slack agent reads a thread on resume. Nothing here ever mentions it. */
  replies() {
    return Promise.resolve([]);
  },
};

/**
 * Stands in for a spawned incident agent. Rather than running Pi, it drives
 * the tool API through the same sequence a real agent would.
 */
const fakeAgent = async (tools: AgentSpawnContext) => {
  await tools.reportRootCause({
    cause: "Pro upgrade webhook wrote to the wrong column",
    explainedSignalIds: ["sig-1"],
    usersImpacted: 3,
    impactQuery: '{service_name="gp-api"} |= "pro_upgrade"',
  });

  // A real agent ships the fix and then watches the alert stop firing before
  // it claims resolution. That is not decoration: RESOLVED means no further
  // alerts should occur, so the tool API splits any signal that is still
  // firing back out into a recurrence rather than closing over it.
  await boss.ingest("grafana", grafanaBody("fp-1", "campaigns-route-errors", "resolved"));
  await boss.tickResolution();

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
    model: fakeModel,
    slack: fakeSlack,
    spawnAgent: fakeAgent,
    s3: undefined,
    // STS is an external dependency too: without this the composition root
    // would alarm and hand the child no AWS access at all.
    credentials: async () => ({
      accessKeyId: "test",
      secretAccessKey: "test",
      sessionToken: "test",
    }),
    // The webhook bodies below carry no real signature, no timestamp and no
    // basic auth, so verification is replaced outright. This seam exists for
    // this file alone; bugBossFromEnv never sets it.
    insecureTestVerifiers: { grafana: () => {} },
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

  await boss.ingest("grafana", grafanaBody("fp-4", "people-route-errors", "resolved"));
  await boss.tickResolution();

  const still = boss.db.get<{ status: string }>(
    "SELECT status FROM incident WHERE id = (SELECT incidentId FROM signal WHERE sourceId = 'fp-4')",
  );
  assert.notEqual(
    still?.status,
    "RESOLVED",
    "a quiet signal is evidence for an agent, never an automatic transition",
  );
  assert.ok(
    boss.db.get<{ closedAt: number | null }>(
      "SELECT closedAt FROM signal WHERE sourceId = 'fp-4'",
    )?.closedAt,
    "the signal itself is recorded as closed",
  );
});

// --- the agent reaches its incident over loopback HTTP ---------------------

/** Drives the Boss's real loopback routes without binding a port. */
const bossClientFor = (incidentId: string, token: string) =>
  createBossClient({
    baseUrl: "http://boss.local",
    incidentId,
    authToken: token,
    fetchImpl: ((input: string, init?: RequestInit) =>
      boss.loopbackApp.fetch(new Request(input, init))) as typeof fetch,
  });

test("an incident agent reaches its own incident over the loopback API", async () => {
  const incidentId = boss.db.get<{ id: string }>(
    "SELECT id FROM incident WHERE status = 'INVESTIGATING' LIMIT 1",
  )!.id;
  const client = bossClientFor(incidentId, boss.mintToken(incidentId));

  const view = await client.getIncident();
  assert.ok(view.ok, view.error);
  assert.equal(view.data?.incident.id, incidentId);
  assert.ok(view.data!.signals.length > 0, "the agent can see its signals");
});

test("contact_human records the question before it posts, and only once", async () => {
  const incidentId = boss.db.get<{ id: string }>(
    "SELECT id FROM incident WHERE status = 'INVESTIGATING' LIMIT 1",
  )!.id;
  const client = bossClientFor(incidentId, boss.mintToken(incidentId));

  assert.equal(await client.getPending(), null);

  const asked = await client.recordPending("Can someone merge the PR?");
  await client.post("Can someone merge the PR?");
  assert.equal(
    fakeSlack.posts.at(-1)?.text,
    "Can someone merge the PR?",
    "the agent posts its own question, in the incident thread",
  );
  assert.notEqual(
    boss.db.get<{ messageTs: string }>(
      "SELECT messageTs FROM pending_question WHERE incidentId = ?",
      [incidentId],
    )?.messageTs,
    "",
    "the ts of the posted message is recorded once it exists",
  );

  // A restart replays the tool call with no result. The second run has to
  // find the first question rather than ask the human twice.
  const replayed = await client.recordPending("Can someone merge the PR?");
  assert.equal(replayed.askedAt, asked.askedAt);

  await client.clearPending();
  assert.equal(await client.getPending(), null);
});

test("the loopback API refuses anything but this incident's own token", async () => {
  const [first, second] = boss.db.query<{ id: string }>(
    "SELECT id FROM incident ORDER BY id",
  );

  const anonymous = await boss.loopbackApp.request(`/incidents/${first.id}`);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate") ?? "", /^Bearer/);

  const forged = await boss.loopbackApp.request(`/incidents/${first.id}`, {
    headers: { authorization: "Bearer not-a-token" },
  });
  assert.equal(forged.status, 401);

  // The incident comes from the token, so a valid token cannot be pointed at
  // a different one: that is the whole containment story for a co-located
  // agent that reads attacker-writable log lines for a living.
  const crossed = await boss.loopbackApp.request(`/incidents/${second.id}`, {
    headers: { authorization: `Bearer ${boss.mintToken(first.id)}` },
  });
  assert.equal(crossed.status, 403);
});

test("health is a flat 200, which is what the target group checks", async () => {
  const res = await boss.publicApp.request("/health");
  assert.equal(res.status, 200);
});

const grafanaBody = (
  fingerprint: string,
  slug: string,
  status: "firing" | "resolved" = "firing",
) => ({
  headers: { "x-grafana-alerting-signature": "valid-in-test" },
  rawBody: JSON.stringify({
    status,
    alerts: [
      {
        status,
        fingerprint,
        labels: { alert_slug: slug, environment: "prod" },
        annotations: { summary: `[PROD] ${slug}` },
        startsAt: new Date().toISOString(),
      },
    ],
  }),
});

// --- the human-report resolve path ----------------------------------------

test("a human bug report resolves without spawning a recurrence", async () => {
  fakeModel.triageDecisions.push({
    action: "new_incident",
    reason: "nobody has reported this before",
  });
  const { incidentId } = await boss.reportSignal({
    text: "The Pro upgrade button does nothing on Safari",
    reportedBy: "someone@goodparty.org",
    via: "mcp",
  });
  assert.ok(incidentId, "triage should have placed the report");

  const tools = boss.toolApiFor(incidentId!);
  await tools.reportRootCause({
    cause: "Safari blocks the popup the upgrade flow opens",
    explainedSignalIds: boss.db
      .query<{ id: string }>("SELECT id FROM signal WHERE incidentId = ?", [
        incidentId,
      ])
      .map((r) => r.id),
  });

  // No machine source will ever tell us a human report stopped happening.
  // The agent verifying the fix IS the resolution, which is exactly what the
  // human adapter's isResolved comment says.
  const resolved = await tools.reportResolved({
    prUrls: ["https://github.com/thegoodparty/omni/pull/10000"],
    evidence: "clicked through the upgrade flow on Safari, popup opens",
  });
  assert.equal(resolved.ok, true, resolved.error);
  assert.deepEqual(
    (resolved.data as { stillFiring: string[] }).stillFiring,
    [],
    "a report with no machine resolver must not be treated as still firing",
  );

  const recurrences = boss.db.query(
    "SELECT id FROM incident WHERE recurrenceOf = ?",
    [incidentId],
  );
  assert.equal(
    recurrences.length,
    0,
    "splitting here would relaunch an agent on the bug it just fixed, forever",
  );
});
