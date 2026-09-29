// The loopback routes that are not ToolApi: the outstanding-question marker,
// the wait marker monitor keeps while it is blocked on a person, and the
// non-draining directive read contact_human polls.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Db } from "../db";
import { createMemoryS3 } from "../index";
import { mintAgentToken } from "../toolapi";
import { THREAD_PROSE_CHARS } from "../slack/format";
import type { Directive, ToolApi } from "../types";
import {
  CHOICE_ACTION_PREFIX,
  CHOICE_BLOCK_ID,
  MAX_CHOICE_OPTIONS,
  type SlackBlock,
} from "../slack/blocks";
import { createToolApiRoutes } from "./toolapi";

const SECRET = "test-secret";
const INCIDENT = "inc-7";

let dir: string;
let db: Db;
let app: ReturnType<typeof createToolApiRoutes>;
let clock = 1_000_000;
let reached = 0;
const threadPosts: string[] = [];
const choicePosts: { text: string; blocks: readonly SlackBlock[] }[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-http-"));
  db = await Db.open({
    path: join(dir, "test.db"),
    bucket: "bugboss-test",
    key: "db/test.db",
    s3: createMemoryS3(),
  });
  await db.withWrite((w) => {
    w.prepare(
      "INSERT INTO incident (id, status, firstSignalAt) VALUES (?, 'INVESTIGATING', ?)",
    ).run(INCIDENT, clock);
  });

  app = createToolApiRoutes({
    db,
    tokenSecret: SECRET,
    toolApiFor: () => {
      reached += 1;
      return {
        reportRootCause: async (args: unknown) => ({ ok: true, data: args, directives: [] }),
      } as unknown as ToolApi;
    },
    slack: {
      post: async (_threadTs: string | null, text: string) => {
        threadPosts.push(text);
        return { ts: "ts-1" };
      },
      postChoice: async (
        _threadTs: string | null,
        text: string,
        blocks: readonly SlackBlock[],
      ) => {
        threadPosts.push(text);
        choicePosts.push({ text, blocks });
        return { ts: `ts-choice-${choicePosts.length}` };
      },
    },
    now: () => clock,
  });
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

const authed = (path: string, init: RequestInit = {}) =>
  app.request(`/incidents/${INCIDENT}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${mintAgentToken(SECRET, { incidentId: INCIDENT, attempt: 1 }, 3600)}`,
      ...(init.headers ?? {}),
    },
  });

const ask = (message: string) =>
  authed("/pending-question", { method: "POST", body: JSON.stringify({ message }) });

test("a replayed question keeps its watermark, a different one gets a new one", async () => {
  clock = 1_000_000;
  const first = (await (await ask("Can someone merge the PR?")).json()) as {
    message: string;
    askedAt: number;
  };
  assert.equal(first.askedAt, 1_000_000);

  clock = 2_000_000;
  const replayed = (await (await ask("Can someone merge the PR?")).json()) as {
    askedAt: number;
  };
  assert.equal(replayed.askedAt, 1_000_000, "a replay resumes the original wait");

  // A SIGKILL mid-wait leaves the marker behind. The next, different question
  // has to replace it, or it is never posted and the agent waits out its whole
  // timeout on an answer to something nobody was asked.
  clock = 3_000_000;
  const different = (await (await ask("Should I roll back the deploy?")).json()) as {
    message: string;
    askedAt: number;
  };
  assert.equal(different.message, "Should I roll back the deploy?");
  assert.equal(different.askedAt, 3_000_000);
  assert.equal(
    db.get<{ messageTs: string }>(
      "SELECT messageTs FROM pending_question WHERE incidentId = ?",
      [INCIDENT],
    )?.messageTs,
    "",
    "the new question has no posted message yet",
  );

  await authed("/pending-question", { method: "DELETE" });
});

test("the poll reads pending directives without draining them", async () => {
  await db.withWrite((w) => {
    for (const payload of [
      { type: "resumed_after", seconds: 420 },
      { type: "merged", into: "inc-9" },
    ]) {
      w.prepare(
        "INSERT INTO pending_directive (incidentId, payload, createdAt) VALUES (?, ?, ?)",
      ).run(INCIDENT, JSON.stringify(payload), clock);
    }
  });

  const read = async () =>
    (await (await authed("/directives")).json()) as {
      id: number;
      directive: Directive;
    }[];

  const first = await read();
  assert.deepEqual(
    first.map((entry) => entry.directive),
    [
      { type: "resumed_after", seconds: 420 },
      { type: "merged", into: "inc-9" },
    ],
  );
  assert.deepEqual(
    (await read()).map((entry) => entry.directive),
    [
      { type: "resumed_after", seconds: 420 },
      { type: "merged", into: "inc-9" },
    ],
    "a second poll sees the same directives; the drain belongs to get_incident",
  );
  assert.equal(
    db.query("SELECT id FROM pending_directive WHERE incidentId = ?", [INCIDENT]).length,
    2,
  );

  // The wait consumes only the one directive it answered.
  const gone = await authed(`/directives/${first[1].id}`, { method: "DELETE" });
  assert.equal(gone.status, 204);
  assert.deepEqual(
    (await read()).map((entry) => entry.directive),
    [{ type: "resumed_after", seconds: 420 }],
  );
});

test("a directive cannot be consumed out of another incident's queue", async () => {
  const [remaining] = db.query<{ id: number }>(
    "SELECT id FROM pending_directive WHERE incidentId = ?",
    [INCIDENT],
  );

  const crossed = await app.request(`/incidents/inc-other/directives/${remaining.id}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${mintAgentToken(SECRET, { incidentId: INCIDENT, attempt: 1 }, 3600)}`,
    },
  });
  assert.equal(crossed.status, 403);
  assert.equal(
    db.query("SELECT id FROM pending_directive WHERE incidentId = ?", [INCIDENT]).length,
    1,
  );

  const garbage = await authed("/directives/not-a-number", { method: "DELETE" });
  assert.equal(garbage.status, 400);
});

test("the directive read is scoped by the token like every other route", async () => {
  const anonymous = await app.request(`/incidents/${INCIDENT}/directives`);
  assert.equal(anonymous.status, 401);

  const crossed = await app.request("/incidents/inc-other/directives", {
    headers: {
      authorization: `Bearer ${mintAgentToken(SECRET, { incidentId: INCIDENT, attempt: 1 }, 3600)}`,
    },
  });
  assert.equal(crossed.status, 403);
});

test("what the agent writes is converted for Slack and never truncated", async () => {
  const before = threadPosts.length;
  await authed("/thread", {
    method: "POST",
    body: JSON.stringify({
      message: "## Found it\n- **the cache**, log says `near <Set-Cookie>`",
    }),
  });
  const posted = threadPosts[before];
  assert.ok(posted.includes("*Found it*"), posted);
  assert.ok(posted.includes("• *the cache*"), posted);
  assert.ok(posted.includes("`near &lt;Set-Cookie&gt;`"), posted);

  // Inside the thread budget, but escaping multiplies it past what one
  // message holds. Still a split and still the whole tail: the budget is
  // about what a person will read, and conversion happening to need two
  // messages is not the model writing too much.
  const expands = Array.from(
    { length: 34 },
    (_, i) => `- ruled out ${i} ${"&".repeat(18)}`,
  ).join("\n");
  assert.ok(expands.length <= THREAD_PROSE_CHARS, "the premise: inside the budget");
  const res = await authed("/thread", {
    method: "POST",
    body: JSON.stringify({ message: expands }),
  });
  assert.equal(res.status, 200);
  const parts = threadPosts.slice(before + 1);
  assert.ok(parts.length > 1, `expected a split, got ${parts.length}`);
  assert.ok(parts.join("").includes("ruled out 33"), "the tail is not dropped");

  await authed("/pending-question", { method: "DELETE" });
});

test("a post past the thread budget is refused, not split into two long ones", async () => {
  // Every post to a thread arrives through here -- the ask, the evidence
  // under it, the rerun notice, the wait heartbeat -- so this is where the
  // budget is a budget rather than a rule one of four callers follows.
  const before = threadPosts.length;
  const long = Array.from({ length: 400 }, (_, i) => `- ruled out ${i}`).join("\n");
  const res = await authed("/thread", {
    method: "POST",
    body: JSON.stringify({ message: long }),
  });

  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /message is \d+ characters/);
  assert.match(body.error, new RegExp(String(THREAD_PROSE_CHARS)));
  // A refusal nobody can act on is a dead end, so it says where the long
  // version goes instead of only that this one is too long.
  assert.match(body.error, /post-mortem/);
  assert.equal(
    threadPosts.length,
    before,
    "refused before posting, so there is no half-delivered write-up",
  );
});

test("a harness-composed post is split, because there is nobody to refuse it to", async () => {
  // The other half of the same rule. The budget is a refusal, and a refusal
  // only means anything where somebody can rewrite the text -- a wait nudge
  // and a re-run notice are composed after the model has stopped, so
  // refusing one drops it. That is what used to force a 400-character cut
  // through the middle of the check's output.
  const before = threadPosts.length;
  const long = Array.from({ length: 400 }, (_, i) => `- ruled out ${i}`).join("\n");

  const res = await authed("/thread", {
    method: "POST",
    body: JSON.stringify({
      message: long,
      sealsPendingQuestion: false,
      harnessComposed: true,
    }),
  });

  assert.equal(res.status, 200);
  const posted = threadPosts.slice(before).join("\n");
  assert.ok(threadPosts.length > before + 1, "it went out as more than one post");
  // Whole, across the parts. Nothing is missing and nothing says it is.
  assert.ok(posted.includes("ruled out 0"));
  assert.ok(posted.includes("ruled out 399"));
  assert.doesNotMatch(posted, /truncat|elided/);
});

test("a model post cannot buy the harness exemption by asking for it", async () => {
  // This side of the socket does not trust the child. The flag is set by
  // `postNotice`, which is the harness's own client method; nothing the
  // model calls reaches it. This is the check that would notice if that
  // ever stopped being true from the wire's point of view.
  const before = threadPosts.length;
  const long = Array.from({ length: 400 }, (_, i) => `- ruled out ${i}`).join("\n");

  const res = await authed("/thread", {
    method: "POST",
    body: JSON.stringify({ message: long, harnessComposed: "yes" }),
  });

  assert.equal(res.status, 400, "anything but a literal true is not the exemption");
  assert.equal(threadPosts.length, before);
});

test("the marker says whether the question was actually posted", async () => {
  clock = 4_000_000;
  await (await ask("Is the rollback safe?")).json();

  const recorded = (await (await authed("/pending-question")).json()) as {
    messageTs: string;
  };
  assert.equal(recorded.messageTs, "", "recorded, not yet posted");

  await authed("/thread", {
    method: "POST",
    body: JSON.stringify({ message: "Is the rollback safe?" }),
  });
  const posted = (await (await authed("/pending-question")).json()) as {
    messageTs: string;
  };
  assert.equal(posted.messageTs, "ts-1");

  await authed("/pending-question", { method: "DELETE" });
});

test("a question with options posts buttons, and the marker points at them", async () => {
  clock = 4_100_000;
  await (await ask("Roll back, or wait for the next deploy?")).json();

  const before = choicePosts.length;
  const res = await authed("/thread", {
    method: "POST",
    body: JSON.stringify({
      message: "Roll back, or wait for the next deploy?",
      options: ["Roll back", "Wait for the next deploy"],
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(choicePosts.length, before + 1, "one message, with blocks");

  const posted = choicePosts.at(-1)!;
  const actions = posted.blocks.find((block) => block.type === "actions");
  assert.ok(actions && actions.type === "actions");
  assert.deepEqual(
    actions.elements.map((element) => element.value),
    ["Roll back", "Wait for the next deploy"],
  );
  assert.ok(actions.elements.every((e) => e.action_id.startsWith(CHOICE_ACTION_PREFIX)));
  assert.equal(actions.block_id, CHOICE_BLOCK_ID);
  assert.ok(posted.text.includes("1. Roll back"), "the fallback is answerable as text");

  // A press comes back quoting the message the buttons are on, and the marker
  // is what the relay matches it against.
  const marker = (await (await authed("/pending-question")).json()) as {
    messageTs: string;
  };
  assert.equal(marker.messageTs, `ts-choice-${choicePosts.length}`);

  await authed("/pending-question", { method: "DELETE" });
});

test("a question with no options still posts as plain prose", async () => {
  const before = choicePosts.length;
  await authed("/thread", {
    method: "POST",
    body: JSON.stringify({ message: "What changed in the last hour?" }),
  });
  assert.equal(choicePosts.length, before, "no blocks where none were asked for");
  assert.equal(threadPosts.at(-1), "What changed in the last hour?");
});

test("the boundary refuses options the tool would have caught, and posts nothing", async () => {
  const before = threadPosts.length;
  const tooMany = Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => `o${i}`);

  const many = await authed("/thread", {
    method: "POST",
    body: JSON.stringify({ message: "Pick one", options: tooMany }),
  });
  assert.equal(many.status, 400);

  const wrongType = await authed("/thread", {
    method: "POST",
    body: JSON.stringify({ message: "Pick one", options: [1, 2] }),
  });
  assert.equal(wrongType.status, 400);
  assert.match(
    ((await wrongType.json()) as { error: string }).error,
    /array of strings/,
  );

  assert.equal(threadPosts.length, before, "a refused question is never posted");
});

test("model arguments are validated before they reach a tool", async () => {
  const before = reached;
  const res = await authed("/root-cause", { method: "POST", body: "{}" });

  assert.equal(res.status, 200, "the model reads this as a correctable tool result");
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /cause/);
  assert.match(body.error, /explainedSignalIds/);
  assert.equal(reached, before, "an invalid call never reaches the tool API");
});

test("unknown keys are stripped rather than passed through", async () => {
  const res = await authed("/root-cause", {
    method: "POST",
    body: JSON.stringify({
      cause: "bad column",
      explainedSignalIds: ["s1"],
      incidentId: "inc-other",
    }),
  });

  const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
  assert.equal(body.ok, true);
  assert.deepEqual(body.data, { cause: "bad column", explainedSignalIds: ["s1"] });
});

const startWait = (command: string) =>
  authed("/pending-wait", { method: "POST", body: JSON.stringify({ command }) });

type WaitRow = {
  command: string;
  startedAt: number;
  pings: number;
  lastPingAt: number | null;
};

test("a replayed wait keeps its clock and its nudge count", async () => {
  clock = 1_000_000;
  const first = (await (await startWait("gh pr view 2150")).json()) as WaitRow;
  assert.deepEqual(first, {
    command: "gh pr view 2150",
    startedAt: 1_000_000,
    pings: 0,
    lastPingAt: null,
  });

  clock = 4_600_000;
  const pinged = (await (
    await authed("/pending-wait/ping", { method: "POST" })
  ).json()) as WaitRow;
  assert.equal(pinged.pings, 1);
  assert.equal(pinged.lastPingAt, 4_600_000);

  // The restart. Without this the elapsed clock would start over and the
  // nudge count would be lost, so the resumed agent would nudge again.
  clock = 5_000_000;
  const replayed = (await (await startWait("gh pr view 2150")).json()) as WaitRow;
  assert.equal(replayed.startedAt, 1_000_000);
  assert.equal(replayed.pings, 1);
  assert.equal(replayed.lastPingAt, 4_600_000);

  // clearWait does not run when the child is SIGKILLed mid-wait, so a marker
  // outlives its wait. A different command is a different wait and inherits
  // neither the clock nor the count.
  clock = 6_000_000;
  const next = (await (await startWait("gh run list --commit abc")).json()) as WaitRow;
  assert.deepEqual(next, {
    command: "gh run list --commit abc",
    startedAt: 6_000_000,
    pings: 0,
    lastPingAt: null,
  });

  await authed("/pending-wait", { method: "DELETE" });
  assert.equal(
    db.get<WaitRow>("SELECT command FROM pending_wait WHERE incidentId = ?", [
      INCIDENT,
    ]),
    undefined,
  );
});

test("counting a nudge against no wait is an error, not a new wait", async () => {
  const res = await authed("/pending-wait/ping", { method: "POST" });
  assert.equal(res.status, 404);
  assert.equal(
    db.get<WaitRow>("SELECT command FROM pending_wait WHERE incidentId = ?", [
      INCIDENT,
    ]),
    undefined,
    "a missing marker is not invented at the moment of the fault",
  );
});

test("a harness notice does not seal a question whose post never landed", async () => {
  clock = 7_000_000;
  await ask("Can someone merge the PR?");
  assert.equal(
    db.get<{ messageTs: string }>(
      "SELECT messageTs FROM pending_question WHERE incidentId = ?",
      [INCIDENT],
    )?.messageTs,
    "",
  );

  await authed("/thread", {
    method: "POST",
    body: JSON.stringify({
      message: "Still waiting on someone: the PR to be merged",
      sealsPendingQuestion: false,
    }),
  });
  assert.equal(
    db.get<{ messageTs: string }>(
      "SELECT messageTs FROM pending_question WHERE incidentId = ?",
      [INCIDENT],
    )?.messageTs,
    "",
    "the nudge is not the question, so it does not make the question look sent",
  );

  // The ask itself still does.
  await authed("/thread", {
    method: "POST",
    body: JSON.stringify({ message: "Can someone merge the PR?" }),
  });
  assert.equal(
    db.get<{ messageTs: string }>(
      "SELECT messageTs FROM pending_question WHERE incidentId = ?",
      [INCIDENT],
    )?.messageTs,
    "ts-1",
  );

  await authed("/pending-question", { method: "DELETE" });
});
