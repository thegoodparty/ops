import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type Database from "better-sqlite3";
import type { S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import type { Evidence, IncidentView, ToolApi } from "../types";
import { applyAssign } from "./assign";
import { createToolApi, type CorrelationMerge } from "./index";
import jwt from "jsonwebtoken";

import { mintAgentToken, verifyAgentToken } from "./token";

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

const slack = {
  post: async (threadTs: string | null, text: string) => {
    posts.push({ threadTs, text });
    return { ts: `ts-${posts.length}` };
  },
};

const correlator = {
  correlate: async () => merges.splice(0, merges.length),
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

/** A human claiming the incident in Slack. Returned unawaited by the races. */
const humanClaims = (id: string) =>
  db.withWrite((w) => {
    w.prepare("UPDATE incident SET owner = 'human' WHERE id = ?").run(id);
  });

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
    owner: string;
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

  it("refuses a resolution a human takeover landed in front of", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({ cause: "c", explainedSignalIds: ["sig-a"] });

    const claim = humanClaims(id);
    const resolved = tools.reportResolved({
      prUrls: ["https://github.com/thegoodparty/omni/pull/1"],
      evidence: "quiet for an hour",
    });
    await claim;
    const res = await resolved;

    assert.equal(res.ok, false);
    assert.equal(incidentRow(id)?.status, "FIXING", "the human's record did not move");
    assert.equal(incidentRow(id)?.resolvedEvidence, null);
    assert.deepEqual(JSON.parse(incidentRow(id)!.prUrls), []);
    assert.equal(
      db.query("SELECT id FROM signal WHERE incidentId = ? AND closedAt IS NULL", [id])
        .length,
      1,
      "and the signals a resolution would have closed are still open",
    );
  });

  // Rewritten: this asserted that a human takeover refuses the post-mortem.
  // That was the old contract and it threw away the one artifact a takeover
  // is usually for. A takeover now pushes `handoff` and lets the agent finish
  // its write-up, so reportAnalysis is the single tool an owner change does
  // not block. Every other transition still loses the race, which the three
  // sibling tests here cover.
  it("lets the agent's write-up land even after a human takes over", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({ cause: "c", explainedSignalIds: ["sig-a"] });
    await tools.reportResolved({ prUrls: [], evidence: "quiet" });

    const claim = humanClaims(id);
    const analysis = tools.reportAnalysis({
      postmortem: "p",
      usersImpacted: 4,
      impactQuery: "q",
    });
    await claim;
    const res = await analysis;

    assert.equal(res.ok, true, res.error);
    assert.equal(incidentRow(id)?.status, "CLOSED");
    assert.equal(incidentRow(id)?.postmortem, "p");
    assert.equal(
      incidentRow(id)?.owner,
      "human",
      "the write-up lands without taking the incident back",
    );
  });

  it("refuses an impact number a human takeover landed in front of", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);

    const claim = humanClaims(id);
    const impact = tools.reportImpact({ usersImpacted: 99, query: "q" });
    await claim;
    const res = await impact;

    assert.equal(res.ok, false);
    assert.equal(incidentRow(id)?.usersImpacted, null);
    assert.equal(incidentRow(id)?.impactQuery, null);
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
  });

  it("says so when it declines a merge the correlator proposed", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = await openIncident(["sig-a"]);
    const b = await openIncident(["sig-b"]);
    await toolsFor(a).handOff({ reason: "mine now", brief: "taking this one" });
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
    assert.match(declined!, /"intoStatus":"INVESTIGATING"/);
    assert.match(declined!, /"intoOwner":"human"/);
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

describe("hand off", () => {
  it("is terminal for the agent and leaves the incident open", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = toolsFor(id);
    await tools.reportRootCause({ cause: "auth change", explainedSignalIds: ["sig-a"] });

    const res = await tools.handOff({
      reason: "the fix touches auth",
      brief: "What I believe now: the session cookie is dropped on refresh.",
    });

    assert.equal(res.ok, true, res.error);
    assert.equal(incidentRow(id)?.owner, "human");
    assert.equal(incidentRow(id)?.status, "FIXING", "handing off is not closing");
    assert.match(posts.at(-1)?.text ?? "", /What I believe now/);

    const after = await tools.reportResolved({ prUrls: [], evidence: "x" });
    assert.equal(after.ok, false);
    assert.match(after.error ?? "", /owned by a human/);

    const view = await tools.getIncident();
    assert.equal(view.ok, true, "reading is still allowed after a hand off");
  });

  it("still writes the brief when a human claimed the incident first", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    await db.withWrite((w) => {
      w.prepare("UPDATE incident SET owner = 'human' WHERE id = ?").run(id);
    });

    const res = await toolsFor(id).handOff({ reason: "you took it", brief: "ruled out DNS" });

    assert.equal(res.ok, true, res.error);
    assert.match(posts.at(-1)?.text ?? "", /ruled out DNS/);
  });

  it("does not hand off an incident it could not announce", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = createToolApi({
      db,
      token: mintAgentToken(SECRET, { incidentId: id, attempt: 1 }, 3600),
      tokenSecret: SECRET,
      correlator,
      slack: {
        post: async () => {
          throw new Error("slack is down");
        },
      },
      evidence,
    });

    const res = await tools.handOff({
      reason: "the fix touches auth",
      brief: "What I believe now: the session cookie is dropped on refresh.",
    });

    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /could not post/);
    assert.equal(
      incidentRow(id)?.owner,
      "agent",
      "the dispatcher skips human-owned incidents, so this would be an escalation nobody has",
    );
    assert.equal(incidentRow(id)?.status, "INVESTIGATING", "and it stays relaunchable");
  });

  it("retracts the brief in the thread when the hand-off cannot be recorded", async () => {
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

    const res = await tools.handOff({
      reason: "the fix touches auth",
      brief: "What I believe now: the session cookie is dropped on refresh.",
    });

    assert.equal(res.ok, false);
    assert.equal(incidentRow(id)?.owner, "agent", "nobody owns it but the agent");
    assert.match(posts.at(-2)?.text ?? "", /session cookie/, "the brief went out");
    assert.match(
      posts.at(-1)?.text ?? "",
      /could not be recorded/,
      "so the same thread has to say it did not stick, rather than leaving a person to infer it",
    );
  });

  it("refuses to hand off an incident that closed while the brief was posting", async () => {
    await seed("sig-a");
    const id = await openIncident(["sig-a"]);
    const tools = createToolApi({
      db,
      token: mintAgentToken(SECRET, { incidentId: id, attempt: 1 }, 3600),
      tokenSecret: SECRET,
      correlator,
      slack: {
        // The TOCTOU window is exactly this await: the status read happens
        // before the post, the write after it.
        post: async (threadTs: string | null, text: string) => {
          await db.withWrite((w) => {
            w.prepare(
              `UPDATE incident
                  SET status = 'CLOSED', resolvedAt = 1, closedAt = 1, postmortem = 'x'
                WHERE id = ?`,
            ).run(id);
          });
          return slack.post(threadTs, text);
        },
      },
      evidence,
    });

    const res = await tools.handOff({ reason: "the fix touches auth", brief: "b" });

    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /lost a race/);
    assert.equal(
      incidentRow(id)?.owner,
      "agent",
      "a closed incident is not something to put on a person's plate",
    );
    assert.match(
      posts.at(-1)?.text ?? "",
      /could not be recorded/,
      "the brief already said it was theirs, so the thread has to take that back",
    );
  });

  it("stops triage attaching new signals to what a human took", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const id = await openIncident(["sig-a"]);
    await toolsFor(id).handOff({ reason: "the fix touches auth", brief: "b" });

    await assert.rejects(
      applyAssign(
        db,
        { signalIds: ["sig-b"], target: id, reason: "looks related" },
        { kind: "boss" },
      ),
      /owned by a human/,
    );
    assert.equal(
      db.get<{ incidentId: string | null }>(
        "SELECT incidentId FROM signal WHERE id = 'sig-b'",
      )?.incidentId,
      null,
      "no agent is coming back to that incident, so nothing may pile up on it",
    );
  });

  it("still lets a person move signals into the incident they hold", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const id = await openIncident(["sig-a"]);
    await toolsFor(id).handOff({ reason: "the fix touches auth", brief: "b" });

    const res = await applyAssign(
      db,
      { signalIds: ["sig-b"], target: id, reason: "I am working both of these" },
      { kind: "human", slackUserId: "U1" },
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
