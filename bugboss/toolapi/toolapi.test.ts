import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type Database from "better-sqlite3";
import type { S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import type {
  Evidence,
  IncidentView,
  MergeOutcomeView,
  ToolApi,
} from "../types";
import { applyAssign } from "./assign";
import {
  createToolApi,
  type CorrelationMerge,
  type MergeVerdict,
} from "./index";
import jwt from "jsonwebtoken";

import { mintAgentToken, verifyAgentToken } from "./token";
import { THREAD_PROSE_CHARS } from "../slack/format";

const SECRET = "test-secret-not-a-real-one";

const fakeS3 = () => {
  const objects = new Map<string, Buffer>();
  return {
    send: async (cmd: {
      constructor: { name: string };
      input: { Key: string; Body?: Buffer };
    }) => {
      if (cmd.constructor.name === "GetObjectCommand") {
        const body = objects.get(cmd.input.Key);
        if (!body) {
          const err = new Error("NoSuchKey");
          err.name = "NoSuchKey";
          throw err;
        }
        return { Body: { transformToByteArray: async () => body } };
      }
      objects.set(cmd.input.Key, Buffer.from(cmd.input.Body!));
      return {};
    },
  };
};

let dir: string;
let db: Db;
let seq = 0;
let posts: { threadTs: string | null; text: string }[];
let merges: CorrelationMerge[];
let evidenceRows: Evidence[];

/**
 * The Slack surface a merge or a split needs beyond posting. `openThreads`
 * stands in for the relay's sweep: every open incident without a thread gets
 * one, which is what makes a freshly split incident linkable.
 */
const linking = {
  permalink: async (messageTs: string) =>
    `https://goodparty.slack.com/archives/C09/p${messageTs.replaceAll(".", "")}`,
  openThreads: async () => {
    await db.withWrite((w) => {
      w.prepare(
        `UPDATE incident SET slackThreadTs = 'thread-' || id
          WHERE slackThreadTs IS NULL
            AND status IN ('INVESTIGATING', 'FIXING', 'RESOLVED')`,
      ).run();
    });
  },
};

const slack = {
  ...linking,
  post: async (threadTs: string | null, text: string) => {
    posts.push({ threadTs, text });
    return { ts: `ts-${posts.length}` };
  },
};

/** Queued verdicts for `proposeMerge`. Empty means "not the same problem". */
const verdicts: MergeVerdict[] = [];

const correlator = {
  correlate: async () => merges.splice(0, merges.length),
  judgeMerge: async () =>
    verdicts.shift() ?? { merge: null, compared: true },
};

const evidence = { load: async () => evidenceRows };

const toolsFor = (incidentId: string): ToolApi =>
  createToolApi({
    db,
    token: mintAgentToken(SECRET, { incidentId, attempt: 1 }, 3600),
    tokenSecret: SECRET,
    correlator,
    slack,
    evidence,
  });

const seed = async (id: string, opts: { closedAt?: number } = {}) => {
  await db.withWrite((w) => {
    w.prepare(
      `INSERT INTO signal (id, source, sourceId, kind, title, body, labels, reportedBy, openedAt, closedAt, incidentId, explained)
       VALUES (?, 'grafana', ?, 'alert', ?, '', '{}', NULL, ?, ?, NULL, 0)`,
    ).run(id, id, `signal ${id}`, 1000 + seq++, opts.closedAt ?? null);
  });
};

/** What ingest does when an alert stops firing. Never a status transition. */
const goesQuiet = async (id: string) => {
  await db.withWrite((w) => {
    w.prepare("UPDATE signal SET closedAt = ? WHERE id = ?").run(Date.now(), id);
  });
};

/** Everything written to one console stream while fn ran. */
const consoleDuring = async (
  stream: "log" | "error",
  fn: () => Promise<void>,
): Promise<string[]> => {
  const lines: string[] = [];
  const real = console[stream];
  console[stream] = (line: string) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console[stream] = real;
  }
  return lines;
};

const alarmsDuring = (fn: () => Promise<void>) => consoleDuring("error", fn);
const logsDuring = (fn: () => Promise<void>) => consoleDuring("log", fn);

/** Reads keep working; the nth write onwards is refused, as a halted Db does. */
const writesDieAfter = (n: number): Db =>
  ({
    query: (sql: string, params?: unknown[]) => db.query(sql, params),
    get: (sql: string, params?: unknown[]) => db.get(sql, params),
    withWrite: (() => {
      let writes = 0;
      return (fn: (w: Database.Database) => unknown) =>
        ++writes > n
          ? Promise.reject(new Error("writes halted: snapshot PUT failed"))
          : db.withWrite(fn);
    })(),
  }) as unknown as Db;

/**
 * A merge landing on an incident, which is how its status moves out from
 * under a call already in flight. Returned unawaited by the races below: both
 * writes queue in the same tick, which is what a few hundred milliseconds of
 * snapshot latency looks like from inside a handler.
 */
const mergedAway = (signalId: string, into: string) =>
  applyAssign(
    db,
    { signalIds: [signalId], target: into, reason: "one pool, two alerts" },
    { kind: "boss" },
  );

const openIncident = async (signalIds: string[]) =>
  (
    await applyAssign(
      db,
      { signalIds, target: "NEW", reason: "triage opened it" },
      { kind: "boss" },
    )
  ).target;

const incidentRow = (id: string) =>
  db.get<{
    status: string;
    summary: string | null;
    rootCause: string | null;
    prUrls: string;
    postmortem: string | null;
    usersImpacted: number | null;
    impactQuery: string | null;
    impactStartedAt: number | null;
    fixingAt: number | null;
    resolvedAt: number | null;
    closedAt: number | null;
    recurrenceOf: string | null;
    mergedInto: string | null;
    resolvedEvidence: string | null;
  }>("SELECT * FROM incident WHERE id = ?", [id]);

/** What the relay does when it opens an incident's thread. */
const withThread = (id: string) =>
  db.withWrite((w) => {
    w.prepare("UPDATE incident SET slackThreadTs = ? WHERE id = ?").run(
      `thread-${id}`,
      id,
    );
  });

const postsIn = (incidentId: string): string[] =>
  posts.filter((p) => p.threadTs === `thread-${incidentId}`).map((p) => p.text);

const signalsOn = (incidentId: string): string[] =>
  db
    .query<{ id: string }>(
      "SELECT id FROM signal WHERE incidentId = ? ORDER BY id",
      [incidentId],
    )
    .map((r) => r.id);

before(() => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-toolapi-"));
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  db?.close();
  seq = 0;
  posts = [];
  merges = [];
  evidenceRows = [];
  db = await Db.open({
    path: join(dir, `t-${Math.random().toString(36).slice(2)}.db`),
    bucket: "bugboss-test",
    key: "state/db",
    s3: fakeS3() as unknown as S3Client,
  });
});

describe("the status progression", () => {
  it("carries an incident from INVESTIGATING to CLOSED", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);

    const rootCause = await tools.reportRootCause({
      cause: "Pro upgrade webhook wrote to the wrong column",
      explainedSignalIds: ["sig-a"],
      usersImpacted: 3,
      impactQuery: '{service_name="gp-api"} |= "pro_upgrade"',
    });
    assert.equal(rootCause.ok, true, rootCause.error);
    assert.equal(incidentRow(id)?.status, "FIXING");
    assert.ok(incidentRow(id)?.fixingAt);
    assert.equal(incidentRow(id)?.usersImpacted, 3);
    assert.equal(
      db.get<{ explained: number }>("SELECT explained FROM signal WHERE id = 'sig-a'")
        ?.explained,
      1,
    );

    const impact = await tools.reportImpact({
      usersImpacted: 11,
      query: '{service_name="gp-api"} |= "pro_upgrade" | count',
    });
    assert.equal(impact.ok, true, impact.error);
    assert.equal(incidentRow(id)?.usersImpacted, 11);

    await goesQuiet("sig-a");
    const resolved = await tools.reportResolved({
      prUrls: ["https://github.com/thegoodparty/omni/pull/9999"],
      evidence: "two clean runs through the flow after deploy",
    });
    assert.equal(resolved.ok, true, resolved.error);
    assert.equal(incidentRow(id)?.status, "RESOLVED");
    assert.ok(incidentRow(id)?.resolvedAt);
    assert.deepEqual(JSON.parse(incidentRow(id)!.prUrls), [
      "https://github.com/thegoodparty/omni/pull/9999",
    ]);

    const closed = await tools.reportAnalysis({
      postmortem: "# Summary\nBad column in the upgrade webhook.",
      usersImpacted: 11,
      impactQuery: '{service_name="gp-api"} |= "pro_upgrade"',
    });
    assert.equal(closed.ok, true, closed.error);
    assert.equal(incidentRow(id)?.status, "CLOSED");
    assert.ok(incidentRow(id)?.closedAt);
    assert.match(incidentRow(id)?.postmortem ?? "", /Bad column/);
  });

  it("rejects every transition taken out of order", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);

    const early = await tools.reportResolved({ prUrls: [], evidence: "nope" });
    assert.equal(early.ok, false);
    assert.match(early.error ?? "", /requires FIXING; incident .* is INVESTIGATING/);

    await tools.reportRootCause({ cause: "c", explainedSignalIds: ["sig-a"] });

    const analysisTooEarly = await tools.reportAnalysis({
      postmortem: "p",
      usersImpacted: 1,
      impactQuery: "q",
    });
    assert.equal(analysisTooEarly.ok, false);
    assert.match(analysisTooEarly.error ?? "", /requires RESOLVED/);

    const twice = await tools.reportRootCause({
      cause: "c2",
      explainedSignalIds: ["sig-a"],
    });
    assert.equal(twice.ok, false, "a second root cause is not a backward edge");
    assert.match(twice.error ?? "", /requires INVESTIGATING; incident .* is FIXING/);
    assert.equal(incidentRow(id)?.rootCause, "c");
  });

  it("nothing an agent reports moves a closed incident", async () => {
    await seed("sig-a", { closedAt: 2000 });
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({ cause: "c", explainedSignalIds: ["sig-a"] });
    await tools.reportResolved({ prUrls: [], evidence: "quiet" });
    await tools.reportAnalysis({ postmortem: "p", usersImpacted: 1, impactQuery: "q" });

    const after = await tools.reportImpact({ usersImpacted: 99, query: "q" });
    assert.equal(after.ok, false);
    assert.equal(incidentRow(id)?.usersImpacted, 1);
  });

  it("keeps the evidence the resolution rests on", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({ cause: "c", explainedSignalIds: ["sig-a"] });

    const res = await tools.reportResolved({
      prUrls: [],
      evidence: "error rate flat at zero for 40 minutes after the deploy",
    });

    assert.equal(res.ok, true, res.error);
    assert.equal(
      incidentRow(id)?.resolvedEvidence,
      "error rate flat at zero for 40 minutes after the deploy",
      "RESOLVED is an evidence-based claim, so the evidence outlives the Slack post",
    );
  });
});

describe("a status check the write does not repeat", () => {
  // Both writes below are queued in the same tick, which is what a few
  // hundred milliseconds of snapshot latency looks like from inside a
  // handler: the status check has already read the old row on the read-only
  // connection, and the other write commits before this one's turn comes up.
  it("refuses a root cause that a merge landed in front of", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);

    const merge = applyAssign(
      db,
      { signalIds: ["sig-b"], target: a, reason: "one pool, two alerts" },
      { kind: "boss" },
    );
    const rootCause = toolsFor(b).reportRootCause({
      cause: "pool exhaustion",
      explainedSignalIds: ["sig-b"],
    });
    await merge;
    const res = await rootCause;

    assert.equal(res.ok, false, "the merge got there first");
    assert.equal(
      incidentRow(b)?.status,
      "MERGED",
      "FIXING here is signal-less and eligible, so the dispatcher relaunches on it forever",
    );
    assert.equal(incidentRow(b)?.mergedInto, a);
    assert.equal(incidentRow(b)?.rootCause, null);
    assert.deepEqual(
      res.directives,
      [{ type: "merged", into: a }],
      "and the agent learns why on its way out",
    );
  });

  it("refuses a resolution a merge landed in front of", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);
    const tools = toolsFor(b);
    await tools.reportRootCause({ cause: "c", explainedSignalIds: ["sig-b"] });

    const merge = mergedAway("sig-b", a);
    const resolved = tools.reportResolved({
      prUrls: ["https://github.com/thegoodparty/omni/pull/1"],
      evidence: "quiet for an hour",
    });
    await merge;
    const res = await resolved;

    assert.equal(res.ok, false);
    assert.equal(incidentRow(b)?.status, "MERGED", "the merged record did not move");
    assert.equal(incidentRow(b)?.resolvedEvidence, null);
    assert.deepEqual(JSON.parse(incidentRow(b)!.prUrls), []);
    assert.equal(
      db.query("SELECT id FROM signal WHERE incidentId = ? AND closedAt IS NULL", [a])
        .length,
      2,
      "and both signals a resolution would have closed are still open on the survivor",
    );
  });

  it("refuses an impact number a merge landed in front of", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);

    const merge = mergedAway("sig-b", a);
    const impact = toolsFor(b).reportImpact({ usersImpacted: 99, query: "q" });
    await merge;
    const res = await impact;

    assert.equal(res.ok, false);
    assert.equal(incidentRow(b)?.usersImpacted, null);
    assert.equal(incidentRow(b)?.impactQuery, null);
  });
});

describe("invariant 1: every attached signal must be explained", () => {
  it("splits out what the root cause does not account for", async () => {
    await seed("sig-a");
    await seed("sig-b");
    await seed("sig-c");
    const id = await openIncident(["sig-a", "sig-b", "sig-c"]);

    const res = await toolsFor(id).reportRootCause({
      cause: "connection pool exhausted",
      explainedSignalIds: ["sig-a"],
    });

    assert.equal(res.ok, true, res.error);
    assert.deepEqual(signalsOn(id), ["sig-a"]);

    const orphans = db.query<{ id: string; incidentId: string }>(
      "SELECT id, incidentId FROM signal WHERE id IN ('sig-b','sig-c')",
    );
    assert.equal(orphans.length, 2);
    for (const o of orphans) {
      assert.notEqual(o.incidentId, id, "an unexplained signal does not stay attached");
      assert.equal(
        incidentRow(o.incidentId)?.status,
        "INVESTIGATING",
        "and it gets an incident of its own, which the dispatcher will staff",
      );
    }
    assert.equal(
      new Set(orphans.map((o) => o.incidentId)).size,
      2,
      "one incident each, the conservative direction",
    );
  });

  it("refuses a root cause that explains nothing attached", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);

    const res = await toolsFor(id).reportRootCause({
      cause: "something else entirely",
      explainedSignalIds: [],
    });

    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /at least one attached signal/);
    assert.equal(incidentRow(id)?.status, "INVESTIGATING");
  });

  it("splits what a merge left unexplained before the incident claims to be over", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);
    const tools = toolsFor(a);
    merges.push({ absorb: b, into: a, reason: "one pool, two alerts" });

    await tools.reportRootCause({
      cause: "pool exhaustion",
      explainedSignalIds: ["sig-a"],
    });
    assert.deepEqual(signalsOn(a), ["sig-a", "sig-b"], "the merge moved b's signal in");
    assert.equal(
      db.get<{ explained: number }>("SELECT explained FROM signal WHERE id = 'sig-b'")
        ?.explained,
      0,
      "and explained does not travel with it",
    );

    const res = await tools.reportResolved({ prUrls: [], evidence: "quiet" });

    assert.equal(res.ok, true, res.error);
    assert.deepEqual(signalsOn(a), ["sig-a"], "the unexplained one does not ride to CLOSED");
    const home = db.get<{ incidentId: string; closedAt: number | null }>(
      "SELECT incidentId, closedAt FROM signal WHERE id = 'sig-b'",
    );
    assert.notEqual(home?.incidentId, a);
    assert.equal(
      incidentRow(home!.incidentId)?.status,
      "INVESTIGATING",
      "it gets an incident the dispatcher will staff",
    );
    assert.equal(home?.closedAt, null, "and it is still firing, so it stays open");
  });
});

describe("resolution evidence answers to the thread budget", () => {
  // The refusal matters more than the cap does. This evidence is posted into
  // the thread, so it is bounded like every other post -- but the check runs
  // ahead of the write, and a threshold that drifted the wrong way would stop
  // an agent resolving anything at all while every test about resolving
  // still passed. So both sides of the boundary are pinned here.
  it("refuses evidence past the budget, leaving the incident resolvable", async () => {
    await seed("sig-long-ev");
    const id = await openIncident(["sig-long-ev"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({
      cause: "bad deploy",
      explainedSignalIds: ["sig-long-ev"],
    });

    const before = posts.length;
    const res = await tools.reportResolved({
      prUrls: [],
      evidence: "x".repeat(THREAD_PROSE_CHARS + 1),
    });

    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /evidence is \d+ characters/);
    assert.match(res.error ?? "", /post-mortem/);
    assert.equal(posts.length, before, "refused ahead of the post");
    // The transition must not have happened, or the agent is stuck holding a
    // FIXING incident it has already been told it cannot resolve.
    const row = incidentRow(id);
    assert.equal(row?.status, "FIXING");
    assert.equal(row?.resolvedAt, null);

    // And the refusal is recoverable: shortening it resolves.
    const retry = await tools.reportResolved({
      prUrls: [],
      evidence: "the alert went quiet and stayed quiet for an hour",
    });
    assert.equal(retry.ok, true, retry.error);
    assert.equal(incidentRow(id)?.status, "RESOLVED");
  });

  it("accepts evidence exactly at the budget", async () => {
    // The off-by-one that would refuse a resolution somebody trimmed to fit.
    await seed("sig-edge-ev");
    const id = await openIncident(["sig-edge-ev"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({
      cause: "bad deploy",
      explainedSignalIds: ["sig-edge-ev"],
    });

    const res = await tools.reportResolved({
      prUrls: [],
      evidence: "x".repeat(THREAD_PROSE_CHARS),
    });

    assert.equal(res.ok, true, res.error);
    assert.equal(incidentRow(id)?.status, "RESOLVED");
  });
});

describe("invariant 2: resolution closes the signals it claims to have fixed", () => {
  // The tool API used to split any signal without a resolve notification out
  // into a recurrence. That asked whether we had heard the alert stop, not
  // whether it was still broken, and the two differ on the ordinary path:
  // the agent watches the alert go quiet and reports before Grafana's
  // resolved delivery lands. Every resolution split its own signal and
  // launched an agent on it.
  //
  // What proves a resolution wrong is a delivery arriving after it, which
  // triage judges and which `signal_open_source_idx` makes reachable. The
  // end-to-end case lives in test/e2e.test.ts.
  it("closes every open signal on the incident", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const id = await openIncident(["sig-a", "sig-b"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({
      cause: "bad deploy",
      explainedSignalIds: ["sig-a", "sig-b"],
    });
    await goesQuiet("sig-a");

    const res = await tools.reportResolved({ prUrls: [], evidence: "a stopped" });

    assert.equal(res.ok, true, res.error);
    assert.equal(incidentRow(id)?.status, "RESOLVED");
    assert.deepEqual(
      signalsOn(id),
      ["sig-a", "sig-b"],
      "both stay attached: this incident is the record of what was worked",
    );
    const open = db.query(
      "SELECT id FROM signal WHERE incidentId = ? AND closedAt IS NULL",
      [id],
    );
    assert.equal(open.length, 0, "a RESOLVED incident holds no open signal");
  });

  it("closes a signal that reopened between RESOLVED and CLOSED", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({ cause: "c", explainedSignalIds: ["sig-a"] });
    await goesQuiet("sig-a");
    await tools.reportResolved({ prUrls: [], evidence: "quiet" });

    await db.withWrite((w) => {
      w.prepare("UPDATE signal SET closedAt = NULL WHERE id = 'sig-a'").run();
    });

    const res = await tools.reportAnalysis({
      postmortem: "p",
      usersImpacted: 1,
      impactQuery: "q",
    });

    assert.equal(res.ok, true, res.error);
    assert.equal(incidentRow(id)?.status, "CLOSED");
    const open = db.query(
      "SELECT id FROM signal WHERE incidentId = ? AND closedAt IS NULL",
      [id],
    );
    assert.equal(open.length, 0, "a CLOSED incident holds no open signal");
  });
});

describe("park", () => {
  const waitRow = (id: string) =>
    db.get<{
      waitingFor: string;
      wakeAt: number | null;
      liftsOnReply: number;
      startedAt: number;
    }>("SELECT * FROM incident_wait WHERE incidentId = ?", [id]);

  it("defaults to a wait a reply ends, which is the wait on a person", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);

    const res = await toolsFor(id).park({ waitingFor: "somebody to merge it" });

    assert.equal(res.ok, true);
    assert.equal(waitRow(id)?.liftsOnReply, 1);
    assert.equal(waitRow(id)?.waitingFor, "somebody to merge it");
  });

  // The row `turnBudgetPark` writes, and the only one in the system that a
  // reply must not end. A reply adds no turns, so waking on one relaunches an
  // agent that is over budget before its first turn: it stops again, escalates
  // again, and every comment on the thread becomes a page. The flag is the
  // whole mechanism, so the 0 actually reaching the column is the thing worth
  // asserting rather than the argument reaching the handler.
  it("writes a wait no reply can end when the caller says so", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);

    const res = await toolsFor(id).park({
      waitingFor: "a person, after the 200-turn budget ran out",
      liftsOnReply: false,
    });

    assert.equal(res.ok, true);
    assert.equal(waitRow(id)?.liftsOnReply, 0);
    assert.deepEqual(
      db.query("SELECT incidentId FROM incident_wait WHERE incidentId = ? AND liftsOnReply = 1", [
        id,
      ]),
      [],
      "the delete in recordReply is keyed on this, so a 1 here would defeat it",
    );
  });

  it("leaves wakeAt null when no wake time is given, and sets one when it is", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const open = await openIncident(["sig-a"]);
    const timed = await openIncident(["sig-b"]);

    // Null is the shape that can wait forever: only a reply or the stale
    // sweep lifts it, which is why both of those exist.
    await toolsFor(open).park({ waitingFor: "a person" });
    assert.equal(waitRow(open)?.wakeAt, null);

    const before = Date.now();
    await toolsFor(timed).park({ waitingFor: "a deploy", wakeAfterSeconds: 600 });
    const wakeAt = waitRow(timed)?.wakeAt;
    assert.ok(wakeAt !== null && wakeAt !== undefined);
    assert.ok(wakeAt >= before + 600_000, `${wakeAt} < ${before + 600_000}`);
  });

  // One row per incident, so a second park is an update rather than a second
  // wait -- and the update has to carry the flag. An agent that parked on a
  // person and then ran out of turns would otherwise keep the old 1 and be
  // woken by the next comment, which is the exact loop this flag prevents.
  it("replaces an existing wait, including flipping it to one a reply cannot end", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);

    await tools.park({ waitingFor: "somebody to merge it", wakeAfterSeconds: 60 });
    assert.equal(waitRow(id)?.liftsOnReply, 1);

    await tools.park({
      waitingFor: "a person, after the 200-turn budget ran out",
      liftsOnReply: false,
    });

    assert.equal(
      db.query("SELECT incidentId FROM incident_wait WHERE incidentId = ?", [id]).length,
      1,
      "one wait per incident",
    );
    assert.equal(waitRow(id)?.liftsOnReply, 0);
    assert.equal(waitRow(id)?.wakeAt, null, "and the new wake time replaces the old one");
  });

  it("refuses to park an incident that is already closed", async () => {
    await seed("sig-a", { closedAt: 2000 });
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({ cause: "c", explainedSignalIds: ["sig-a"] });
    await tools.reportResolved({ prUrls: [], evidence: "quiet" });
    await tools.reportAnalysis({ postmortem: "p", usersImpacted: 1, impactQuery: "q" });

    const res = await tools.park({ waitingFor: "somebody" });

    assert.equal(res.ok, false);
    assert.equal(waitRow(id), undefined, "nothing waits on a closed incident");
  });
});

describe("the scoped token", () => {
  it("refuses a token for another incident reaching this one's signals", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);

    const res = await toolsFor(b).reportRootCause({
      cause: "I am claiming someone else's signal",
      explainedSignalIds: ["sig-a"],
    });

    assert.equal(res.ok, false);
    assert.match(res.error ?? "", new RegExp(`not attached to incident ${b}`));
    assert.equal(incidentRow(a)?.status, "INVESTIGATING", "the other record is untouched");
    assert.equal(incidentRow(a)?.rootCause, null);
    assert.equal(incidentRow(b)?.status, "INVESTIGATING");
  });

  it("confines a compromised agent to one record", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);

    await toolsFor(b).reportRootCause({ cause: "mine", explainedSignalIds: ["sig-b"] });
    await goesQuiet("sig-b");
    await toolsFor(b).reportResolved({ prUrls: [], evidence: "done" });

    assert.equal(incidentRow(b)?.status, "RESOLVED");
    assert.equal(incidentRow(a)?.status, "INVESTIGATING", "nothing leaked across");
    assert.deepEqual(signalsOn(a), ["sig-a"]);
  });

  it("stops working when the token for the run expires", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const expired = createToolApi({
      db,
      token: mintAgentToken(SECRET, { incidentId: id, attempt: 1 }, -1),
      tokenSecret: SECRET,
      correlator,
      slack,
      evidence,
    });

    const res = await expired.reportRootCause({
      cause: "late",
      explainedSignalIds: ["sig-a"],
    });

    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /invalid agent token/);
    assert.equal(incidentRow(id)?.status, "INVESTIGATING");
  });

  it("rejects a forged token and returns no directives with it", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const forged = createToolApi({
      db,
      token: mintAgentToken("a-different-secret", { incidentId: id, attempt: 1 }, 3600),
      tokenSecret: SECRET,
      correlator,
      slack,
      evidence,
    });

    const res = await forged.getIncident();

    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /invalid agent token/);
    assert.deepEqual(res.directives, [], "an unidentified caller drains nothing");
    assert.equal(incidentRow(id)?.status, "INVESTIGATING");
  });
});

describe("reads are not contained", () => {
  it("reads an incident that is not the caller's", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const mine = await openIncident(["sig-a"]);
    const theirs = await openIncident(["sig-b"]);

    const res = await toolsFor(mine).getIncident({ incidentId: theirs });

    assert.equal(res.ok, true, res.error);
    const view = res.data as IncidentView;
    assert.equal(view.incident.id, theirs);
    assert.deepEqual(
      view.signals.map((s) => s.id),
      ["sig-b"],
      "the signals come with it, or the read cannot answer what it is for",
    );
  });

  it("reads the caller's own incident when no id is given", async () => {
    await seed("sig-a");
    const mine = await openIncident(["sig-a"]);

    const res = await toolsFor(mine).getIncident();

    assert.equal((res.data as IncidentView).incident.id, mine);
  });

  it("reading another incident moves nothing and drains only the caller's own", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const mine = await openIncident(["sig-a"]);
    const theirs = await openIncident(["sig-b"]);
    await db.withWrite((w) => {
      w.prepare(
        "INSERT INTO pending_directive (incidentId, payload, createdAt) VALUES (?, ?, ?)",
      ).run(theirs, JSON.stringify({ type: "stop", reason: "not yours" }), 1);
    });

    const res = await toolsFor(mine).getIncident({ incidentId: theirs });

    assert.equal(res.ok, true, res.error);
    assert.deepEqual(
      res.directives,
      [],
      "a read of somebody else's incident does not collect their directives",
    );
    assert.equal(
      db.query("SELECT id FROM pending_directive WHERE incidentId = ?", [theirs])
        .length,
      1,
      "and leaves them where the agent that owns them will find them",
    );
    assert.deepEqual(signalsOn(theirs), ["sig-b"], "reading is not moving");
  });
});

describe("proposeMerge: the agent asks", () => {
  it("combines the two when the proposal is agreed, and tells both threads", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const older = await openIncident(["sig-a"]);
    const newer = await openIncident(["sig-b"]);
    await withThread(older);
    await withThread(newer);
    verdicts.push({
      merge: { absorb: newer, into: older, reason: "one pool, two alerts" },
      compared: true,
    });

    const res = await toolsFor(newer).proposeMerge({
      incidentId: older,
      reason: "the same connection pool",
    });

    assert.equal(res.ok, true, res.error);
    const data = res.data as MergeOutcomeView;
    assert.equal(data.combined, true);
    assert.equal(data.incidentOfRecord, older);
    assert.equal(incidentRow(newer)?.status, "MERGED");
    assert.deepEqual(signalsOn(older), ["sig-a", "sig-b"]);

    // The other suite covers these two messages thoroughly and reaches them
    // only through reportRootCause. A merge an agent asked for is the same
    // event for everybody reading either thread, and nothing else here would
    // notice if this route stopped telling them.
    assert.equal(postsIn(newer).length, 1, "the thread that goes quiet is told");
    assert.match(postsIn(newer)[0], /last message in this thread/);
    assert.equal(postsIn(older).length, 1, "and so is the one that carries on");
    assert.match(postsIn(older)[0], /is the same problem as this one/);
    assert.ok(
      posts.findIndex((post) => post.threadTs === `thread-${newer}`) <
        posts.findIndex((post) => post.threadTs === `thread-${older}`),
      "absorbed thread first, so a crash between the two loses the survivor's copy",
    );
  });

  it("writes nothing when the two are judged different problems", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const older = await openIncident(["sig-a"]);
    const newer = await openIncident(["sig-b"]);

    const res = await toolsFor(newer).proposeMerge({
      incidentId: older,
      reason: "both are 500s",
    });

    assert.equal(res.ok, true, res.error);
    const data = res.data as MergeOutcomeView;
    assert.equal(data.combined, false);
    assert.equal(data.incidentOfRecord, newer);
    assert.match(data.detail, /not the same problem/);
    assert.equal(incidentRow(older)?.status, "INVESTIGATING");
    assert.deepEqual(signalsOn(older), ["sig-a"], "asking moved nothing");
  });

  it("tells a considered no apart from nothing having compared them", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const older = await openIncident(["sig-a"]);
    const newer = await openIncident(["sig-b"]);
    verdicts.push({ merge: null, compared: false });

    const res = await toolsFor(newer).proposeMerge({
      incidentId: older,
      reason: "the same connection pool",
    });

    // One means stop asking; the other means ask a person. An agent handed
    // the same sentence for both would take a dead judgement for a verdict.
    const data = res.data as MergeOutcomeView;
    assert.match(data.detail, /could not be compared/);
    assert.doesNotMatch(data.detail, /not the same problem/);
  });

  it("says nothing about kinds of caller in anything it hands back", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const older = await openIncident(["sig-a"]);
    const newer = await openIncident(["sig-b"]);
    await db.withWrite((w) => {
      w.prepare(
        `UPDATE incident SET status = 'CLOSED', resolvedAt = 1, closedAt = 2,
           postmortem = 'closed by the test' WHERE id = ?`,
      ).run(older);
    });

    const res = await toolsFor(newer).proposeMerge({
      incidentId: older,
      reason: "the same connection pool",
    });

    // The agent repeats these into a Slack thread. A person reading "an
    // agent may not do that" is being shown a boundary they cannot see, did
    // not ask about and can do nothing with. Every sentence here is about
    // incidents and signals.
    const data = res.data as MergeOutcomeView;
    assert.equal(data.combined, false);
    assert.match(data.detail, /is CLOSED and is not taking signals/);
    assert.doesNotMatch(data.detail, /\bagent\b|\bboss\b|\bhuman\b|\bpermission\b/i);
  });

  it("refuses to weigh an incident against itself", async () => {
    await seed("sig-a");
    const mine = await openIncident(["sig-a"]);

    const res = await toolsFor(mine).proposeMerge({
      incidentId: mine,
      reason: "the same as me",
    });

    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /is this incident/);
  });
});

describe("directives", () => {
  it("returns a merge the agent never asked about", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);
    merges.push({ absorb: b, into: a, reason: "same pool exhaustion" });

    const res = await toolsFor(b).reportRootCause({
      cause: "pool exhaustion",
      explainedSignalIds: ["sig-b"],
    });

    assert.equal(res.ok, true, res.error);
    assert.deepEqual(res.directives, [{ type: "merged", into: a }]);
    assert.equal(incidentRow(b)?.status, "MERGED");
    assert.equal(incidentRow(b)?.mergedInto, a);
    assert.deepEqual(signalsOn(a), ["sig-a", "sig-b"]);
    // Read back rather than asserted. This call wrote FIXING and correlation
    // then absorbed the incident out from under it, so a response repeating
    // what it wrote would contradict the directive travelling beside it --
    // and the direction rule makes an absorbed reporting incident the
    // ordinary case rather than a corner of one.
    assert.equal(
      (res.data as { status: string }).status,
      "MERGED",
      "the status reports where the incident ended up, not what this call set",
    );
  });

  it("carries an absorbed incident's root cause to the agent that now owns the signals", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const older = await openIncident(["sig-a"]);
    const newer = await openIncident(["sig-b"]);
    merges.push({ absorb: newer, into: older, reason: "one pool, two alerts" });

    const res = await toolsFor(newer).reportRootCause({
      cause: "the upgrade webhook holds a connection per request",
      explainedSignalIds: ["sig-b"],
    });
    assert.equal(res.ok, true, res.error);

    // The cause cannot be written onto the survivor: that would be a
    // transition no agent made, past the gate that makes every attached
    // signal explained. So it reaches the surviving agent as something to
    // check, and the agent that found it is the one that closes.
    assert.equal(incidentRow(older)?.rootCause, null);
    const handed = db
      .query<{ payload: string }>(
        "SELECT payload FROM pending_directive WHERE incidentId = ? ORDER BY id",
        [older],
      )
      .map((r) => JSON.parse(r.payload) as { type: string; summary?: string });
    const news = handed.find((d) => d.type === "new_signals");
    assert.ok(news, "the surviving agent is told signals arrived");
    assert.match(
      news.summary ?? "",
      /upgrade webhook holds a connection per request/,
      "and told the cause the incident that just closed had found for them",
    );
    assert.match(
      news.summary ?? "",
      /nothing has checked it against the signals/,
      "as a claim to verify, which is the only honest form for an unverified cause",
    );
  });

  it("says so when it declines a merge the correlator proposed", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);
    // Status is the whole of what makes a merge target eligible now, so
    // resolving the target is how the correlator's proposal goes stale: a
    // signal moved onto a RESOLVED incident is one nothing will re-explain.
    const aTools = toolsFor(a);
    await aTools.reportRootCause({ cause: "pool exhaustion", explainedSignalIds: ["sig-a"] });
    await aTools.reportResolved({ prUrls: [], evidence: "quiet for an hour" });
    merges.push({ absorb: b, into: a, reason: "one pool, two alerts" });

    const lines = await logsDuring(async () => {
      const res = await toolsFor(b).reportRootCause({
        cause: "pool exhaustion",
        explainedSignalIds: ["sig-b"],
      });
      assert.equal(res.ok, true, res.error);
    });

    assert.equal(incidentRow(b)?.status, "FIXING", "the root cause still landed");
    assert.deepEqual(signalsOn(a), ["sig-a"], "and the merge did not");
    const declined = lines.find((line) => line.includes('"merge_declined"'));
    assert.ok(declined, "two incidents left on one cause is not something to pass over");
    assert.match(declined!, /"intoStatus":"RESOLVED"/);
  });

  it("drains on a rejected call as well as a successful one", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);
    await applyAssign(
      db,
      { signalIds: ["sig-b"], target: a, reason: "a human merged these" },
      { kind: "human", slackUserId: "U1" },
    );

    const res = await toolsFor(b).reportRootCause({
      cause: "still working on it",
      explainedSignalIds: ["sig-b"],
    });

    assert.equal(res.ok, false, "the incident is gone");
    assert.deepEqual(
      res.directives,
      [{ type: "merged", into: a }],
      "the reason for the rejection is the directive it came back with",
    );
  });

  it("delivers each directive exactly once", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    await db.withWrite((w) => {
      w.prepare(
        "INSERT INTO pending_directive (incidentId, payload, createdAt) VALUES (?, ?, ?)",
      ).run(id, JSON.stringify({ type: "resumed_after", seconds: 900 }), Date.now());
    });
    const tools = toolsFor(id);

    const first = await tools.getIncident();
    const second = await tools.getIncident();

    assert.deepEqual(first.directives, [{ type: "resumed_after", seconds: 900 }]);
    assert.deepEqual(second.directives, []);
  });
});

describe("escalate", () => {
  /**
   * Everything about the row, so "nothing moved" is the whole row and not a
   * list of columns somebody remembered to check. `escalate` replaced a tool
   * whose real effect was a write, and the reason it replaced it is that the
   * write took the incident out of the dispatcher's query and stranded it.
   */
  const rowOf = (id: string) =>
    db.get<Record<string, unknown>>("SELECT * FROM incident WHERE id = ?", [id]);

  it("posts the brief as mrkdwn, with what it quotes made safe", async () => {
    await seed("sig-fmt");
    const id = await openIncident(["sig-fmt"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({ cause: "auth change", explainedSignalIds: ["sig-fmt"] });

    await tools.escalate({
      reason: "deadline",
      brief: [
        "## What I believe now",
        "- **the cookie** is dropped, see [the run](https://ci.test/7)",
        "- the log says `parse failed near <Set-Cookie>`",
      ].join("\n"),
    });

    const text = posts.at(-1)?.text ?? "";
    assert.ok(text.includes("*What I believe now*"), text);
    assert.ok(text.includes("• *the cookie* is dropped"), text);
    assert.ok(text.includes("<https://ci.test/7|the run>"), text);
    // The quoted log line is the attacker-writable part. Unescaped, its `<`
    // swallows the rest of the brief and Slack still answers 200.
    assert.ok(text.includes("`parse failed near &lt;Set-Cookie&gt;`"), text);
    assert.doesNotMatch(text, /\*\*/);
  });

  it("splits a brief that escaping pushes past one message, keeping its tail", async () => {
    await seed("sig-long");
    const id = await openIncident(["sig-long"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({ cause: "auth change", explainedSignalIds: ["sig-long"] });

    // Inside the thread budget as written; conversion multiplies it past what
    // one message holds. A split for that reason is not the model writing too
    // much, so it still goes out whole.
    const brief = Array.from(
      { length: 34 },
      (_, i) => `- ruled out ${i} ${"&".repeat(18)}`,
    ).join("\n");
    assert.ok(brief.length <= THREAD_PROSE_CHARS, "the premise: inside the budget");

    const before = posts.length;
    await tools.escalate({ reason: "deadline", brief });

    const sent = posts.slice(before);
    assert.ok(sent.length > 1, `expected a split, got ${sent.length}`);
    assert.ok(
      sent.map((p) => p.text).join("").includes("ruled out 33"),
      "the tail is not dropped",
    );
  });

  it("refuses a brief past the thread budget instead of posting it anyway", async () => {
    await seed("sig-budget");
    const id = await openIncident(["sig-budget"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({
      cause: "auth change",
      explainedSignalIds: ["sig-budget"],
    });

    const before = posts.length;
    const res = await tools.escalate({
      reason: "deadline",
      brief: Array.from({ length: 400 }, (_, i) => `- ruled out ${i}`).join("\n"),
    });

    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /brief is \d+ characters/);
    assert.match(res.error ?? "", /post-mortem/);
    assert.equal(posts.length, before, "refused ahead of the post");
    // The refusal has to leave the incident exactly where it was, or the
    // model is told to rewrite a brief for an incident that has moved on.
    assert.equal(incidentRow(id)?.status, "FIXING");
  });

  it("changes nothing about the incident it escalates", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({ cause: "auth change", explainedSignalIds: ["sig-a"] });
    const before = rowOf(id);

    const res = await tools.escalate({
      reason: "the fix touches auth",
      brief: "What I believe now: the session cookie is dropped on refresh.",
    });

    assert.equal(res.ok, true, res.error);
    assert.deepEqual(res.data, { incidentId: id }, "there is no transition to report");
    assert.deepEqual(rowOf(id), before, "the row is untouched, which is the whole change");
    assert.match(posts.at(-1)?.text ?? "", /What I believe now/);
    assert.match(
      posts.at(-1)?.text ?? "",
      /An agent is still working this incident/,
      "a reader who is told an incident needs them assumes nothing else is on it",
    );
  });

  it("leaves every other tool working afterwards", async () => {
    // The gate this replaced revoked an agent's tools the moment an incident
    // changed hands, so an escalation was the end of the run. Escalating is
    // now an announcement, and the agent carries straight on.
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({ cause: "auth change", explainedSignalIds: ["sig-a"] });
    await tools.escalate({ reason: "the fix touches auth", brief: "ruled out DNS" });

    const resolved = await tools.reportResolved({
      prUrls: ["https://github.com/thegoodparty/omni/pull/1"],
      evidence: "quiet for an hour after the revert",
    });

    assert.equal(resolved.ok, true, resolved.error);
    assert.equal(incidentRow(id)?.status, "RESOLVED");
    const analysis = await tools.reportAnalysis({
      postmortem: "p",
      usersImpacted: 1,
      impactQuery: "q",
    });
    assert.equal(analysis.ok, true, analysis.error);
    assert.equal(incidentRow(id)?.status, "CLOSED");
  });

  it("refuses to escalate an incident nothing can be done about", async () => {
    await seed("sig-a", { closedAt: 2000 });
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({ cause: "c", explainedSignalIds: ["sig-a"] });
    await tools.reportResolved({ prUrls: [], evidence: "quiet" });
    await tools.reportAnalysis({ postmortem: "p", usersImpacted: 1, impactQuery: "q" });
    const before = posts.length;

    const res = await tools.escalate({ reason: "have a look", brief: "b" });

    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /is CLOSED; there is nothing left/);
    assert.equal(posts.length, before, "and nobody is called to a closed incident");
  });

  it("refuses to escalate an incident a merge took away", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);
    await mergedAway("sig-b", a);
    const before = posts.length;

    const res = await toolsFor(b).escalate({ reason: "have a look", brief: "b" });

    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /is MERGED; there is nothing left/);
    assert.equal(
      posts.length,
      before,
      "the thread everyone reads is the survivor's, so a brief here reaches nobody",
    );
  });

  it("reports a failed post as a failed escalation", async () => {
    // The only tool here that fails on a failed notification. Everywhere else
    // the state is already committed and the message is commentary; the whole
    // effect of this one is the message, so an escalation nobody was told
    // about has not happened.
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = createToolApi({
      db,
      token: mintAgentToken(SECRET, { incidentId: id, attempt: 1 }, 3600),
      tokenSecret: SECRET,
      correlator,
      slack: {
        ...linking,
        post: async () => {
          throw new Error("slack is down");
        },
      },
      evidence,
    });
    const before = rowOf(id);

    const res = await tools.escalate({
      reason: "the fix touches auth",
      brief: "What I believe now: the session cookie is dropped on refresh.",
    });

    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /nobody has been told/);
    assert.match(res.error ?? "", /worth calling again/);
    assert.deepEqual(rowOf(id), before, "and there is nothing to retract");
  });

  it("still lets triage attach new signals to an escalated incident", async () => {
    // Asking for a person is not the incident going quiet. An agent is still
    // driving it, so a related signal belongs on it rather than on a second
    // incident nobody has connected to the first.
    await seed("sig-a");
    await seed("sig-b");
    const id = await openIncident(["sig-a"]);
    await toolsFor(id).escalate({ reason: "the fix touches auth", brief: "b" });

    const res = await applyAssign(
      db,
      { signalIds: ["sig-b"], target: id, reason: "looks related" },
      { kind: "boss" },
    );

    assert.equal(res.target, id);
    assert.deepEqual(signalsOn(id), ["sig-a", "sig-b"]);
  });
});

describe("getIncident", () => {
  it("rehydrates the whole view", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    evidenceRows = [{ query: '{app="gp-api"}', summary: "120 errors", artifactKey: null }];

    const res = await toolsFor(id).getIncident();

    assert.equal(res.ok, true, res.error);
    const view = res.data as IncidentView;
    assert.equal(view.incident.id, id);
    assert.equal(view.incident.prUrls.length, 0, "prUrls arrives parsed, not as JSON text");
    assert.equal(view.signals.length, 1);
    assert.equal(view.signals[0].explained, false, "explained arrives as a boolean");
    assert.deepEqual(view.evidence, evidenceRows);
  });

  it("survives an evidence store that is down", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = createToolApi({
      db,
      token: mintAgentToken(SECRET, { incidentId: id, attempt: 1 }, 3600),
      tokenSecret: SECRET,
      correlator,
      slack,
      evidence: {
        load: async () => {
          throw new Error("S3 is having a day");
        },
      },
    });

    const res = await tools.getIncident();

    assert.equal(res.ok, true, "a missing evidence bundle is not a failed rehydration");
    assert.deepEqual((res.data as IncidentView).evidence, []);
  });
});

describe("assign never attaches across RESOLVED", () => {
  it("refuses a resolved incident as a target", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({ cause: "c", explainedSignalIds: ["sig-a"] });
    await tools.reportResolved({ prUrls: [], evidence: "quiet" });

    await assert.rejects(
      applyAssign(
        db,
        { signalIds: ["sig-b"], target: id, reason: "looks like the same thing" },
        { kind: "boss" },
      ),
      /is RESOLVED and cannot take signals/,
    );
    assert.equal(
      db.get<{ incidentId: string | null }>(
        "SELECT incidentId FROM signal WHERE id = 'sig-b'",
      )?.incidentId,
      null,
      "a signal arriving after a resolution is a recurrence, not more of that incident",
    );
  });
});


describe("when the database stops taking writes", () => {
  it("keeps a committed transition when directive delivery fails", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    await toolsFor(id).reportRootCause({ cause: "c", explainedSignalIds: ["sig-a"] });
    await db.withWrite((w) => {
      w.prepare(
        "INSERT INTO pending_directive (incidentId, payload, createdAt) VALUES (?, ?, ?)",
      ).run(id, JSON.stringify({ type: "resumed_after", seconds: 60 }), Date.now());
    });
    const tools = createToolApi({
      db: writesDieAfter(1),
      token: mintAgentToken(SECRET, { incidentId: id, attempt: 1 }, 3600),
      tokenSecret: SECRET,
      correlator,
      slack,
      evidence,
    });

    let res: Awaited<ReturnType<ToolApi["reportResolved"]>> | undefined;
    const alarms = await alarmsDuring(async () => {
      res = await tools.reportResolved({ prUrls: [], evidence: "quiet" });
    });

    assert.equal(res?.ok, true, "the transition committed, so it must not be reported as failed");
    assert.equal(incidentRow(id)?.status, "RESOLVED");
    assert.deepEqual(res?.directives, [], "delivery is deferred, not claimed");
    assert.equal(
      db.query("SELECT id FROM pending_directive WHERE incidentId = ?", [id]).length,
      1,
      "and the directive is still queued for the next call",
    );
    assert.ok(
      alarms.some((line) => line.includes('"drain_failed"')),
      "a delivery that could not happen is worth telling someone about",
    );
  });

  it("alarms on a lost transition instead of logging it at info", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = createToolApi({
      db: writesDieAfter(0),
      token: mintAgentToken(SECRET, { incidentId: id, attempt: 1 }, 3600),
      tokenSecret: SECRET,
      correlator,
      slack,
      evidence,
    });

    let res: Awaited<ReturnType<ToolApi["reportRootCause"]>> | undefined;
    const alarms = await alarmsDuring(async () => {
      res = await tools.reportRootCause({ cause: "c", explainedSignalIds: ["sig-a"] });
    });

    assert.equal(res?.ok, false, "and it still reaches the model as an error, not a crash");
    assert.match(res?.error ?? "", /writes halted/);
    assert.equal(incidentRow(id)?.status, "INVESTIGATING", "the transition is gone");
    assert.ok(
      alarms.some(
        (line) => line.includes('"level":"error"') && line.includes('"failed"'),
      ),
      "the dispatcher will relaunch on this forever, which is nobody's idea of info",
    );
  });
});

describe("time to detect", () => {
  it("records when impact began, separately from when we heard", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);

    const began = 1_700_000_000_000;
    await tools.reportRootCause({
      cause: "the upgrade webhook wrote to the wrong column",
      explainedSignalIds: ["sig-a"],
      impactStartedAt: began,
    });

    // The gap between this and firstSignalAt is time to detect, and it is the
    // one number here that measures the alert rules rather than the agents.
    assert.equal(incidentRow(id)?.impactStartedAt, began);
  });

  it("leaves it null when the agent cannot point at an event", async () => {
    await seed("sig-b");
    const id = await openIncident(["sig-b"]);
    await toolsFor(id).reportRootCause({
      cause: "c",
      explainedSignalIds: ["sig-b"],
    });

    // A guess would be worse than nothing: an invented start makes the metric
    // look computed when it is fabricated.
    assert.equal(incidentRow(id)?.impactStartedAt, null);
  });
});

describe("agent tokens expire", () => {
  it("refuses a token carrying no expiry", () => {
    // jwt.verify rejects an `exp` in the past but accepts one that is absent,
    // so a token minted without an expiry would verify forever. The threat is
    // not the Boss minting one by accident; it is that a child which leaked
    // its token keeps a working credential against the still-running Boss
    // long after its incident closed.
    const forever = jwt.sign({ attempt: 1 }, SECRET, {
      algorithm: "HS256",
      audience: "bugboss-toolapi",
      subject: "42",
    });

    assert.throws(
      () => verifyAgentToken(SECRET, forever),
      /carries no expiry/,
    );
  });

  it("refuses a token past its expiry", () => {
    const expired = mintAgentToken(SECRET, { incidentId: "42", attempt: 1 }, -1);
    assert.throws(() => verifyAgentToken(SECRET, expired), /invalid agent token/);
  });

  it("accepts a live one", () => {
    const live = mintAgentToken(SECRET, { incidentId: "42", attempt: 1 }, 3600);
    assert.equal(verifyAgentToken(SECRET, live).incidentId, "42");
  });
});

describe("a merge is told to both threads", () => {
  it("names the other incident in each thread, and links to it", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);
    await withThread(a);
    await withThread(b);
    merges.push({ absorb: b, into: a, reason: "one pool, two alerts" });

    const res = await toolsFor(b).reportRootCause({
      cause: "pool exhaustion",
      explainedSignalIds: ["sig-b"],
    });

    assert.equal(res.ok, true, res.error);
    const absorbing = postsIn(a);
    const absorbed = postsIn(b);
    assert.equal(absorbing.length, 1, "the thread everyone keeps reading");
    assert.equal(absorbed.length, 1, "and the one that is about to go quiet");

    // Order, not just presence. The absorbed thread is never written to again,
    // so if a crash between the two posts lands only one, it has to be that
    // one -- the alternative is a surviving thread announcing that a thread is
    // closing while that thread says nothing and simply stops.
    assert.ok(
      posts.findIndex((post) => post.threadTs === `thread-${b}`) <
        posts.findIndex((post) => post.threadTs === `thread-${a}`),
      "the absorbed thread is closed out before the surviving one is told",
    );

    assert.match(absorbing[0], new RegExp(`Incident ${b} is the same problem`));
    assert.match(absorbing[0], /one pool, two alerts/, "and why we believe that");
    assert.match(
      absorbing[0],
      new RegExp(
        `<https://goodparty\\.slack\\.com/archives/C09/pthread-${b}\\|incident ${b}'s thread>`,
      ),
      "a reader who has never used this has to be able to go and look",
    );
    assert.match(absorbing[0], /updates for both incidents arrive here/);

    assert.match(absorbed[0], new RegExp(`same problem as incident ${a}`));
    assert.match(
      absorbed[0],
      /last message in this thread/,
      "a thread that simply stops is indistinguishable from the Boss having died",
    );
    assert.match(
      absorbed[0],
      new RegExp(
        `<https://goodparty\\.slack\\.com/archives/C09/pthread-${a}\\|incident ${a}'s thread>`,
      ),
    );
  });

  it("keeps the merge when the thread cannot be posted to", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);
    await withThread(a);
    await withThread(b);
    merges.push({ absorb: b, into: a, reason: "one pool, two alerts" });
    const tools = createToolApi({
      db,
      token: mintAgentToken(SECRET, { incidentId: b, attempt: 1 }, 3600),
      tokenSecret: SECRET,
      correlator,
      slack: {
        ...linking,
        post: async () => {
          throw new Error("slack is down");
        },
      },
      evidence,
    });

    let res: Awaited<ReturnType<ToolApi["reportRootCause"]>> | undefined;
    const alarms = await alarmsDuring(async () => {
      res = await tools.reportRootCause({
        cause: "pool exhaustion",
        explainedSignalIds: ["sig-b"],
      });
    });

    assert.equal(res?.ok, true, "the merge is the durable fact; the post is a notice");
    assert.equal(incidentRow(b)?.status, "MERGED");
    assert.equal(incidentRow(b)?.mergedInto, a);
    assert.deepEqual(signalsOn(a), ["sig-a", "sig-b"]);
    assert.ok(
      alarms.some((line) => line.includes('"thread_post_failed"')),
      "but nobody was told, and that is not something to swallow",
    );
  });

  it("closes out the absorbed thread even when the surviving one refuses the post", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);
    await withThread(a);
    await withThread(b);
    merges.push({ absorb: b, into: a, reason: "one pool, two alerts" });
    const tools = createToolApi({
      db,
      token: mintAgentToken(SECRET, { incidentId: b, attempt: 1 }, 3600),
      tokenSecret: SECRET,
      correlator,
      // Only the surviving thread is down. The absorbed one is the half that
      // never gets another chance, so it cannot be the one that loses.
      slack: {
        ...slack,
        post: async (threadTs: string | null, text: string) => {
          if (threadTs === `thread-${a}`) throw new Error("slack is down");
          return slack.post(threadTs, text);
        },
      },
      evidence,
    });

    const alarms = await alarmsDuring(async () => {
      const res = await tools.reportRootCause({
        cause: "pool exhaustion",
        explainedSignalIds: ["sig-b"],
      });
      assert.equal(res.ok, true, res.error);
    });

    assert.equal(postsIn(b).length, 1, "the thread about to go quiet was told");
    assert.match(postsIn(b)[0], /last message in this thread/);
    assert.ok(alarms.some((line) => line.includes('"thread_post_failed"')));
  });

  it("says so when the absorbed incident has no thread to close out", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);
    await withThread(a);
    merges.push({ absorb: b, into: a, reason: "one pool, two alerts" });

    const alarms = await alarmsDuring(async () => {
      const res = await toolsFor(b).reportRootCause({
        cause: "pool exhaustion",
        explainedSignalIds: ["sig-b"],
      });
      assert.equal(res.ok, true, res.error);
    });

    assert.equal(postsIn(a).length, 1, "the surviving thread is still told");
    assert.match(postsIn(a)[0], new RegExp(`incident ${b}'s thread`));
    assert.ok(
      alarms.some((line) => line.includes('"absorbed_thread_missing"')),
      "an incident that reached a merge without a thread is a broken link",
    );
  });

  it("still says what happened when the permalink call fails", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);
    await withThread(a);
    await withThread(b);
    merges.push({ absorb: b, into: a, reason: "one pool, two alerts" });
    const tools = createToolApi({
      db,
      token: mintAgentToken(SECRET, { incidentId: b, attempt: 1 }, 3600),
      tokenSecret: SECRET,
      correlator,
      slack: {
        ...slack,
        permalink: async () => {
          throw new Error("chat.getPermalink: ratelimited");
        },
      },
      evidence,
    });

    const alarms = await alarmsDuring(async () => {
      const res = await tools.reportRootCause({
        cause: "pool exhaustion",
        explainedSignalIds: ["sig-b"],
      });
      assert.equal(res.ok, true, res.error);
    });

    assert.equal(postsIn(a).length, 1);
    assert.equal(postsIn(b).length, 1);
    assert.doesNotMatch(postsIn(b)[0], /<http/, "there is no link to give");
    assert.match(
      postsIn(b)[0],
      new RegExp(`incident ${a}'s thread`),
      "so the sentence names it instead of losing it",
    );
    assert.ok(alarms.some((line) => line.includes('"permalink_failed"')));
  });
});

describe("a split is told to both threads", () => {
  it("points the old thread at the new incident and the new one back", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const id = await openIncident(["sig-a", "sig-b"]);
    await withThread(id);

    const res = await toolsFor(id).reportRootCause({
      cause: "the Pro webhook wrote to the wrong column",
      explainedSignalIds: ["sig-a"],
    });

    assert.equal(res.ok, true, res.error);
    const born = (res.data as { splitInto: string[] }).splitInto;
    assert.equal(born.length, 1);

    const source = postsIn(id);
    assert.equal(source.length, 1);
    assert.match(source[0], /1 signal left this incident/);
    assert.match(
      source[0],
      new RegExp(
        `<https://goodparty\\.slack\\.com/archives/C09/pthread-${born[0]}\\|incident ${born[0]}>`,
      ),
      "naming an incident nobody can find is the same gap as saying nothing",
    );

    const fresh = postsIn(born[0]);
    assert.equal(fresh.length, 1, "a thread that opens with no origin reads as nowhere");
    assert.match(fresh[0], new RegExp(`split out of incident ${id}`));
    assert.match(
      fresh[0],
      new RegExp(
        `<https://goodparty\\.slack\\.com/archives/C09/pthread-${id}\\|its own thread>`,
      ),
    );
  });

  it("uses the thread openThreads had to open for the incident being split", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const id = await openIncident(["sig-a", "sig-b"]);

    const res = await toolsFor(id).reportRootCause({
      cause: "the Pro webhook wrote to the wrong column",
      explainedSignalIds: ["sig-a"],
    });

    assert.equal(res.ok, true, res.error);
    const born = (res.data as { splitInto: string[] }).splitInto;
    assert.equal(
      postsIn(id).length,
      1,
      "the incident got its thread here, so the announcement belongs in it and not at the top level",
    );
    assert.match(
      postsIn(born[0])[0],
      new RegExp(
        `<https://goodparty\\.slack\\.com/archives/C09/pthread-${id}\\|its own thread>`,
      ),
      "and the back-link points at it rather than coming out blank",
    );
  });

  it("tells both threads when a resolution sheds a signal its root cause never explained", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const id = await openIncident(["sig-a"]);
    await withThread(id);
    const tools = toolsFor(id);
    await tools.reportRootCause({
      cause: "the Pro webhook wrote to the wrong column",
      explainedSignalIds: ["sig-a"],
    });
    // Triage attaches across FIXING, which is how an incident acquires a
    // signal its root cause was never asked about.
    await applyAssign(
      db,
      { signalIds: ["sig-b"], target: id, reason: "looked like the same thing" },
      { kind: "boss" },
    );
    posts.length = 0;

    const res = await tools.reportResolved({
      prUrls: [],
      evidence: "quiet for an hour",
    });

    assert.equal(res.ok, true, res.error);
    const born = (res.data as { splitInto: string[] }).splitInto;
    assert.equal(born.length, 1);
    assert.match(postsIn(id)[0], /1 signal left this incident/);
    assert.match(
      postsIn(id)[0],
      new RegExp(
        `<https://goodparty\\.slack\\.com/archives/C09/pthread-${born[0]}\\|incident ${born[0]}>`,
      ),
    );
    assert.equal(
      postsIn(born[0]).length,
      1,
      "an incident that appears at the moment another one resolves needs its own origin",
    );
    assert.match(postsIn(born[0])[0], new RegExp(`split out of incident ${id}`));
    assert.match(
      postsIn(born[0])[0],
      new RegExp(
        `<https://goodparty\\.slack\\.com/archives/C09/pthread-${id}\\|its own thread>`,
      ),
    );
  });

  it("posts the resolution into the thread the split had to open", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({
      cause: "the Pro webhook wrote to the wrong column",
      explainedSignalIds: ["sig-a"],
    });
    await applyAssign(
      db,
      { signalIds: ["sig-b"], target: id, reason: "looked like the same thing" },
      { kind: "boss" },
    );
    posts.length = 0;

    const res = await tools.reportResolved({
      prUrls: [],
      evidence: "quiet for an hour",
    });

    assert.equal(res.ok, true, res.error);
    assert.equal(
      posts.filter((p) => p.threadTs === null).length,
      0,
      "a message at the top of the channel is one nothing groups with the incident",
    );
    assert.equal(postsIn(id).length, 2, "the split notice and the resolution");
    assert.match(postsIn(id)[1], new RegExp(`Incident ${id} resolved`));
  });

  it("says so when the split incident never got a thread", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const id = await openIncident(["sig-a", "sig-b"]);
    await withThread(id);
    const tools = createToolApi({
      db,
      token: mintAgentToken(SECRET, { incidentId: id, attempt: 1 }, 3600),
      tokenSecret: SECRET,
      correlator,
      slack: {
        ...slack,
        openThreads: async () => {
          throw new Error("slack is down");
        },
      },
      evidence,
    });

    const alarms = await alarmsDuring(async () => {
      const res = await tools.reportRootCause({
        cause: "the Pro webhook wrote to the wrong column",
        explainedSignalIds: ["sig-a"],
      });
      assert.equal(res.ok, true, res.error);
    });

    assert.equal(postsIn(id).length, 1, "the thread that lost the signals is still told");
    assert.ok(alarms.some((line) => line.includes('"split_threads_unopened"')));
    assert.ok(alarms.some((line) => line.includes('"split_thread_missing"')));
  });
});

describe("a recurrence closes on a second question", () => {
  /** An incident already closed, and a live one that reopens its ground. */
  const recurrencePair = async () => {
    await seed("sig-old");
    const first = await openIncident(["sig-old"]);
    const firstTools = toolsFor(first);
    await firstTools.reportRootCause({
      cause: "the connection pool was sized for the old traffic shape",
      explainedSignalIds: ["sig-old"],
    });
    await firstTools.reportResolved({
      prUrls: ["https://github.com/thegoodparty/omni/pull/1"],
      evidence: "zero matching lines for 90 minutes after the deploy",
    });
    await firstTools.reportAnalysis({
      postmortem: "## Summary\nthe pool was too small",
      usersImpacted: 3,
      impactQuery: "q",
    });

    await seed("sig-new");
    const second = (
      await applyAssign(
        db,
        { signalIds: ["sig-new"], target: "NEW", reason: "it is back" },
        { kind: "boss" },
        { recurrenceOf: first },
      )
    ).target;
    const secondTools = toolsFor(second);
    await secondTools.reportRootCause({
      cause: "the pool is still too small on the write path",
      explainedSignalIds: ["sig-new"],
    });
    return { first, second, tools: secondTools };
  };

  it("hands the agent the prior incident's post-mortem whole", async () => {
    // It used to be cut at 6,000 characters, and the reason given was that
    // the agent's own tool-output truncation kept a head and a tail, so an
    // unbounded post-mortem would eat the middle of the incident rather
    // than itself. That truncation is gone -- Pi compacts just in time, so
    // a tool result lands whole and what gives way is summarised history.
    // This is the document the agent has to read to say why the last fix
    // did not hold, so the half that used to go is the half it needs.
    const { first, tools } = await recurrencePair();
    const remedy = "and the remedy nobody applied was to size the write pool";
    const long = `## Summary\n${"p".repeat(20_000)}\n${remedy}`;
    await db.withWrite((w) =>
      w.prepare("UPDATE incident SET postmortem = ? WHERE id = ?").run(long, first),
    );

    const res = await tools.getIncident();

    assert.equal(res.ok, true, res.error);
    const carried = JSON.stringify(res.data);
    assert.ok(carried.includes(remedy), "the end of the post-mortem is there");
    assert.ok(!carried.includes("[truncated"));
  });

  it("refuses to close without an answer to why the last resolution failed", async () => {
    const { first, second, tools } = await recurrencePair();
    await tools.reportResolved({
      prUrls: ["https://github.com/thegoodparty/omni/pull/2"],
      evidence: "the write path is quiet through two full refresh cycles",
    });

    const closed = await tools.reportAnalysis({
      postmortem: "## Summary\nsized the pool again",
      usersImpacted: 4,
      impactQuery: "q",
    });

    assert.equal(closed.ok, false);
    assert.match(String(closed.error), new RegExp(`recurrence of ${first}`));
    assert.equal(
      incidentRow(second)?.status,
      "RESOLVED",
      "an unexplained recurrence stays open rather than closing on a blank",
    );
  });

  it("refuses an answer too short to be one", async () => {
    const { tools } = await recurrencePair();
    await tools.reportResolved({
      prUrls: ["https://github.com/thegoodparty/omni/pull/2"],
      evidence: "the write path is quiet through two full refresh cycles",
    });

    const closed = await tools.reportAnalysis({
      postmortem: "## Summary\nagain",
      usersImpacted: 4,
      impactQuery: "q",
      recurrence: {
        category: "previous_fix_incomplete",
        why: "too small",
        remedy: "fixed it",
      },
    });

    assert.equal(closed.ok, false);
    assert.match(String(closed.error), /recurrence\.why is too short/);
  });

  it("closes with one, and stores it", async () => {
    const { second, tools } = await recurrencePair();
    await tools.reportResolved({
      prUrls: ["https://github.com/thegoodparty/omni/pull/2"],
      evidence: "the write path is quiet through two full refresh cycles",
    });

    const closed = await tools.reportAnalysis({
      postmortem: "## Summary\nsized the pool on both paths",
      usersImpacted: 4,
      impactQuery: "q",
      recurrence: {
        category: "previous_fix_incomplete",
        why: "the earlier fix sized the read pool only, and the write path has its own",
        remedy: "sized both pools and added an assertion that they are configured together",
      },
    });

    assert.equal(closed.ok, true, closed.error);
    const stored = db.get<{ recurrenceAnalysis: string | null }>(
      "SELECT recurrenceAnalysis FROM incident WHERE id = ?",
      [second],
    );
    assert.equal(
      JSON.parse(String(stored?.recurrenceAnalysis)).category,
      "previous_fix_incomplete",
    );
    assert.ok(
      posts.some((p) => p.text.includes("Why it recurred")),
      "the answer reaches the thread, not only a column",
    );
  });

  it("says plainly when the fix belongs in BugBoss, which agents cannot open PRs against", async () => {
    const { tools } = await recurrencePair();
    await tools.reportResolved({
      prUrls: ["https://github.com/thegoodparty/omni/pull/2"],
      evidence: "the write path is quiet through two full refresh cycles",
    });

    await tools.reportAnalysis({
      postmortem: "## Summary\nsized the pool",
      usersImpacted: 4,
      impactQuery: "q",
      recurrence: {
        category: "bugboss_defect",
        why: "triage attached the second firing to the resolved incident, so nobody re-investigated",
        remedy: "proposed tightening the attach guard in triage/triage.ts and raised it in the thread",
      },
    });

    const post = posts.find((p) => p.text.includes("BugBoss let this recur"));
    assert.ok(post, "a defect in the system itself must not end in a closed column");
    assert.match(post!.text, /needs a person/);
  });

  it("refuses the resolution evidence the last one was closed on", async () => {
    const { tools } = await recurrencePair();

    const resolved = await tools.reportResolved({
      prUrls: ["https://github.com/thegoodparty/omni/pull/2"],
      evidence: "zero matching lines for 90 minutes after the deploy",
    });

    assert.equal(resolved.ok, false);
    assert.match(String(resolved.error), /did not hold/);
  });

  it("leaves an ordinary incident alone", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({ cause: "a cause", explainedSignalIds: ["sig-a"] });
    await tools.reportResolved({
      prUrls: ["https://github.com/thegoodparty/omni/pull/1"],
      evidence: "quiet for an hour",
    });

    const closed = await tools.reportAnalysis({
      postmortem: "## Summary\nfine",
      usersImpacted: 1,
      impactQuery: "q",
    });

    assert.equal(closed.ok, true, closed.error);
  });

  it("makes a closed incident searchable without waiting for a restart", async () => {
    const { first, tools } = await recurrencePair();
    const hits = await tools.searchIncidents({
      text: "connection pool sized for old traffic",
    });

    assert.equal(hits.ok, true, hits.error);
    assert.ok(
      (hits.data ?? []).some((hit) => hit.incidentId === first),
      "the index is written in the same transaction as the close",
    );
  });

  it("refuses a query with no searchable words rather than answering empty", async () => {
    // This tool exists so an agent can find out whether a new alert is
    // something already closed. `ok: true, data: []` is a confident "no
    // prior incident", and on a stopword-only query the search never ran at
    // all -- so the two have to be different answers.
    const { tools } = await recurrencePair();

    const unsearchable = await tools.searchIncidents({
      text: "the error in production after the alert failed",
    });
    const matchedNothing = await tools.searchIncidents({
      text: "certificate rotation expiry",
    });

    assert.equal(unsearchable.ok, false);
    assert.match(String(unsearchable.error), /did not run/);
    assert.equal(matchedNothing.ok, true, matchedNothing.error);
    assert.deepEqual(matchedNothing.data, []);
  });
});

// ---------------------------------------------------------------------------

describe("set_summary: what the incident is", () => {
  it("is callable before there is any conclusion at all", async () => {
    await seed("sig-sum-1");
    const incidentId = await openIncident(["sig-sum-1"]);
    const tools = toolsFor(incidentId);

    const response = await tools.setSummary({ summary: "Checkout is failing" });

    assert.equal(response.ok, true, response.error);
    assert.equal(incidentRow(incidentId)?.summary, "Checkout is failing");
  });

  /**
   * Incident 79 opened on a memory alert and became the Loki 429 explosion.
   * The whole field exists so that is a thing the system can say.
   */
  it("replaces what was there, because the incident changed", async () => {
    await seed("sig-sum-2");
    const incidentId = await openIncident(["sig-sum-2"]);
    const tools = toolsFor(incidentId);

    await tools.setSummary({ summary: "Memory alert on bugboss-prod" });
    await tools.setSummary({ summary: "Loki reads are being rejected" });

    assert.equal(
      incidentRow(incidentId)?.summary,
      "Loki reads are being rejected",
    );
  });

  /**
   * Nothing is announced. A title changing is not news; the thread's header
   * picks it up on the next sweep, and a message every time an agent
   * sharpens four words is how a channel gets muted.
   */
  it("says nothing in the thread", async () => {
    await seed("sig-sum-3");
    const incidentId = await openIncident(["sig-sum-3"]);
    const before = posts.length;

    await toolsFor(incidentId).setSummary({ summary: "Checkout is failing" });

    assert.equal(posts.length, before);
  });

  /**
   * Refused, never truncated. A title cut at eighty characters reads as a
   * complete thought that happens to be wrong, and the thing that wrote it
   * is a model that can be asked again. Same shape as overThreadBudget.
   */
  it("refuses one that is too long, naming both numbers and where it belongs", async () => {
    await seed("sig-sum-4");
    const incidentId = await openIncident(["sig-sum-4"]);
    const long = "Loki is rejecting reads ".repeat(10);

    const response = await toolsFor(incidentId).setSummary({ summary: long });

    assert.equal(response.ok, false);
    assert.match(
      String(response.error),
      new RegExp(String(long.trim().length)),
      "the number it quotes is the length of what it would have stored",
    );
    assert.match(String(response.error), /80/);
    assert.match(String(response.error), /root cause/);
    assert.equal(
      incidentRow(incidentId)?.summary,
      null,
      "and writes nothing, so the row keeps no half of it",
    );
  });

  it("collapses a title somebody wrote across two lines", async () => {
    await seed("sig-sum-5");
    const incidentId = await openIncident(["sig-sum-5"]);

    await toolsFor(incidentId).setSummary({ summary: "Checkout\n  is failing" });

    assert.equal(incidentRow(incidentId)?.summary, "Checkout is failing");
  });

  it("refuses whitespace, which is not a title", async () => {
    await seed("sig-sum-6");
    const incidentId = await openIncident(["sig-sum-6"]);

    const response = await toolsFor(incidentId).setSummary({ summary: "   " });

    assert.equal(response.ok, false);
    assert.equal(incidentRow(incidentId)?.summary, null);
  });

  it("is refused on an incident that has been merged away", async () => {
    await seed("sig-sum-7");
    await seed("sig-sum-8");
    // Survivor first, because a merge only goes into the more established
    // incident now. What this test is about is the status, not the order.
    const survivor = await openIncident(["sig-sum-8"]);
    const absorbed = await openIncident(["sig-sum-7"]);
    await mergedAway("sig-sum-7", survivor);

    const response = await toolsFor(absorbed).setSummary({ summary: "anything" });

    assert.equal(response.ok, false);
  });
});

describe("an incident that absorbed another one", () => {
  const merged = async (tag: string) => {
    await seed(`sig-${tag}-a`);
    await seed(`sig-${tag}-b`);
    const survivor = await openIncident([`sig-${tag}-a`]);
    const absorbed = await openIncident([`sig-${tag}-b`]);
    await toolsFor(absorbed).setSummary({ summary: `what ${tag} was` });
    await applyAssign(
      db,
      {
        signalIds: [`sig-${tag}-b`],
        target: survivor,
        reason: "one bug, two alerts",
      },
      { kind: "human", slackUserId: "U1" },
    );
    return { survivor, absorbed };
  };

  /**
   * Without this the merge reaches the surviving agent as an unexplained
   * pile of new signals, and the agent is then expected to keep an honest
   * title for an incident it was never told about.
   */
  it("is told so, by name, on the directive that carries the signals", async () => {
    const { survivor, absorbed } = await merged("abs1");

    const view = await toolsFor(survivor).getIncident();

    const news = view.directives.find((d) => d.type === "new_signals");
    assert.ok(news, JSON.stringify(view.directives));
    assert.deepEqual(
      news.type === "new_signals" ? news.absorbed : null,
      [absorbed],
    );
  });

  /**
   * Same shape and the same reason as `priorIncident`: somebody already
   * investigated part of what is now this incident's problem, and an agent
   * cannot write an honest title for something it never saw.
   */
  it("can read what that incident had found, on the first get_incident", async () => {
    const { survivor, absorbed } = await merged("abs2");

    const view = await toolsFor(survivor).getIncident();

    const read = (view.data as IncidentView).absorbed;
    assert.deepEqual(
      read.map((r) => r.id),
      [absorbed],
    );
    assert.equal(read[0].summary, "what abs2 was");
    assert.equal(read[0].status, "MERGED");
  });

  it("an incident that absorbed nothing carries an empty list, not a null", async () => {
    await seed("sig-abs3");
    const incidentId = await openIncident(["sig-abs3"]);

    const view = await toolsFor(incidentId).getIncident();

    assert.deepEqual((view.data as IncidentView).absorbed, []);
  });

  /**
   * Read off `mergedInto` rather than remembered, so it is the same answer
   * after a restart and after a merge this process never saw.
   */
  it("is still readable by a process that did not see the merge happen", async () => {
    const { survivor, absorbed } = await merged("abs4");
    await db.withWrite((w) => {
      w.prepare("DELETE FROM pending_directive WHERE incidentId = ?").run(survivor);
    });

    const view = await toolsFor(survivor).getIncident();

    assert.deepEqual(
      (view.data as IncidentView).absorbed.map((r) => r.id),
      [absorbed],
    );
  });
});
