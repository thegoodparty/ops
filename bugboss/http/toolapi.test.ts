// The two loopback routes that are not ToolApi: the outstanding-question
// marker and the non-draining directive read contact_human polls.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Db } from "../db";
import { createMemoryS3 } from "../index";
import { mintAgentToken } from "../toolapi";
import type { Directive, ToolApi } from "../types";
import { createToolApiRoutes } from "./toolapi";

const SECRET = "test-secret";
const INCIDENT = "inc-7";

let dir: string;
let db: Db;
let app: ReturnType<typeof createToolApiRoutes>;
let clock = 1_000_000;
let reached = 0;
const threadPosts: string[] = [];

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
      "INSERT INTO incident (id, status, owner, firstSignalAt) VALUES (?, 'INVESTIGATING', 'agent', ?)",
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

  const long = Array.from({ length: 400 }, (_, i) => `- ruled out ${i}`).join("\n");
  const res = await authed("/thread", {
    method: "POST",
    body: JSON.stringify({ message: long }),
  });
  assert.equal(res.status, 200);
  const parts = threadPosts.slice(before + 1);
  assert.ok(parts.length > 1, `expected a split, got ${parts.length}`);
  assert.ok(parts.join("").includes("ruled out 399"), "the tail is not dropped");

  await authed("/pending-question", { method: "DELETE" });
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
