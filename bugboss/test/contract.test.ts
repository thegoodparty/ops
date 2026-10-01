// The Boss's behaviour guarantees, each one a test named as the guarantee.
//
// Two regressions on 2026-10-01 reached prod because nothing asserted these:
// a tag in incident 100's thread met with silence, and notices that posted on
// every tick while the database refused writes. So these drive the real
// thing -- the composition root, the Boss's own turn loop, the relay, the
// dispatcher, the board sweep and a real Db over an S3 that can refuse -- and
// fake only the model, Slack and the spawned agent.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { createBossClient, createDirectiveWatcher } from "../agent/run";
import { sweepBoard } from "../board";
import { Db } from "../db";
import { createDispatcher } from "../dispatcher";
import { createBugBoss, type BugBoss } from "../index";
import { emptyModelUsage, type ModelReply, type ModelRequest, type SizedModelClient } from "../model";
import { SlackRelay } from "../slack/relay";
import type { BugBossConfig, DispatcherConfig, ToolApi } from "../types";

const BOT = "B0BOSS";
const CHANNEL = "C0TEST";
const ANSWER = "Incident is being investigated; its agent is reading the logs now.";

const quietly = async <T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> => {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (line: unknown) => lines.push(String(line));
  console.error = (line: unknown) => lines.push(String(line));
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = log;
    console.error = error;
  }
};

const events = (lines: string[]): string[] =>
  lines.flatMap((line) => {
    try {
      return [String((JSON.parse(line) as { event?: unknown }).event)];
    } catch {
      return [];
    }
  });

// ---------------------------------------------------------------------------
// The whole Boss, with a stand-in model
// ---------------------------------------------------------------------------

/**
 * Stands in for every model call the Boss makes. Triage always opens,
 * correlation never merges, and the Boss's own run does what incident 100's
 * did in prod: it reaches for silence first. Refused, it answers. A test can
 * script the Boss run instead.
 */
const standIn = {
  contextWindow: 1_000_000,
  calls: 0,
  bossRequests: [] as ModelRequest[],
  script: null as ((request: ModelRequest) => ModelReply | null) | null,
  complete(request: ModelRequest): Promise<ModelReply> {
    standIn.calls++;
    const offered = new Set(request.tools.map((t) => t.name));
    const call = (name: string, input: Record<string, unknown>): Promise<ModelReply> =>
      Promise.resolve({
        text: "",
        toolCalls: [{ id: `call-${standIn.calls}`, name, input }],
        usage: emptyModelUsage(),
      });
    if (offered.has("propose")) return call("propose", { merges: [] });
    if (offered.has("decide")) return call("decide", { action: "new_incident", reason: "nothing open like it" });
    if (!offered.has("stay_silent")) {
      return Promise.resolve({ text: "Its agent is reading the logs.", toolCalls: [], usage: emptyModelUsage() });
    }
    standIn.bossRequests.push(request);
    const scripted = standIn.script?.(request);
    if (scripted) return Promise.resolve(scripted);
    const refused = request.messages.some(
      (m) => m.role === "toolResult" && m.text.startsWith("Refused: this message tags you"),
    );
    if (refused) return Promise.resolve({ text: ANSWER, toolCalls: [], usage: emptyModelUsage() });
    return call("stay_silent", { reason: "The message tags another user, not me, and is meant for them." });
  },
} satisfies SizedModelClient & Record<string, unknown>;

const slack = {
  posts: [] as { threadTs: string | null; text: string }[],
  post(threadTs: string | null, text: string) {
    slack.posts.push({ threadTs, text });
    return Promise.resolve({ ts: `5000.${String(slack.posts.length).padStart(6, "0")}` });
  },
  react: () => Promise.resolve(),
  update: () => Promise.resolve(),
  replies: () => Promise.resolve([]),
  permalink: (ts: string) => Promise.resolve(`https://goodparty.slack.com/archives/${CHANNEL}/p${ts.replaceAll(".", "")}`),
};

const grafana = (fingerprint: string, status: "firing" | "resolved" = "firing") => ({
  headers: { "x-grafana-alerting-signature": "valid-in-test" },
  rawBody: JSON.stringify({
    status,
    alerts: [
      {
        status,
        fingerprint,
        labels: { alert_slug: `${fingerprint}-errors`, environment: "prod" },
        annotations: { summary: `[PROD] ${fingerprint} errors` },
        startsAt: new Date().toISOString(),
      },
    ],
  }),
});

let dir: string;
let boss: BugBoss;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-contract-"));
  const config: BugBossConfig = {
    env: "prod",
    s3Bucket: "bugboss-test",
    dbPath: join(dir, "boss.db"),
    slackChannelId: CHANNEL,
    testDatabase: { state: "absent" },
    dispatcher: {
      maxConcurrentAgents: 15,
      tickSeconds: 30,
      agentTimeoutSeconds: 1800,
      agentMaxTurns: 200,
      maxAttempts: 3,
      staleAfterSeconds: 86_400,
    },
    prodCriticalSlugs: [],
  };
  ({ value: boss } = await quietly(() =>
    createBugBoss({
      gh: null,
      config,
      model: standIn,
      slack,
      spawnAgent: () => Promise.resolve(),
      s3: undefined,
      secrets: { slackBotUserId: BOT },
      fileUploader: { upload: () => Promise.resolve() },
      insecureTestVerifiers: { grafana: () => {}, slack: () => {} },
    }),
  ));
});

after(() => {
  boss?.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** An incident opened the way prod opens one, with its thread. */
const openIncident = async (fingerprint: string): Promise<{ id: string; thread: string }> => {
  await quietly(async () => {
    await boss.ingest("grafana", grafana(fingerprint));
    await boss.ensureIncidentThreads();
  });
  const row = boss.db.get<{ id: string; slackThreadTs: string }>(
    "SELECT i.id, i.slackThreadTs FROM incident i JOIN signal s ON s.incidentId = i.id WHERE s.sourceId = ?",
    [fingerprint],
  );
  assert.ok(row?.slackThreadTs, "premise: the incident opened with a thread");
  return { id: row.id, thread: row.slackThreadTs };
};

describe("the Boss answers whoever tags it", () => {
  test("a message that tags the Boss in an incident thread is answered, and silence is refused", async () => {
    const { thread } = await openIncident("fp-tag-incident");
    const before = slack.posts.length;
    const asked = standIn.bossRequests.length;

    const { lines } = await quietly(() =>
      boss.slackEvent({
        type: "app_mention",
        channel: CHANNEL,
        user: "U-swain",
        text: `<@${BOT}> what's the status here?`,
        ts: "5100.000001",
        thread_ts: thread,
      }),
    );

    const runs = standIn.bossRequests.slice(asked);
    assert.ok(
      runs.some((r) => r.messages.some((m) => m.role === "toolResult" && m.text.startsWith("Refused: this message tags you"))),
      "premise: the Boss reached for silence and was refused",
    );
    assert.ok(!events(lines).includes("stay_silent"), "no silence was recorded");
    const answers = slack.posts.slice(before).filter((p) => p.threadTs === thread && p.text.includes(ANSWER));
    assert.equal(answers.length, 1, JSON.stringify(slack.posts.slice(before)));
  });

  test("a message that tags the Boss outside any incident thread is answered, and silence is refused", async () => {
    const before = slack.posts.length;
    const asked = standIn.bossRequests.length;

    const { lines } = await quietly(() =>
      boss.slackEvent({
        type: "app_mention",
        channel: CHANNEL,
        user: "U-swain",
        text: `<@${BOT}> what is open right now?`,
        ts: "5200.000001",
      }),
    );

    const runs = standIn.bossRequests.slice(asked);
    assert.ok(
      runs.some((r) => r.messages.some((m) => m.role === "toolResult" && m.text.startsWith("Refused: this message tags you"))),
      "premise: the Boss reached for silence and was refused",
    );
    assert.ok(!events(lines).includes("stay_silent"), "no silence was recorded");
    const answers = slack.posts.slice(before).filter((p) => p.threadTs === "5200.000001" && p.text.includes(ANSWER));
    assert.equal(answers.length, 1, JSON.stringify(slack.posts.slice(before)));
  });
});

describe("the Boss reaches its agents", () => {
  test("a Boss message reaches a waiting agent as a steer, and ends its wait", async () => {
    const { id, thread } = await openIncident("fp-directive");
    await boss.db.withWrite((d) => {
      d.prepare(
        `INSERT INTO incident_wait (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt)
         VALUES (?, 'a person to say whether the deploy is done', NULL, 1, ?)`,
      ).run(id, Date.now());
    });
    const said = "The deploy finished at 10:40; carry on with the verification.";
    standIn.script = (request) => {
      const sent = request.messages.some(
        (m) => m.role === "assistant" && m.toolCalls.some((c) => c.name === "message_agent"),
      );
      return sent
        ? { text: "Passed that to its agent.", toolCalls: [], usage: emptyModelUsage() }
        : {
            text: "",
            toolCalls: [{ id: "call-message", name: "message_agent", input: { incidentId: id, text: said } }],
            usage: emptyModelUsage(),
          };
    };
    try {
      await quietly(() =>
        boss.slackEvent({
          type: "message",
          channel: CHANNEL,
          user: "U-swain",
          text: "the deploy is done",
          ts: "5300.000001",
          thread_ts: thread,
        }),
      );
    } finally {
      standIn.script = null;
    }

    assert.equal(
      boss.db.get("SELECT 1 FROM incident_wait WHERE incidentId = ?", [id]),
      undefined,
      "the wait is over",
    );

    // The agent side, over the real loopback routes: the watcher the child
    // runs between tool calls.
    const api = createBossClient({
      baseUrl: "http://boss.local",
      incidentId: id,
      authToken: boss.mintToken(id),
      fetchImpl: ((input: string, init?: RequestInit) =>
        boss.loopbackApp.fetch(new Request(input, init))) as typeof fetch,
    });
    const steered: string[] = [];
    let interrupted = 0;
    const failures: unknown[] = [];
    const watch = createDirectiveWatcher({
      api,
      steer: (text) => {
        steered.push(text);
        return Promise.resolve();
      },
      interruptWait: () => {
        interrupted++;
      },
      onFailure: (error) => failures.push(error),
    });
    await quietly(async () => {
      await watch();
      await watch();
    });

    assert.deepEqual(failures, []);
    assert.deepEqual(steered, [`The Boss says: ${said}`], "delivered once, in the Boss's words");
    assert.ok(interrupted >= 1, "and it interrupts a wait in progress");
    assert.equal(
      boss.db.get("SELECT 1 FROM pending_directive WHERE incidentId = ?", [id]),
      undefined,
      "consumed once steered",
    );
  });
});

describe("a resolved notification", () => {
  test("a resolved notification never opens an incident", async () => {
    const incidents = boss.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM incident")!.n;
    const posts = slack.posts.length;
    const calls = standIn.calls;

    await quietly(async () => {
      await boss.ingest("grafana", grafana("fp-only-resolved", "resolved"));
      await boss.sweepOrphans();
      await boss.ensureIncidentThreads();
    });

    assert.equal(boss.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM incident")!.n, incidents);
    assert.equal(
      boss.db.get("SELECT 1 FROM signal WHERE sourceId = 'fp-only-resolved'"),
      undefined,
      "nothing is recorded that a sweep could later place",
    );
    assert.equal(standIn.calls, calls, "triage was never asked");
    assert.equal(slack.posts.length, posts);
  });
});

test("a PR merge on a watched incident is announced once", { skip: "waits on #209: the PR watcher is not on main yet" }, () => {});

// ---------------------------------------------------------------------------
// Notices code composes, across ticks, over a real Db whose S3 can refuse
// ---------------------------------------------------------------------------

/** An S3 that keeps what it is given, and refuses every PUT while `failing`. */
const flakyS3 = () => {
  const state = { failing: false, objects: new Map<string, Uint8Array>() };
  const client = {
    send: async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) {
        const err = new Error("cold start");
        err.name = "NoSuchKey";
        throw err;
      }
      if (cmd instanceof PutObjectCommand) {
        if (state.failing) throw Object.assign(new Error("RequestTimeTooSkewed"), { name: "RequestTimeTooSkewed" });
        return {};
      }
      return {};
    },
  } as unknown as S3Client;
  return { state, client };
};

const openFlakyDb = async (name: string) => {
  const s3 = flakyS3();
  const path = join(mkdtempSync(join(tmpdir(), `bugboss-contract-${name}-`)), "boss.db");
  const { value: db } = await quietly(() =>
    Db.open({
      path,
      bucket: "bugboss-test",
      key: "state/db",
      s3: s3.client,
      snapshotTiming: { retryDelaysMs: [], haltRetryMs: 1, haltRetryMaxMs: 1, putTimeoutMs: 1_000 },
    }),
  );
  return { db, s3 };
};

/** Longer than the halt's retry backoff, so every tick is a real retry. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 3));

const seedIncident = (db: Db, id: string) =>
  db.withWrite((d) => {
    d.prepare(
      `INSERT INTO incident (id, status, firstSignalAt, summary, prUrls, sessionRef)
       VALUES (?, 'INVESTIGATING', 1, ?, '[]', 's-1')`,
    ).run(id, `what ${id} is`);
  });

describe("no code-composed notice posts twice across ticks, including while writes fail", () => {
  test("an incident's opener posts once, however many ticks retry it while writes fail", async () => {
    const { db, s3 } = await openFlakyDb("opener");
    await seedIncident(db, "1");
    const posts: { threadTs: string | null; text: string }[] = [];
    const relay = new SlackRelay({
      db,
      slack: {
        post: (threadTs, text) => {
          posts.push({ threadTs, text });
          return Promise.resolve({ ts: `6000.${String(posts.length).padStart(6, "0")}` });
        },
      },
      config: { channelId: CHANNEL, botUserId: BOT, rotationGroupId: null },
      isBossThread: () => false,
    });
    // What the thread sweep does on every pass: any open incident without a
    // thread gets an opener.
    const sweep = async () => {
      const threadless = db.query<{ id: string }>("SELECT id FROM incident WHERE slackThreadTs IS NULL");
      for (const row of threadless) {
        await relay.emit({ type: "opened", incidentId: row.id, title: "Checkout errors", origin: null }).catch(() => undefined);
      }
    };

    const { lines } = await quietly(async () => {
      s3.state.failing = true;
      for (let tick = 0; tick < 10; tick++) {
        await sweep();
        await pause();
      }
      assert.equal(posts.length, 0, "an opener whose link cannot be written is not posted");
      s3.state.failing = false;
      for (let tick = 0; tick < 10; tick++) {
        await sweep();
        await pause();
      }
    });

    assert.equal(posts.filter((p) => p.threadTs === null).length, 1, lines.join("\n"));
    db.close();
  });

  test("the morning board posts once, however many ticks pass while writes fail", async () => {
    const { db, s3 } = await openFlakyDb("board");
    await seedIncident(db, "1");
    const posts: string[] = [];
    const eastern = (hour: number): number =>
      Date.parse(`2026-03-02T${String(hour + 5).padStart(2, "0")}:00:00Z`);
    const sweep = (at: number) =>
      sweepBoard({
        db,
        post: (text) => {
          posts.push(text);
          return Promise.resolve({ ts: `7000.${posts.length}` });
        },
        update: () => Promise.resolve(),
        origin: () => Promise.resolve(null),
        channel: CHANNEL,
        now: () => at,
      }).catch(() => undefined);

    await quietly(async () => {
      await sweep(eastern(6));
      s3.state.failing = true;
      for (let tick = 0; tick < 20; tick++) {
        await sweep(eastern(7) + tick * 30_000);
        await pause();
      }
      s3.state.failing = false;
      for (let tick = 20; tick < 40; tick++) {
        await sweep(eastern(7) + tick * 30_000);
        await pause();
      }
    });

    assert.equal(posts.length, 1, posts.join("\n---\n"));
    db.close();
  });

  test("a crash-loop escalation posts once, however many ticks pass while writes fail", async () => {
    const { db, s3 } = await openFlakyDb("escalation");
    await seedIncident(db, "93");
    const escalations: string[] = [];
    const ok = () => Promise.resolve({ ok: true, directives: [] });
    const toolApiFor = (incidentId: string): ToolApi => ({
      reportRootCause: ok,
      proposeMerge: ok,
      setSummary: ok,
      reportImpact: ok,
      reportResolved: ok,
      reportAnalysis: ok,
      getIncident: ok,
      searchIncidents: ok,
      trackTimelineEvent: ok,
      escalate: ({ reason }) => {
        escalations.push(`${incidentId}: ${reason}`);
        return Promise.resolve({ ok: true, directives: [] });
      },
      park: ok,
    });
    const config: DispatcherConfig = {
      maxConcurrentAgents: 15,
      tickSeconds: 30,
      agentTimeoutSeconds: 1800,
      agentMaxTurns: 200,
      maxAttempts: 3,
      staleAfterSeconds: 86_400,
    };
    const dispatcher = createDispatcher({
      db,
      config,
      toolApiFor,
      spawn: () => Promise.reject(new Error("agent exited 1")),
      mintToken: (id) => `tok-${id}`,
      childBaseEnv: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds" },
      now: () => 1_700_000_000_000,
    });
    const tick = () =>
      dispatcher
        .tick()
        .then((r) => r.settled)
        .catch(() => undefined);

    await quietly(async () => {
      s3.state.failing = true;
      for (let i = 0; i < 40; i++) {
        await tick();
        await pause();
      }
      assert.deepEqual(escalations, [], "nothing posts while the park cannot be written");
      s3.state.failing = false;
      for (let i = 0; i < 40; i++) {
        await tick();
        await pause();
      }
    });

    assert.equal(escalations.length, 1, escalations.join("\n"));
    db.close();
  });
});
