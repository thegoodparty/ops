// The end-to-end contract. Written in Phase 0, before the fan-out, so the
// interfaces in types.ts are exercised rather than merely declared.
//
// Four fakes stand in for everything outside the process: the model, Slack,
// the spawned agent, and S3. Everything between them is the real thing —
// real webhook parsing, real triage rules, real assign, real tool API, real
// dispatcher, real SQLite with its snapshot write path.
//
// Design spec: bugboss/docs/architecture.md

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";

import {
  bossConfigFromEnv,
  createBugBoss,
  createMemoryS3,
  installCrashHandlers,
  settingsEnv,
  withSlackDeadline,
  type BugBoss,
} from "../index";
import { createBossClient } from "../agent/run";
import type { AgentSpawnContext } from "../dispatcher";
import type { ModelReply, ModelRequest } from "../triage";
import type { BugBossConfig, TriageDecision } from "../types";

type QueuedDecision = TriageDecision & { recurrenceOf?: string };

// --- fakes -----------------------------------------------------------------

/**
 * Stands in for Bedrock. Answers triage's `decide` tool from a queue, which
 * means the real prompt, the real answer schema and the real rule enforcement
 * in triage/triage.ts all run against these decisions.
 */
const fakeModel = {
  // `recurrenceOf` rides along on a new_incident decision; the decide tool's
  // schema carries it even though TriageDecision itself does not.
  triageDecisions: [] as QueuedDecision[],
  /** Held, every triage call blocks on it. Stands in for a slow model. */
  gate: null as Promise<void> | null,
  /** Runs once, inside a triage call, after its digest of open incidents. */
  beforeDecide: null as (() => Promise<void>) | null,
  /** Triage calls overlapping right now, and the high-water mark. */
  inFlight: 0,
  maxInFlight: 0,
  /** The last triage prompt, so a test can assert what triage was offered. */
  lastPrompt: "",
  next(): QueuedDecision {
    const d = this.triageDecisions.shift();
    if (!d) throw new Error("fakeModel: no triage decision queued");
    return d;
  },
  async complete(request: ModelRequest): Promise<ModelReply> {
    const call = (name: string, input: Record<string, unknown>) => ({
      text: "",
      toolCalls: [{ id: `call-${name}`, name, input }],
    });
    // Correlation asks a different question and must not eat a queued triage
    // decision. Nothing in these tests expects a merge.
    if (request.tools.some((tool) => tool.name === "propose")) {
      return call("propose", { merges: [] });
    }
    this.lastPrompt = JSON.stringify(request.messages);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.beforeDecide) {
        const hook = this.beforeDecide;
        this.beforeDecide = null;
        await hook();
      }
      if (this.gate) await this.gate;
      return call("decide", { ...this.next() });
    } finally {
      this.inFlight--;
    }
  },
};

/** Captures what would have been posted, so assertions can read the thread. */
const fakeSlack = {
  posts: [] as { threadTs: string | null; text: string }[],
  /** One refused post. Slack being down for a moment is the normal case. */
  failNextPost: false,
  post(threadTs: string | null, text: string) {
    if (this.failNextPost) {
      this.failNextPost = false;
      return Promise.reject(new Error("slack: ratelimited"));
    }
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
  const view = await tools.getIncident();
  await tools.reportRootCause({
    cause: "Pro upgrade webhook wrote to the wrong column",
    explainedSignalIds: (view.data?.signals ?? []).map((s) => s.id),
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

/** Slack's user group, which changes under us and keeps no history. */
const rotation = { members: ["U-ada", "U-grace"] as string[] | null };

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
    // Who is on call is an external fact, and a mutable one.
    rotationMembers: async () => rotation.members,
    // The webhook bodies below carry no real signature, no timestamp and no
    // basic auth, so verification is replaced outright. This seam exists for
    // this file alone; bugBossFromEnv never sets it.
    insecureTestVerifiers: { grafana: () => {}, slack: () => {} },
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

test("a resolved notification changes nothing at all", async () => {
  fakeModel.triageDecisions.push({ action: "new_incident", reason: "real" });
  await boss.ingest("grafana", grafanaBody("fp-4", "people-route-errors"));

  // An alert that stopped firing on its own has not stopped mattering: the
  // symptom went away, which is not the same as the cause being handled. So
  // the resolve is discarded, the incident stands, and closing it stays the
  // agent's job.
  await boss.ingest("grafana", grafanaBody("fp-4", "people-route-errors", "resolved"));

  const still = boss.db.get<{ status: string }>(
    "SELECT status FROM incident WHERE id = (SELECT incidentId FROM signal WHERE sourceId = 'fp-4')",
  );
  assert.notEqual(
    still?.status,
    "RESOLVED",
    "a quiet signal is evidence for an agent, never an automatic transition",
  );
  assert.equal(
    boss.db.get<{ closedAt: number | null }>(
      "SELECT closedAt FROM signal WHERE sourceId = 'fp-4'",
    )?.closedAt,
    null,
    "the signal stays open too: only an agent decides this is over",
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
  const [placed] = await boss.ingest("slack", {
    headers: {},
    rawBody: JSON.stringify({
      type: "event_callback",
      event: {
        type: "app_mention",
        user: "U-reporter",
        channel: "C0BUGS",
        ts: "1764000000.000900",
        text: "<@B0BOSS> report The Pro upgrade button does nothing on Safari",
      },
    }),
  });
  const incidentId = placed.incidentId;
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

// --- recurrence ------------------------------------------------------------

test("the same alert firing again after resolution opens a recurrence", async () => {
  fakeModel.triageDecisions.push({ action: "new_incident", reason: "first time" });
  await boss.ingest("grafana", grafanaBody("fp-9", "pro-upgrade-errors"));
  await boss.dispatchOnce();

  const first = boss.db.get<{ id: string; status: string }>(
    "SELECT id, status FROM incident WHERE id = (SELECT incidentId FROM signal WHERE sourceId = 'fp-9')",
  );
  assert.equal(first?.status, "CLOSED");

  // Grafana reuses the fingerprint, so an all-time dedup key silently
  // discards this and the premature resolution is never contradicted. This
  // is the delivery the whole recurrence story depends on.
  fakeModel.triageDecisions.push({
    action: "new_incident",
    reason: "fired again after we said it was fixed",
    recurrenceOf: first!.id,
  });
  await boss.ingest("grafana", grafanaBody("fp-9", "pro-upgrade-errors"));

  const signals = boss.db.query("SELECT id FROM signal WHERE sourceId = 'fp-9'");
  assert.equal(signals.length, 2, "the second firing must not be dropped as a duplicate");

  const reopened = boss.db.get<{ id: string; recurrenceOf: string | null }>(
    "SELECT id, recurrenceOf FROM incident WHERE recurrenceOf = ?",
    [first!.id],
  );
  assert.ok(reopened, "a premature resolution has to be contradictable");
});

// --- the webhook answers before it works -----------------------------------

const until = async (ready: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
};

const incidentOf = (sourceId: string): string | null =>
  boss.db.get<{ incidentId: string | null }>(
    "SELECT incidentId FROM signal WHERE sourceId = ?",
    [sourceId],
  )?.incidentId ?? null;

const threadOf = (incidentId: string): string | null =>
  boss.db.get<{ slackThreadTs: string | null }>(
    "SELECT slackThreadTs FROM incident WHERE id = ?",
    [incidentId],
  )?.slackThreadTs ?? null;

test("the Grafana webhook answers before triage, and places afterwards", async () => {
  let release!: () => void;
  fakeModel.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fakeModel.triageDecisions.push({
    action: "new_incident",
    reason: "the model is taking its time",
  });

  const body = grafanaBody("fp-40", "slow-triage-errors");
  const res = await boss.publicApp.request("/grafana", {
    method: "POST",
    headers: body.headers,
    body: body.rawBody,
  });

  // The contact point runs uncapped and triage costs tens of seconds an
  // alert, so a held-open request is a burst lost to a webhook timeout.
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, recorded: 1 });
  assert.ok(
    boss.db.get("SELECT id FROM signal WHERE sourceId = 'fp-40'"),
    "the row is durable before the 200, so a retry dedups onto it",
  );
  assert.equal(incidentOf("fp-40"), null, "and triage has not run yet");

  release();
  fakeModel.gate = null;
  await until(() => incidentOf("fp-40") !== null, "fp-40 to be placed");
});

// --- a signal that reached no incident is never abandoned ------------------

/**
 * What a container leaves on disk when it dies between recording a signal and
 * placing it: a durable row with no incident, which nothing else looks at
 * because it joins through incident, and which a redelivery used to answer
 * "duplicate" to.
 */
const orphanSignal = (id: string, sourceId: string, slug: string) =>
  boss.db.withWrite((w) => {
    w.prepare(
      `INSERT INTO signal
         (id, source, sourceId, kind, title, body, labels, reportedBy, openedAt, closedAt, incidentId, explained)
       VALUES (?, 'grafana', ?, 'alert', ?, ?, ?, NULL, ?, NULL, NULL, 0)`,
    ).run(
      id,
      sourceId,
      `[PROD] ${slug}`,
      "recorded, then the process died before it was placed",
      JSON.stringify({ alert_slug: slug, environment: "prod" }),
      Date.now(),
    );
  });

test("a redelivery places a signal that was recorded but never placed", async () => {
  await orphanSignal("sig-orphan-a", "fp-70", "orphan-redelivery-errors");

  fakeModel.triageDecisions.push({
    action: "new_incident",
    reason: "nothing open covers this",
  });
  const [placed] = await boss.ingest(
    "grafana",
    grafanaBody("fp-70", "orphan-redelivery-errors"),
  );

  assert.notEqual(
    placed.action,
    "duplicate",
    "a row with no incident is not a duplicate, it is the last chance to place it",
  );
  assert.equal(placed.signalId, "sig-orphan-a");
  assert.ok(incidentOf("fp-70"), "the redelivery is what finally placed it");
});

test("the sweep places a signal no redelivery will ever repeat", async () => {
  await orphanSignal("sig-orphan-b", "fp-71", "orphan-sweep-errors");

  assert.equal(
    incidentOf("fp-71"),
    null,
    "nothing but the sweep looks at a signal with no incident",
  );

  fakeModel.triageDecisions.push({ action: "new_incident", reason: "swept up" });
  assert.equal(await boss.sweepOrphans(), 1);
  assert.ok(incidentOf("fp-71"), "the sweep is the only thing that recovers it");
});

test("an attach target that merges away mid-triage opens a new incident", async () => {
  fakeModel.triageDecisions.push({ action: "new_incident", reason: "the target" });
  await boss.ingest("grafana", grafanaBody("fp-81", "merge-target-errors"));
  const target = incidentOf("fp-81")!;
  const into = boss.db.get<{ id: string }>(
    "SELECT id FROM incident WHERE status = 'CLOSED' LIMIT 1",
  )!.id;

  fakeModel.triageDecisions.push({
    action: "attach",
    incidentId: target,
    reason: "the same problem as the open incident",
  });
  // Triage answers against a digest read before the model call, so its target
  // can be absorbed by a correlation merge while it is still thinking.
  fakeModel.beforeDecide = () =>
    boss.db.withWrite((w) => {
      w.prepare(
        "UPDATE incident SET status = 'MERGED', mergedInto = ? WHERE id = ?",
      ).run(into, target);
    });

  const [placed] = await boss.ingest(
    "grafana",
    grafanaBody("fp-82", "merge-victim-errors"),
  );

  assert.notEqual(
    placed.action,
    "failed",
    "a target that vanished mid-triage must not strand the signal",
  );
  const landed = incidentOf("fp-82");
  assert.ok(landed, "the signal reached an incident");
  assert.notEqual(landed, target);
});

// --- a thread follows an incident, not an ingest ---------------------------

test("an incident created by a split gets a thread of its own", async () => {
  fakeModel.triageDecisions.push({ action: "new_incident", reason: "first" });
  await boss.ingest("grafana", grafanaBody("fp-50", "split-parent-errors"));
  const parent = incidentOf("fp-50")!;

  fakeModel.triageDecisions.push({
    action: "attach",
    incidentId: parent,
    reason: "looks like the same thing",
  });
  await boss.ingest("grafana", grafanaBody("fp-51", "split-child-errors"));

  const explained = boss.db.get<{ id: string }>(
    "SELECT id FROM signal WHERE sourceId = 'fp-50'",
  )!;
  const reported = await boss.toolApiFor(parent).reportRootCause({
    cause: "only the first alert is this bug",
    explainedSignalIds: [explained.id],
  });
  assert.ok(reported.ok, reported.error);

  const split = incidentOf("fp-51")!;
  assert.notEqual(split, parent, "the unexplained signal splits into its own incident");
  assert.ok(
    threadOf(split),
    "without a thread its agent posts top level and contact_human can never be answered",
  );
});

test("a thread that failed to open is opened on the next pass", async () => {
  fakeSlack.failNextPost = true;
  fakeModel.triageDecisions.push({ action: "new_incident", reason: "slack is down" });
  await boss.ingest("grafana", grafanaBody("fp-60", "slack-down-errors"));

  const incidentId = incidentOf("fp-60")!;
  assert.equal(threadOf(incidentId), null, "the opening post was refused");

  assert.ok((await boss.ensureIncidentThreads()) >= 1);
  assert.ok(threadOf(incidentId), "a refused post costs a delay, not the thread");
});

// --- Slack cannot hold anything open ---------------------------------------

test("a Slack call that never answers is bounded, not silently queued", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const stalled = withSlackDeadline({
      post: () => new Promise(() => {}),
      replies: () => new Promise(() => {}),
    });
    // The SDK retries a 429 for half an hour by default and raises nothing
    // while it does, which is how one throttled channel stops the ingest path.
    const rejected = assert.rejects(stalled.post(null, "anything"), /exceeded/);
    mock.timers.tick(60_000);
    await rejected;
  } finally {
    mock.timers.reset();
  }
});

// --- a burst is not a queue ------------------------------------------------

const grafanaBurst = (fingerprints: string[], slug: string) => ({
  headers: { "x-grafana-alerting-signature": "valid-in-test" },
  rawBody: JSON.stringify({
    status: "firing",
    alerts: fingerprints.map((fingerprint) => ({
      status: "firing",
      fingerprint,
      labels: { alert_slug: `${slug}-${fingerprint}`, environment: "prod" },
      annotations: { summary: `[PROD] ${slug} ${fingerprint}` },
      startsAt: new Date().toISOString(),
    })),
  }),
});

test("the alerts in one delivery triage together, not one after another", async () => {
  let release!: () => void;
  fakeModel.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fakeModel.maxInFlight = 0;
  for (const reason of ["one", "two", "three"]) {
    fakeModel.triageDecisions.push({ action: "new_incident", reason });
  }

  const burst = boss.ingest(
    "grafana",
    grafanaBurst(["fp-90", "fp-91", "fp-92"], "burst"),
  );
  try {
    // Sequentially this is three 55s model calls before the last alert has an
    // agent, and uncapped contact points make fifty possible.
    await until(() => fakeModel.maxInFlight > 1, "two triage calls to overlap");
  } finally {
    release();
    fakeModel.gate = null;
  }

  const placed = await burst;
  assert.equal(placed.length, 3);
  assert.deepEqual(
    placed.map((p) => p.incidentId !== null),
    [true, true, true],
    "every alert in the burst is placed, in delivery order",
  );
});

// --- owner is an axis of its own -------------------------------------------

test("triage is not offered an incident a human already owns", async () => {
  fakeModel.triageDecisions.push({ action: "new_incident", reason: "handed off later" });
  await boss.ingest("grafana", grafanaBody("fp-95", "handed-off-marker-errors"));
  const owned = incidentOf("fp-95")!;
  await boss.db.withWrite((w) => {
    w.prepare("UPDATE incident SET owner = 'human' WHERE id = ?").run(owned);
  });

  fakeModel.triageDecisions.push({ action: "new_incident", reason: "unrelated" });
  await boss.ingest("grafana", grafanaBody("fp-96", "unrelated-errors"));

  assert.ok(
    !fakeModel.lastPrompt.includes("handed-off-marker-errors"),
    "assign refuses a boss write into a human-owned incident, so proposing one can only produce a refusal",
  );
});

// --- the delivery that cannot be recorded is not answered 200 --------------

test("a delivery that cannot be written answers a failure, not ok", async () => {
  const refusing = createMemoryS3();
  const send = refusing.send.bind(refusing) as (c: unknown) => Promise<unknown>;
  refusing.send = ((command: { constructor: { name: string } }) =>
    command.constructor.name === "PutObjectCommand"
      ? Promise.reject(new Error("s3 is refusing writes"))
      : send(command)) as typeof refusing.send;

  const halted = await createBugBoss({
    config: config(join(dir, "halted.db")),
    model: fakeModel,
    slack: fakeSlack,
    spawnAgent: fakeAgent,
    s3: refusing,
    insecureTestVerifiers: { grafana: () => {} },
  });

  try {
    const body = grafanaBody("fp-99", "unwritable-errors");
    const res = await halted.publicApp.request("/grafana", {
      method: "POST",
      headers: body.headers,
      body: body.rawBody,
    });
    // Placement failures are recovered by the sweep, but a row that never
    // landed has nothing to sweep, so this one delivery is the only chance
    // and the source has to be told to send it again.
    assert.equal(res.status, 500);
  } finally {
    halted.stop();
  }
});

// --- configuration a person supplies reaches the code that needs it --------

const withBlob = (settings: Record<string, string>): NodeJS.ProcessEnv =>
  settingsEnv({ BUGBOSS_SECRETS: JSON.stringify(settings) });

test("the prod-critical allowlist can be delivered in the secret blob", () => {
  const cfg = bossConfigFromEnv(
    withBlob({
      BUGBOSS_BUCKET: "bugboss-prod",
      BUGBOSS_SLACK_CHANNEL_ID: "C0PROD",
      BUGBOSS_PROD_CRITICAL_SLUGS: "pro-upgrade-errors, checkout-5xx ",
    }),
  );
  // One of exactly three things the design says earns an @, and there is no
  // other way to deliver it: the task definition does not set this.
  assert.deepEqual(cfg.prodCriticalSlugs, ["pro-upgrade-errors", "checkout-5xx"]);
});

// --- the process does not die quietly --------------------------------------

test("an unhandled rejection exits non-zero rather than dying quietly", () => {
  // Called rather than emitted: the test runner installs its own handler for
  // both of these, and a real emit would reach that one too.
  const beforeRejection = process.listeners("unhandledRejection");
  const beforeException = process.listeners("uncaughtException");
  const exits: number[] = [];
  installCrashHandlers((code) => exits.push(code));

  const onRejection = process
    .listeners("unhandledRejection")
    .filter((listener) => !beforeRejection.includes(listener));
  const onException = process
    .listeners("uncaughtException")
    .filter((listener) => !beforeException.includes(listener));
  for (const listener of onRejection) {
    process.off("unhandledRejection", listener);
  }
  for (const listener of onException) {
    process.off("uncaughtException", listener);
  }

  assert.equal(onRejection.length, 1, "nothing was listening for a rejection");
  assert.equal(onException.length, 1, "nothing was listening for an exception");
  onRejection[0](new Error("boom"), Promise.resolve());
  onException[0](new Error("worse"), "uncaughtException");

  // A task that keeps passing its health check while half dead outlives the
  // incident it was supposed to be working.
  assert.deepEqual(exits, [1, 1]);
});

// --- suppression ------------------------------------------------------------

test("a suppressed signal is finished, and the sweep does not re-triage it", async () => {
  // The model cannot suppress on its own say-so: the alert has to declare the
  // cause and declare it suppressible. That rule is the reason this needs a
  // real body rather than a queued decision.
  const knownCauses = JSON.stringify([
    {
      id: "known-flaky-canary",
      summary: "the canary restarts nightly and trips this for a minute",
      confirmedBy: "the restart shows in the deploy log",
      action: "suppress",
    },
  ]);

  fakeModel.triageDecisions.push({
    action: "suppress",
    knownCauseId: "known-flaky-canary",
    reason: "the canary restarts nightly; this is that",
  });
  await boss.ingest("grafana", {
    headers: { "x-grafana-alerting-signature": "valid-in-test" },
    rawBody: JSON.stringify({
      status: "firing",
      alerts: [
        {
          status: "firing",
          fingerprint: "fp-supp",
          labels: { alert_slug: "canary-restart", environment: "prod" },
          annotations: {
            summary: "[PROD] canary-restart",
            known_causes: knownCauses,
          },
          startsAt: new Date().toISOString(),
        },
      ],
    }),
  });

  const signal = boss.db.get<{
    id: string;
    incidentId: string | null;
    closedAt: number | null;
  }>("SELECT id, incidentId, closedAt FROM signal WHERE sourceId = 'fp-supp'");
  assert.ok(signal, "a suppressed signal is still recorded, or we cannot count suppressions");
  assert.equal(signal!.incidentId, null, "suppression means no incident");
  assert.ok(
    signal!.closedAt,
    "a suppressed signal is finished; without this the orphan sweep re-triages it forever",
  );

  // The sweep exists to recover signals that reached no incident. A
  // suppression reached a decision, so it is not one of those.
  const before = boss.db.query("SELECT id FROM incident").length;
  await boss.sweepOrphans();
  assert.equal(
    boss.db.query("SELECT id FROM incident").length,
    before,
    "sweeping a suppression must not open an incident for it",
  );
});

// --- the rotation snapshot --------------------------------------------------

test("an incident records who was on call when it opened, not who is now", async () => {
  rotation.members = ["U-ada", "U-grace"];
  fakeModel.triageDecisions.push({ action: "new_incident", reason: "real" });
  await boss.ingest("grafana", grafanaBody("fp-rot", "payments-errors"));

  const id = boss.db.get<{ incidentId: string }>(
    "SELECT incidentId FROM signal WHERE sourceId = 'fp-rot'",
  )!.incidentId;
  assert.deepEqual(
    JSON.parse(
      boss.db.get<{ rotationAtOpen: string }>(
        "SELECT rotationAtOpen FROM incident WHERE id = ?",
        [id],
      )!.rotationAtOpen,
    ),
    ["U-ada", "U-grace"],
  );

  // The group changes. The answer to "who was responsible at 2am" must not.
  rotation.members = ["U-alan"];
  fakeModel.triageDecisions.push({ action: "new_incident", reason: "later" });
  await boss.ingest("grafana", grafanaBody("fp-rot-2", "payments-errors"));

  assert.deepEqual(
    JSON.parse(
      boss.db.get<{ rotationAtOpen: string }>(
        "SELECT rotationAtOpen FROM incident WHERE id = ?",
        [id],
      )!.rotationAtOpen,
    ),
    ["U-ada", "U-grace"],
    "the snapshot is the point; re-reading the group later loses the answer",
  );
});

test("no rotation configured records nothing rather than guessing", async () => {
  rotation.members = null;
  fakeModel.triageDecisions.push({ action: "new_incident", reason: "real" });
  await boss.ingest("grafana", grafanaBody("fp-rot-3", "billing-errors"));

  const row = boss.db.get<{ rotationAtOpen: string | null }>(
    `SELECT i.rotationAtOpen FROM incident i
       JOIN signal s ON s.incidentId = i.id WHERE s.sourceId = 'fp-rot-3'`,
  );
  assert.equal(row!.rotationAtOpen, null);
  rotation.members = ["U-ada", "U-grace"];
});

// --- ownership --------------------------------------------------------------

/** A reply in an incident's thread, as Slack delivers it. */
const replyIn = (threadTs: string, text: string, user = "U-swain") => ({
  type: "message",
  channel: "C0TEST",
  user,
  text,
  ts: `${Date.now() / 1000}`,
  thread_ts: threadTs,
});

test("a person can take an incident over, and hand it back", async () => {
  fakeModel.triageDecisions.push({ action: "new_incident", reason: "real" });
  await boss.ingest("grafana", grafanaBody("fp-own", "checkout-errors"));

  const row = boss.db.get<{ id: string; slackThreadTs: string | null }>(
    `SELECT i.id, i.slackThreadTs FROM incident i
       JOIN signal s ON s.incidentId = i.id WHERE s.sourceId = 'fp-own'`,
  )!;
  assert.ok(row.slackThreadTs, "a claim can only be made in a thread");

  await boss.slackEvent(replyIn(row.slackThreadTs!, "mine"));

  assert.equal(
    boss.db.get<{ owner: string }>("SELECT owner FROM incident WHERE id = ?", [
      row.id,
    ])?.owner,
    "human",
  );
  assert.equal(
    boss.db.get<{ status: string }>("SELECT status FROM incident WHERE id = ?", [
      row.id,
    ])?.status,
    "INVESTIGATING",
    "status says where the work is; taking it over does not move the work",
  );

  // The agent is told to wind down rather than killed, because its write-up
  // is the thing the person taking over actually wants.
  const directives = boss.db.query<{ payload: string }>(
    "SELECT payload FROM pending_directive WHERE incidentId = ?",
    [row.id],
  );
  assert.ok(
    directives.some((d) => JSON.parse(d.payload).type === "handoff"),
    "a takeover asks the agent to finish and stop",
  );

  // Who did it, which owner alone cannot say.
  assert.equal(
    boss.db.get<{ actorId: string }>(
      "SELECT actorId FROM incident_action WHERE incidentId = ? AND action = 'take_over'",
      [row.id],
    )?.actorId,
    "U-swain",
  );

  // And back. Without this, owner only ever moves one way and no agent can
  // reach the incident again -- escalation becomes a hole rather than a
  // handoff.
  await boss.slackEvent(replyIn(row.slackThreadTs!, "back to you"));
  assert.equal(
    boss.db.get<{ owner: string }>("SELECT owner FROM incident WHERE id = ?", [
      row.id,
    ])?.owner,
    "agent",
  );
});

test("a claim on an incident a person already owns changes nothing", async () => {
  fakeModel.triageDecisions.push({ action: "new_incident", reason: "real" });
  await boss.ingest("grafana", grafanaBody("fp-own-2", "search-errors"));
  const row = boss.db.get<{ id: string; slackThreadTs: string | null }>(
    `SELECT i.id, i.slackThreadTs FROM incident i
       JOIN signal s ON s.incidentId = i.id WHERE s.sourceId = 'fp-own-2'`,
  )!;

  await boss.slackEvent(replyIn(row.slackThreadTs!, "mine", "U-ada"));
  await boss.slackEvent(replyIn(row.slackThreadTs!, "mine", "U-grace"));

  assert.equal(
    boss.db.query(
      "SELECT id FROM incident_action WHERE incidentId = ? AND action = 'take_over'",
      [row.id],
    ).length,
    1,
    "the second claim is refused, so the trail does not claim two owners",
  );
});
