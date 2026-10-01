import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSqlRunner,
  MAX_PENDING_TOTAL,
  PENDING_TTL_MS,
  ROTATION_TTL_MS,
  TERMINAL_TTL_MS,
  type QueryExecutor,
  type QueryResult,
  type Reaction,
  type SqlRunnerSlack,
  type ThreadParent,
} from "./runner";

const CHANNEL = "C_INCIDENTS";
const BOT = "U_BOT";
const ONCALL = "U_ONCALL";
const OTHER = "U_RANDOM";
const GROUP = "S_ROTATION";
const THREAD = "1700000000.000100";
const SECRET = "jane.doe@example.com";

const threadFor = (incidentId: number) =>
  incidentId === 4 ? THREAD : `1700000000.${String(incidentId).padStart(6, "0")}`;
const header = (incidentId: number) =>
  `*Incident ${incidentId}* · checkout is failing\n*Status*: *Investigating* → Fixing → Resolved → Closed`;

const fakeSlack = () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const messages = new Map<string, { text: string; edited: boolean }>();
  const reactions = new Map<string, Reaction[]>();
  const parents = new Map<string, ThreadParent | null>();
  let rotation = [ONCALL];
  let rotationReads = 0;
  let seq = 0;
  const slack: SqlRunnerSlack = {
    post: async (...args) => {
      calls.push({ method: "post", args });
      const ts = `1700000001.${String(++seq).padStart(6, "0")}`;
      messages.set(ts, { text: args[2], edited: false });
      return { ts, text: args[2] };
    },
    update: async (...args) => {
      calls.push({ method: "update", args });
      const msg = messages.get(args[1]);
      if (msg) msg.text = args[2];
    },
    reactions: async (...args) => {
      calls.push({ method: "reactions", args });
      if (!messages.has(args[1])) return null;
      return reactions.get(args[1]) ?? [];
    },
    reply: async (...args) => {
      calls.push({ method: "reply", args });
      return messages.get(args[2]) ?? null;
    },
    rotationMembers: async (...args) => {
      calls.push({ method: "rotationMembers", args });
      rotationReads++;
      return rotation;
    },
    threadParent: async (_channel, threadTs) => parents.get(threadTs) ?? null,
  };
  return {
    slack,
    calls,
    messages,
    parents,
    react: (ts: string, name: string, users: string[]) => {
      const list = reactions.get(ts) ?? [];
      list.push({ name, users });
      reactions.set(ts, list);
    },
    setRotation: (members: string[]) => {
      rotation = members;
    },
    rotationReads: () => rotationReads,
  };
};

const setup = (opts: { result?: QueryResult | Error; rotationGroupId?: string | null } = {}) => {
  const fake = fakeSlack();
  let clock = 1_000_000;
  const executed: string[] = [];
  const execute: QueryExecutor = async (sql) => {
    executed.push(sql);
    const result = opts.result ?? { columns: ["email"], rows: [{ email: SECRET }] };
    if (result instanceof Error) throw result;
    return result;
  };
  const runner = createSqlRunner({
    slack: fake.slack,
    execute,
    channelId: CHANNEL,
    botUserId: BOT,
    rotationGroupId: opts.rotationGroupId === undefined ? GROUP : opts.rotationGroupId,
    now: () => clock,
  });
  const submit = (body: Record<string, unknown>) => {
    const incidentId = body.incidentId ?? 4;
    const threadTs =
      body.threadTs ?? (typeof incidentId === "number" ? threadFor(incidentId) : THREAD);
    if (typeof incidentId === "number" && !fake.parents.has(threadTs as string)) {
      fake.parents.set(threadTs as string, { ts: threadTs as string, user: BOT, text: header(incidentId) });
    }
    return runner.app.request("/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        incidentId,
        threadTs,
        sql: "select email from users where id = 1",
        reason: "check the user's email",
        ...body,
      }),
    });
  };
  const status = async (id: string) =>
    (await (await runner.app.request(`/requests/${id}`)).json()) as Record<string, unknown>;
  const lastPostTs = () => {
    const posts = fake.calls.filter((c) => c.method === "post");
    return [...fake.messages.keys()][posts.length - 1];
  };
  return {
    ...fake,
    runner,
    executed,
    submit,
    status,
    lastPostTs,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

const created = async (res: Response) => {
  assert.equal(res.status, 201);
  return ((await res.json()) as { requestId: string }).requestId;
};

describe("POST /requests validation", () => {
  it("refuses a semicolon anywhere, including a trailing one", async () => {
    const t = setup();
    for (const sql of ["select 1;", "select 1; delete from users"]) {
      const res = await t.submit({ sql });
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, /';'/);
    }
    assert.equal(t.calls.length, 0);
  });

  it("refuses sql and reasons over their limits, and accepts them at the limit", async () => {
    const t = setup();
    assert.equal((await t.submit({ sql: Array.from({ length: 21 }, () => "x".repeat(199)).join("\n") })).status, 400);
    assert.equal((await t.submit({ reason: "r".repeat(1001) })).status, 400);
    assert.equal((await t.submit({ sql: "", reason: "r" })).status, 400);
    assert.equal((await t.submit({ reason: " " })).status, 400);
    assert.equal((await t.submit({ incidentId: "4" })).status, 400);
    assert.equal((await t.submit({ sql: "select '```'" })).status, 400);
    assert.equal((await t.submit({ reason: "see ```select 1```" })).status, 400);
    assert.equal((await t.submit({ reason: "uses `id`" })).status, 400);
    assert.equal((await t.submit({ reason: "line one\nRan for <@U1>: 3 rows" })).status, 400);
    assert.equal(t.calls.length, 0);
    await created(
      await t.submit({ sql: [...Array.from({ length: 19 }, () => "x".repeat(199)), "x".repeat(200)].join("\n"), reason: "r".repeat(1000) }),
    );
  });

  it("refuses sql the approver could read differently from what runs", async () => {
    const t = setup();
    const refused = [
      "select id from campaign where slug = 'a\u202E' or true --'",
      "select id\u200B from campaign",
      "select 'José'",
      "select 1\r\nfrom campaign",
      Array.from({ length: 41 }, () => "select 1").join("\n"),
      `select '${"x".repeat(200)}'`,
      "select id from campaign\n\n\nunion select email from users",
      "select id from campaign\n  \n\t\nunion select email from users",
    ];
    for (const sql of refused) {
      assert.equal((await t.submit({ sql })).status, 400, JSON.stringify(sql));
    }
    assert.equal((await t.submit({ reason: "check the user\u202E email" })).status, 400);
    assert.equal(t.calls.length, 0);
    await created(
      await t.submit({ sql: Array.from({ length: 40 }, (_, i) => (i % 2 ? "" : "\tselect 1")).join("\n") }),
    );
  });

  it("answers 503 and posts nothing when no rotation group is configured", async () => {
    const t = setup({ rotationGroupId: null });
    assert.equal((await t.submit({})).status, 503);
    assert.equal(t.calls.length, 0);
  });
});

describe("the posted message", () => {
  it("carries the whole SQL, escaped, in a code block, in the incident thread", async () => {
    const t = setup();
    const sql = `select * from users where a < 5 and b > 2 and c = '&'\n${"x".repeat(190)}`;
    await created(await t.submit({ sql, reason: "<!channel> look" }));
    const [channel, thread, text] = t.calls[0].args as string[];
    assert.equal(channel, CHANNEL);
    assert.equal(thread, THREAD);
    assert.ok(text.includes("```\nselect * from users where a &lt; 5 and b &gt; 2 and c = '&amp;'\n" + "x".repeat(190) + "\n```"));
    assert.ok(text.includes("The query is 2 lines; read all of it before reacting."));
    assert.ok(text.includes("&lt;!channel&gt; look"));
    assert.ok(text.includes("Incident 4"));
    assert.ok(text.includes("React with :arrow_forward: to run it or :x: to refuse. Only the on-call rotation counts."));
  });
});

describe("decisions", () => {
  it("runs on a rotation member's approval and returns rows only through GET", async () => {
    const t = setup();
    const id = await created(await t.submit({}));
    t.react(t.lastPostTs(), "arrow_forward", [ONCALL]);
    await t.runner.tick();
    const s = await t.status(id);
    assert.equal(s.status, "done");
    assert.equal(s.decidedBy, ONCALL);
    assert.deepEqual(s.rows, [{ email: SECRET }]);
    assert.equal(s.rowCount, 1);
    const update = t.calls.find((c) => c.method === "update")!;
    assert.match(update.args[2] as string, /Ran for <@U_ONCALL>: 1 rows returned to the agent\.$/);
  });

  it("keeps an approved request pending when the re-read fails, and runs it on the next tick", async () => {
    const t = setup();
    const id = await created(await t.submit({}));
    t.react(t.lastPostTs(), "arrow_forward", [ONCALL]);
    const reply = t.slack.reply;
    t.slack.reply = async () => {
      throw new Error("ratelimited");
    };
    await t.runner.tick();
    assert.equal((await t.status(id)).status, "pending");
    assert.equal(t.executed.length, 0);
    t.slack.reply = reply;
    await t.runner.tick();
    assert.equal((await t.status(id)).status, "done");
  });

  it("lets a refusal win over an approval", async () => {
    const t = setup();
    const id = await created(await t.submit({}));
    t.react(t.lastPostTs(), "arrow_forward", [ONCALL]);
    t.react(t.lastPostTs(), "x", [ONCALL]);
    await t.runner.tick();
    assert.equal((await t.status(id)).status, "refused");
    assert.equal(t.executed.length, 0);
    assert.match(t.calls.find((c) => c.method === "update")!.args[2] as string, /Refused by <@U_ONCALL>\.$/);
  });

  it("never runs on the bot's own reaction, even if the bot is in the rotation", async () => {
    const t = setup();
    t.setRotation([ONCALL, BOT]);
    const id = await created(await t.submit({}));
    t.react(t.lastPostTs(), "arrow_forward", [BOT]);
    await t.runner.tick();
    assert.equal((await t.status(id)).status, "failed");
    assert.equal(t.executed.length, 0);
  });

  it("ignores reactions from people outside the rotation", async () => {
    const t = setup();
    const id = await created(await t.submit({}));
    t.react(t.lastPostTs(), "arrow_forward", [OTHER]);
    await t.runner.tick();
    assert.equal((await t.status(id)).status, "pending");
    assert.equal(t.executed.length, 0);
  });

  it("refuses to run when the message was edited after posting", async () => {
    const t = setup();
    const id = await created(await t.submit({}));
    const ts = t.lastPostTs();
    t.messages.get(ts)!.edited = true;
    t.react(ts, "arrow_forward", [ONCALL]);
    await t.runner.tick();
    const s = await t.status(id);
    assert.equal(s.status, "failed");
    assert.match(s.error as string, /edited/);
    assert.equal(t.executed.length, 0);
  });

  it("refuses to run when the message text no longer matches what was stored", async () => {
    const t = setup();
    const id = await created(await t.submit({}));
    const ts = t.lastPostTs();
    t.messages.get(ts)!.text = "something else";
    t.react(ts, "arrow_forward", [ONCALL]);
    await t.runner.tick();
    assert.equal((await t.status(id)).status, "failed");
    assert.equal(t.executed.length, 0);
  });

  it("caches the rotation for a minute", async () => {
    const t = setup();
    await created(await t.submit({}));
    await t.runner.tick();
    await t.runner.tick();
    assert.equal(t.rotationReads(), 1);
    t.advance(ROTATION_TTL_MS + 1);
    await t.runner.tick();
    assert.equal(t.rotationReads(), 2);
  });
});

describe("result caps", () => {
  it("fails a result of more than 200 rows", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ id: i, email: SECRET }));
    const t = setup({ result: { columns: ["id", "email"], rows } });
    const id = await created(await t.submit({}));
    t.react(t.lastPostTs(), "arrow_forward", [ONCALL]);
    await t.runner.tick();
    const s = await t.status(id);
    assert.equal(s.status, "failed");
    assert.equal(s.error, "more than 200 rows; aggregate or narrow the query");
    assert.equal(s.rows, undefined);
  });

  it("returns exactly 200 rows", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const t = setup({ result: { columns: ["id"], rows } });
    const id = await created(await t.submit({}));
    t.react(t.lastPostTs(), "arrow_forward", [ONCALL]);
    await t.runner.tick();
    assert.equal((await t.status(id)).rowCount, 200);
  });

  it("fails a result over 100,000 characters", async () => {
    const rows = [{ blob: SECRET + "x".repeat(100_000) }];
    const t = setup({ result: { columns: ["blob"], rows } });
    const id = await created(await t.submit({}));
    t.react(t.lastPostTs(), "arrow_forward", [ONCALL]);
    await t.runner.tick();
    const s = await t.status(id);
    assert.equal(s.status, "failed");
    assert.match(s.error as string, /^result is \d+ characters; select fewer columns or rows$/);
  });

  it("fails duplicate column names rather than losing one", async () => {
    const t = setup({ result: { columns: ["id", "id"], rows: [{ id: 1 }] } });
    const id = await created(await t.submit({}));
    t.react(t.lastPostTs(), "arrow_forward", [ONCALL]);
    await t.runner.tick();
    assert.equal((await t.status(id)).status, "failed");
  });

  it("gives the agent a Postgres message and Slack only its code", async () => {
    const err = Object.assign(new Error(`invalid input syntax for type integer: "${SECRET}"`), { code: "22P02" });
    const t = setup({ result: err });
    const id = await created(await t.submit({}));
    t.react(t.lastPostTs(), "arrow_forward", [ONCALL]);
    await t.runner.tick();
    const s = await t.status(id);
    assert.equal(s.status, "failed");
    assert.match(s.error as string, /invalid input syntax/);
    assert.match(t.calls.find((c) => c.method === "update")!.args[2] as string, /Failed: Postgres error 22P02/);
  });
});

describe("expiry and retention", () => {
  it("expires a request with no decision after an hour", async () => {
    const t = setup();
    const id = await created(await t.submit({}));
    t.advance(PENDING_TTL_MS - 1);
    await t.runner.tick();
    assert.equal((await t.status(id)).status, "pending");
    t.advance(2);
    await t.runner.tick();
    assert.equal((await t.status(id)).status, "expired");
    assert.match(t.calls.find((c) => c.method === "update")!.args[2] as string, /Expired with no decision\.$/);
  });

  it("drops a terminal result two hours after it finished", async () => {
    const t = setup();
    const id = await created(await t.submit({}));
    t.react(t.lastPostTs(), "x", [ONCALL]);
    await t.runner.tick();
    t.advance(TERMINAL_TTL_MS + 1);
    await t.runner.tick();
    assert.equal((await t.runner.app.request(`/requests/${id}`)).status, 404);
  });
});

describe("limits", () => {
  it("allows one pending request per incident", async () => {
    const t = setup();
    await created(await t.submit({ incidentId: 7 }));
    assert.equal((await t.submit({ incidentId: 7 })).status, 409);
  });

  it("allows five pending requests in total", async () => {
    const t = setup();
    for (let i = 1; i <= MAX_PENDING_TOTAL; i++) await created(await t.submit({ incidentId: i }));
    assert.equal((await t.submit({ incidentId: 99 })).status, 409);
  });

  it("frees the incident's slot once its request is decided", async () => {
    const t = setup();
    await created(await t.submit({ incidentId: 7 }));
    t.react(t.lastPostTs(), "x", [ONCALL]);
    await t.runner.tick();
    await created(await t.submit({ incidentId: 7 }));
  });
});

describe("rows never reach Slack", () => {
  it("keeps every result value out of every Slack call, whatever the outcome", async () => {
    const outcomes: QueryResult[] = [
      { columns: ["email"], rows: [{ email: SECRET }] },
      { columns: ["email"], rows: Array.from({ length: 201 }, () => ({ email: SECRET })) },
      { columns: ["email"], rows: [{ email: SECRET + "x".repeat(100_000) }] },
    ];
    for (const result of outcomes) {
      const t = setup({ result });
      await created(await t.submit({}));
      t.react(t.lastPostTs(), "arrow_forward", [ONCALL]);
      await t.runner.tick();
      assert.ok(t.calls.some((c) => c.method === "update"));
      assert.ok(!JSON.stringify(t.calls).includes(SECRET));
    }
  });
});

describe("the thread a request names", () => {
  const refusedWith = async (res: Response, pattern: RegExp) => {
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, pattern);
  };

  it("posts only under the top of a thread the bot started for that incident", async () => {
    const t = setup();
    t.parents.set("1700000009.000001", null);
    await refusedWith(await t.submit({ threadTs: "1700000009.000001" }), /no message/);

    t.parents.set("1700000009.000002", { ts: THREAD, user: BOT, text: header(4) });
    await refusedWith(await t.submit({ threadTs: "1700000009.000002" }), /a reply/);

    t.parents.set("1700000009.000003", { ts: "1700000009.000003", user: OTHER, text: header(4) });
    await refusedWith(await t.submit({ threadTs: "1700000009.000003" }), /not started by BugBoss/);

    t.parents.set(THREAD, { ts: THREAD, user: BOT, text: header(4) });
    await refusedWith(await t.submit({ incidentId: 812, threadTs: THREAD }), /not headed with incident 812/);
    t.parents.set("1700000009.000004", { ts: "1700000009.000004", user: BOT, text: header(41) });
    await refusedWith(await t.submit({ threadTs: "1700000009.000004" }), /not headed with incident 4/);

    assert.equal(t.calls.filter((c) => c.method === "post").length, 0);
    await created(await t.submit({}));
  });

  it("accepts a thread the Boss recovered with a rotation ping in front", async () => {
    const t = setup();
    t.parents.set(THREAD, { ts: THREAD, user: BOT, text: "<!subteam^S_ROTATION> *Incident 4 has no Slack thread*" });
    await created(await t.submit({}));
  });

  it("frees the slot and answers 502 when the thread cannot be read", async () => {
    const t = setup();
    t.slack.threadParent = async () => {
      throw new Error("ratelimited");
    };
    assert.equal((await t.submit({})).status, 502);
    t.slack.threadParent = async (_c, ts) => ({ ts, user: BOT, text: header(4) });
    await created(await t.submit({}));
  });
});

describe("a reaction from the bot itself", () => {
  it("fails the request even when a rotation member approved too", async () => {
    const t = setup();
    const id = await created(await t.submit({}));
    t.react(t.lastPostTs(), "arrow_forward", [BOT, ONCALL]);
    await t.runner.tick();
    const s = await t.status(id);
    assert.equal(s.status, "failed");
    assert.match(s.error as string, /reaction from the bot/);
    assert.deepEqual(t.executed, []);
  });

  it("fails on any bot reaction, not only the approve one", async () => {
    const t = setup();
    const id = await created(await t.submit({}));
    t.react(t.lastPostTs(), "eyes", [BOT]);
    t.react(t.lastPostTs(), "arrow_forward", [ONCALL]);
    await t.runner.tick();
    assert.equal((await t.status(id)).status, "failed");
    assert.deepEqual(t.executed, []);
  });
});
