import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { Db } from "../db";
import { createPrWatchReader } from "../github";
import { createToolApiRoutes } from "../http/toolapi";
import { createMemoryS3 } from "../index";
import { STATUS_FACTS_SQL, neededFromHuman, type StatusFacts } from "../slack/status";
import { mintAgentToken } from "../toolapi";
import type { Directive, ToolApi } from "../types";
import {
  createPrWatcher,
  latestDelegateVerdict,
  prRefsIn,
  recommendationIn,
  refKey,
  type PrObservation,
  type PrWatchReader,
  type ReviewNode,
} from ".";

const SECRET = "test-secret";
const PR_2231 = "https://github.com/thegoodparty/omni/pull/2231";
const MERGED_AT = "2026-09-30T23:43:35Z";

let dir: string;
let db: Db;
let clock: number;
let posts: { threadTs: string | null; text: string }[];
let reads: string[][];
let world: Map<string, PrObservation>;

const slack = {
  post: async (threadTs: string | null, text: string) => {
    posts.push({ threadTs, text });
    return { ts: String(posts.length) };
  },
  permalink: async (ts: string) => `https://goodparty.slack.com/p${ts}`,
};

const reader: PrWatchReader = {
  read: async (refs) => {
    reads.push(refs.map(refKey));
    return new Map([...world].filter(([key]) => refs.some((ref) => refKey(ref) === key)));
  },
};

const open = (over: Partial<PrObservation> = {}): PrObservation => ({
  state: "OPEN",
  url: PR_2231,
  mergedAt: null,
  closedAt: null,
  mergedBy: null,
  mergeCommit: null,
  head: "78803961785ebd70b7c6b28b74aa47f2e8a0bfb1",
  verdict: null,
  ...over,
});

const merged = (over: Partial<PrObservation> = {}): PrObservation =>
  open({
    state: "MERGED",
    mergedAt: MERGED_AT,
    closedAt: MERGED_AT,
    mergedBy: "swain",
    mergeCommit: "bc2570b613962111e07a00aef61d63e6ee21f91f",
    ...over,
  });

const watcher = () => createPrWatcher({ db, reader, slack, now: () => clock });

const seedIncident = (id: string, thread: string) =>
  db.withWrite((w) => {
    w.prepare(
      "INSERT INTO incident (id, status, slackThreadTs, firstSignalAt) VALUES (?, 'FIXING', ?, 1)",
    ).run(id, thread);
  });

/** What incident 84's agent was sitting in when the PR merged. */
const seedMergeWait = (id: string) =>
  db.withWrite((w) => {
    w.prepare(
      `INSERT INTO pending_wait (incidentId, command, waitingFor, startedAt, pings) VALUES (?, ?, ?, ?, 0)`,
    ).run(
      id,
      "cd /work/84/omni && gh pr view 2231 --json state --jq '.state' | grep -qE 'MERGED|CLOSED'",
      "someone to merge omni#2231",
      clock,
    );
  });

const factsOf = (id: string): StatusFacts =>
  db.get<StatusFacts>(`${STATUS_FACTS_SQL} WHERE i.id = ?`, [id]) as StatusFacts;

const directivesOf = (id: string): Directive[] =>
  db
    .query<{ payload: string }>("SELECT payload FROM pending_directive WHERE incidentId = ? ORDER BY id", [id])
    .map((row) => JSON.parse(row.payload) as Directive);

const tick = async (w: ReturnType<typeof watcher>) => {
  clock += 60_000;
  return w.sweep();
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-prwatch-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  db?.close();
  db = await Db.open({
    path: join(dir, `${Math.random()}.db`),
    bucket: "bugboss-test",
    key: "state/db",
    s3: createMemoryS3(),
  });
  clock = Date.parse("2026-09-30T23:36:12Z");
  posts = [];
  reads = [];
  world = new Map([["thegoodparty/omni#2231", open()]]);
});

test("incident 84: a merge posts one notice, clears the needs-a-human line and tells the agent, with no agent running", async () => {
  await seedIncident("84", "1790718001.648109");
  await seedMergeWait("84");
  const w = watcher();

  await tick(w);
  assert.equal(posts.length, 0, "an open PR is not news");
  assert.equal(neededFromHuman(factsOf("84")), "Needs a human to merge omni#2231");

  world.set("thegoodparty/omni#2231", merged());
  await tick(w);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].threadTs, "1790718001.648109");
  assert.match(posts[0].text, /omni#2231/);
  assert.match(posts[0].text, /merged\* by @swain at 23:43 UTC/);
  assert.match(posts[0].text, /bc2570b/);
  assert.equal(neededFromHuman(factsOf("84")), null, "the header no longer asks for a merge");

  const directives = directivesOf("84");
  assert.equal(directives.length, 1);
  assert.equal(directives[0].type, "boss_message");
  assert.match((directives[0] as { text: string }).text, /omni#2231 .* was merged by swain at 2026-09-30T23:43:35Z/);

  await tick(w);
  await tick(w);
  assert.equal(posts.length, 1, "a merge is said once");
  assert.equal(directivesOf("84").length, 1);
});

test("a merge wakes an agent parked on it", async () => {
  await seedIncident("90", "1.1");
  await db.withWrite((w) => {
    w.prepare(
      "INSERT INTO incident_wait (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt) VALUES ('90', ?, NULL, 1, 1)",
    ).run("someone to merge omni#2262");
  });
  world = new Map([["thegoodparty/omni#2262", open({ url: "https://github.com/thegoodparty/omni/pull/2262" })]]);
  const w = watcher();
  await tick(w);
  world.set("thegoodparty/omni#2262", merged({ url: "https://github.com/thegoodparty/omni/pull/2262" }));
  await tick(w);

  assert.equal(posts.length, 1);
  assert.equal(db.get("SELECT 1 FROM incident_wait WHERE incidentId = '90'"), undefined);
});

test("a restart does not announce the merge again", async () => {
  await seedIncident("84", "1.1");
  await seedMergeWait("84");
  await tick(watcher());
  world.set("thegoodparty/omni#2231", merged());
  const first = watcher();
  await tick(first);
  assert.equal(posts.length, 1);

  const restarted = watcher();
  await tick(restarted);
  await tick(restarted);
  assert.equal(posts.length, 1);
  assert.equal(directivesOf("84").length, 1);
});

test("a PR first seen already merged, with nobody waiting on it, is history and is not announced", async () => {
  await seedIncident("70", "1.1");
  await db.withWrite((w) => {
    w.prepare("UPDATE incident SET prUrls = ? WHERE id = '70'").run(JSON.stringify([PR_2231]));
  });
  world.set("thegoodparty/omni#2231", merged());
  await tick(watcher());
  assert.equal(posts.length, 0);
  assert.equal(directivesOf("70").length, 0);
});

test("a PR closed without merging says so", async () => {
  await seedIncident("71", "1.1");
  await db.withWrite((w) => {
    w.prepare(
      "INSERT INTO incident_timeline_event (incidentId, kind, occurredAt, recordedAt, summary, evidenceUrl) VALUES ('71', 'fix_pr_opened', 1, 1, 'opened', ?)",
    ).run(PR_2231);
  });
  const w = watcher();
  await tick(w);
  world.set("thegoodparty/omni#2231", open({ state: "CLOSED", closedAt: "2026-10-01T02:00:00Z" }));
  await tick(w);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /closed without merging\* at 02:00 UTC/);
});

test("delegate approving and then requesting changes is announced once, as the settled verdict", async () => {
  await seedIncident("72", "1.1");
  await db.withWrite((w) => {
    w.prepare("UPDATE incident SET prUrls = ? WHERE id = '72'").run(JSON.stringify([PR_2231]));
  });
  const w = watcher();
  await tick(w);

  const head = open().head;
  const approvedAt = new Date(clock + 30_000).toISOString();
  const approve = { recommendation: "approve" as const, sha: head, at: approvedAt, url: `${PR_2231}#approve` };
  world.set("thegoodparty/omni#2231", open({ verdict: approve }));
  await tick(w);
  await tick(w);
  assert.equal(posts.length, 0, "the first verdict is still settling");

  const changesAt = new Date(clock + 30_000).toISOString();
  world.set(
    "thegoodparty/omni#2231",
    open({ verdict: { recommendation: "request changes", sha: head, at: changesAt, url: `${PR_2231}#changes` } }),
  );
  for (let i = 0; i < 4; i += 1) await tick(w);
  assert.equal(posts.length, 0, "the second verdict restarted the settle");

  for (let i = 0; i < 3; i += 1) await tick(w);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /delegate: request changes\* on .* at `7880396`/);
  const directives = directivesOf("72");
  assert.equal(directives.length, 1);
  assert.match((directives[0] as { text: string }).text, /request changes/);
});

test("one GraphQL request per tick, however many PRs are watched", async () => {
  for (const [id, n] of [["1", 11], ["2", 12], ["3", 13]] as const) {
    await seedIncident(id, `${id}.1`);
    await db.withWrite((w) => {
      w.prepare("UPDATE incident SET prUrls = ? WHERE id = ?").run(
        JSON.stringify([`https://github.com/thegoodparty/omni/pull/${n}`]),
        id,
      );
    });
  }
  const w = watcher();
  await tick(w);
  assert.equal(reads.length, 1);
  assert.deepEqual([...reads[0]].sort(), ["thegoodparty/omni#11", "thegoodparty/omni#12", "thegoodparty/omni#13"]);

  await w.sweep();
  assert.equal(reads.length, 1, "a second call inside the minute does not read again");
});

test("the GraphQL reader asks for every PR in one request and reads delegate's verdict", async () => {
  const calls: { query: string }[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body) as { query: string });
    const pull = (number: number, state: string) => ({
      pullRequest: {
        url: `https://github.com/thegoodparty/omni/pull/${number}`,
        state,
        mergedAt: state === "MERGED" ? MERGED_AT : null,
        closedAt: null,
        mergedBy: state === "MERGED" ? { login: "swain" } : null,
        mergeCommit: null,
        headRefOid: "abc",
        commits: { nodes: [{ commit: { oid: "abc", committedDate: "2026-09-29T21:00:00Z" } }] },
        reviews: {
          nodes: [
            { author: { __typename: "Bot", login: "delegate-reviewer" }, state: "APPROVED", body: "**Recommendation: approve**", submittedAt: "2026-09-29T21:58:34Z", url: "r1", commit: { oid: "abc" } },
          ],
        },
        comments: { nodes: [] },
      },
    });
    return new Response(
      JSON.stringify({
        data: { pr0: pull(1, "OPEN"), pr1: pull(2, "MERGED"), pr2: null },
        errors: [{ message: "Could not resolve to a Repository", path: ["pr2"] }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const read = createPrWatchReader(async () => "token", fetchImpl);
  const seen = await read.read(prRefsIn("omni#1 thegoodparty/omni#2 nope#3"));

  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /pr0: repository\(owner: "thegoodparty", name: "omni"\) \{ pullRequest\(number: 1\)/);
  assert.equal(seen.get("thegoodparty/omni#1")?.verdict?.recommendation, "approve");
  assert.equal(seen.get("thegoodparty/omni#2")?.mergedBy, "swain");
  assert.equal(seen.has("thegoodparty/nope#3"), false);
});

// ---------------------------------------------------------------------------
// The agent's own detection
// ---------------------------------------------------------------------------

const routes = (w: ReturnType<typeof watcher>, wakes: string[]) =>
  createToolApiRoutes({
    db,
    tokenSecret: SECRET,
    toolApiFor: () => ({}) as unknown as ToolApi,
    wakeBoss: (incidentId) => {
      wakes.push(incidentId);
    },
    noteEscalated: () => {},
    prWatch: w,
    now: () => clock,
  });

/** What `closeAsk` sends when incident 84's merge wait passes. */
const agentDone = (app: ReturnType<typeof routes>, incidentId: string, waitStartedAt = clock - 600_000) =>
  app.request(`/incidents/${incidentId}/boss-inbox`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${mintAgentToken(SECRET, { incidentId, attempt: 1 }, 3600)}`,
    },
    body: JSON.stringify({
      kind: "message",
      text: "Done: someone to merge omni#2231. The thing I was waiting on a person for has happened, and I am carrying on.",
      waitDone: [
        "cd /work/84/omni && gh pr view 2231 --json state --jq '.state' | grep -qE 'MERGED|CLOSED'",
        "someone to merge omni#2231",
        `Merge ${PR_2231} -- approved, 37 checks green, I cannot merge.`,
      ].join("\n"),
      waitStartedAt,
    }),
  });

test("the agent seeing the merge first produces one notice, and the sweep after it none", async () => {
  await seedIncident("84", "1.1");
  await seedMergeWait("84");
  const w = watcher();
  const wakes: string[] = [];
  const app = routes(w, wakes);
  await tick(w);

  world.set("thegoodparty/omni#2231", merged());
  const res = await agentDone(app, "84");
  assert.equal(res.status, 200);
  assert.equal(posts.length, 1, "the route told the thread in code");
  assert.deepEqual(wakes, [], "the Boss is not handed a merge the thread was already told");
  assert.equal(directivesOf("84").length, 0, "the agent is not told what it just saw");
  const inbox = db.query<{ seenAt: number | null }>("SELECT seenAt FROM boss_inbox WHERE incidentId = '84'");
  assert.equal(inbox.length, 1, "the agent's message is kept");
  assert.notEqual(inbox[0].seenAt, null);

  await tick(w);
  await tick(w);
  assert.equal(posts.length, 1);
});

test("the sweep seeing the merge first leaves the agent's own done unsaid", async () => {
  await seedIncident("84", "1.1");
  await seedMergeWait("84");
  const w = watcher();
  const wakes: string[] = [];
  const app = routes(w, wakes);
  await tick(w);
  world.set("thegoodparty/omni#2231", merged());
  await tick(w);
  assert.equal(posts.length, 1);

  await agentDone(app, "84");
  assert.equal(posts.length, 1);
  assert.deepEqual(wakes, []);
});

test("a wait that ended on something other than a merged PR still reaches the Boss", async () => {
  await seedIncident("84", "1.1");
  await seedMergeWait("84");
  const w = watcher();
  const wakes: string[] = [];
  const app = routes(w, wakes);
  await agentDone(app, "84");
  assert.equal(posts.length, 0);
  assert.deepEqual(wakes, ["84"]);
});

test("a later wait that names a PR announced before it began still reaches the Boss", async () => {
  await seedIncident("84", "1.1");
  await seedMergeWait("84");
  const w = watcher();
  const wakes: string[] = [];
  const app = routes(w, wakes);
  await tick(w);
  world.set("thegoodparty/omni#2231", merged());
  await tick(w);
  assert.equal(posts.length, 1);

  clock += 3_600_000;
  await agentDone(app, "84", clock - 60_000);
  assert.deepEqual(wakes, ["84"], "the deploy wait's own done is news");
  assert.equal(posts.length, 1);
});

test("an agent that saw the merge itself still has its park lifted", async () => {
  await seedIncident("84", "1.1");
  await seedMergeWait("84");
  await db.withWrite((w) => {
    w.prepare(
      "INSERT INTO incident_wait (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt) VALUES ('84', 'someone to merge omni#2231', NULL, 1, 1)",
    ).run();
  });
  const w = watcher();
  const app = routes(w, []);
  await tick(w);
  world.set("thegoodparty/omni#2231", merged());
  await agentDone(app, "84");
  assert.equal(posts.length, 1);
  assert.equal(db.get("SELECT 1 FROM incident_wait WHERE incidentId = '84'"), undefined);
});

test("a GitHub read that fails during an agent's done records nothing and lets the message through", async () => {
  await seedIncident("84", "1.1");
  const failing = createPrWatcher({
    db,
    reader: { read: async () => { throw new Error("GitHub GraphQL answered 502"); } },
    slack,
    now: () => clock,
  });
  const wakes: string[] = [];
  await agentDone(routes(failing, wakes), "84");
  assert.deepEqual(wakes, ["84"]);
  assert.equal(db.get("SELECT 1 FROM pr_watch WHERE incidentId = '84'"), undefined);
});

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

test("PR references are found as URLs and owner/repo#N or repo#N, never a bare #N", () => {
  assert.deepEqual(
    prRefsIn(`someone to merge omni#2231; also ${PR_2231}/files and thegoodparty/ops#7, not PR #9`).map(refKey),
    ["thegoodparty/omni#2231", "thegoodparty/ops#7"],
  );
});

test("a recommendation is read from the body, and APPROVED means approve", () => {
  assert.equal(recommendationIn("**Recommendation: request changes**\n\nBlockers"), "request changes");
  assert.equal(recommendationIn("Recommendation: comment"), "comment");
  assert.equal(recommendationIn("Approved.", "APPROVED"), "approve");
  assert.equal(recommendationIn("looks fine", "COMMENTED"), null);
});

test("a delegate review on an older head is not the verdict", () => {
  const review = (oid: string, state: string, body: string, at: string): ReviewNode => ({
    author: { __typename: "Bot", login: "delegate-reviewer" },
    state,
    body,
    submittedAt: at,
    url: at,
    commit: { oid },
  });
  const verdict = latestDelegateVerdict({
    head: "new",
    headCommittedAt: "2026-09-30T10:00:00Z",
    reviews: [
      review("old", "APPROVED", "**Recommendation: approve**", "2026-09-30T09:00:00Z"),
      review("new", "COMMENTED", "**Recommendation: request changes**", "2026-09-30T11:00:00Z"),
      { ...review("new", "APPROVED", "**Recommendation: approve**", "2026-09-30T12:00:00Z"), author: { __typename: "User", login: "swain" } },
      { ...review("new", "APPROVED", "**Recommendation: approve**", "2026-09-30T12:01:00Z"), author: { __typename: "User", login: "delegate-reviewer" } },
      { ...review("new", "APPROVED", "**Recommendation: approve**", "2026-09-30T12:02:00Z"), author: { __typename: "Bot", login: "delegate-reviewer-evil" } },
    ],
    comments: [],
  });
  assert.equal(verdict?.recommendation, "request changes");
});
