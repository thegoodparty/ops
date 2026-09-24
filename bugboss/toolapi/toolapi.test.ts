import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import type { Evidence, IncidentView, ToolApi } from "../types";
import { applyAssign } from "./assign";
import { createToolApi, type CorrelationMerge } from "./index";
import { mintAgentToken } from "./token";

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
    token: mintAgentToken(SECRET, { incidentId, attempt: 1 }),
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
    fixingAt: number | null;
    resolvedAt: number | null;
    closedAt: number | null;
    recurrenceOf: string | null;
    mergedInto: string | null;
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
      token: mintAgentToken("a-different-secret", { incidentId: id, attempt: 1 }),
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
      token: mintAgentToken(SECRET, { incidentId: id, attempt: 1 }),
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
