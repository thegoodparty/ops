import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import { createSlackAgentModel } from "../index";
import { emptyModelUsage, type SizedModelClient } from "../model";
import { SlackAgent, type ObjectStore, type SlackMessage } from "./agent";
import { SlackRelay } from "./relay";
import { answerTags, sweepUnansweredTags, TAG_ANSWER_SECONDS } from "./tags";

const BOT = "U0BUGBOSS";
const CHANNEL = "C0INCIDENTS";
const OTHER = "C0GENERAL";
const THREAD = "1790869000.000100";
const MINUTE = 60_000;

const noS3 = (): S3Client =>
  ({
    send: async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) {
        const err = new Error("cold start");
        err.name = "NoSuchKey";
        throw err;
      }
      return {};
    },
  }) as unknown as S3Client;

const memoryStore = (): ObjectStore => {
  const objects = new Map<string, string>();
  return {
    get: (key) => Promise.resolve(objects.get(key) ?? null),
    put: (key, body) => {
      objects.set(key, body);
      return Promise.resolve();
    },
    list: (prefix) => Promise.resolve([...objects.keys()].filter((k) => k.startsWith(prefix))),
  };
};

interface Alarm {
  event: string;
  level: string;
  channel: string;
  thread: string;
  ts: string;
}

const tagAlarms = async (fn: () => Promise<unknown>): Promise<Alarm[]> => {
  const found: Alarm[] = [];
  const log = console.log;
  const error = console.error;
  const take = (line: unknown) => {
    try {
      const parsed = JSON.parse(String(line)) as Alarm;
      if (parsed.event === "tag_unanswered") found.push(parsed);
    } catch {
      return;
    }
  };
  console.log = take;
  console.error = take;
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return found;
};

let dir: string;
let db: Db;
let relay: SlackRelay;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-tags-"));
  db = await Db.open({ path: join(dir, "tags.db"), bucket: "bugboss-test", key: "state/db", s3: noS3() });
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.withWrite((d) => {
    d.prepare("DELETE FROM boss_tag").run();
    d.prepare("DELETE FROM boss_message_seen").run();
    d.prepare("DELETE FROM thread_reply").run();
    d.prepare("DELETE FROM incident").run();
    d.prepare(
      `INSERT INTO incident (id, status, firstSignalAt, slackThreadTs, summary, prUrls)
       VALUES ('100', 'INVESTIGATING', 1, ?, 'Checkout latency', '[]')`,
    ).run(THREAD);
  });
  relay = new SlackRelay({
    db,
    slack: { post: () => Promise.resolve({ ts: "1790869999.000001" }) },
    config: { channelId: CHANNEL, botUserId: BOT, rotationGroupId: null },
    isBossThread: () => false,
  });
});

const answeringBoss = () => {
  const posts: string[] = [];
  const model: SizedModelClient = {
    contextWindow: 1_000_000,
    complete: () => Promise.resolve({ text: "Incident 100's agent is investigating.", toolCalls: [], usage: emptyModelUsage() }),
  };
  const store = memoryStore();
  const replies: SlackMessage[] = [];
  const agent = new SlackAgent({
    openIncident: () => Promise.reject(new Error("no report expected")),
    gh: null,
    db,
    store,
    slack: {
      post: (_threadTs: string | null, text: string) => {
        posts.push(text);
        return Promise.resolve({ ts: `1790869500.${String(posts.length).padStart(6, "0")}` });
      },
      replies: () => Promise.resolve(replies),
      permalink: (ts: string, channel = CHANNEL) =>
        Promise.resolve(`https://goodparty.slack.com/archives/${channel}/p${ts.replaceAll(".", "")}`),
    },
    model: createSlackAgentModel(model, store),
    summaryModel: model,
    config: { botUserId: BOT, alertChannel: "C0ALERTS", rotationGroupId: null, incidentChannel: CHANNEL },
    closeIncident: () => Promise.reject(new Error("no close expected")),
  });
  return { agent, posts, replies };
};

describe("tag_unanswered", () => {
  test("a tag the Boss answered never alarms, in an incident thread or outside one", async () => {
    const { agent, posts, replies } = answeringBoss();
    const inThread = await relay.handle({
      type: "app_mention",
      channel: CHANNEL,
      user: "U0SWAIN",
      text: `<@${BOT}> what's the status here?`,
      ts: "1790869358.078479",
      thread_ts: THREAD,
    });
    assert.equal(inThread.kind, "incident_reply");
    if (inThread.kind !== "incident_reply") return;
    replies.push({ user: "U0SWAIN", botId: null, text: inThread.text, ts: inThread.ts });
    const outside = await relay.handle({
      type: "app_mention",
      channel: OTHER,
      user: "U0SWAIN",
      text: `<@${BOT}> is checkout down?`,
      ts: "1790869400.000100",
    });
    assert.equal(outside.kind, "slack_agent");
    if (outside.kind !== "slack_agent") return;

    const alarms = await tagAlarms(async () => {
      await agent.handleIncident({
        incidentId: "100",
        trigger: { kind: "human", user: inThread.user, text: inThread.text, ts: inThread.ts, tagged: true },
      });
      await agent.handle(outside);
      await sweepUnansweredTags(db, Date.now() + 10 * MINUTE);
      await sweepUnansweredTags(db, Date.now() + 20 * MINUTE);
    });

    assert.equal(posts.length, 2);
    assert.deepEqual(alarms, []);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM boss_tag WHERE answeredAt IS NOT NULL")?.n, 2);
  });

  test("a tag nobody answered alarms once, after five minutes, with channel, thread and ts", async () => {
    await relay.handle({
      type: "app_mention",
      channel: CHANNEL,
      user: "U0SWAIN",
      text: `<@${BOT}|BugBoss> what's the status here?`,
      ts: "1790869358.078479",
      thread_ts: THREAD,
    });
    const recordedAt = Date.now();

    const early = await tagAlarms(() => sweepUnansweredTags(db, recordedAt + (TAG_ANSWER_SECONDS - 60) * 1000));
    const due = await tagAlarms(() => sweepUnansweredTags(db, recordedAt + (TAG_ANSWER_SECONDS + 60) * 1000));
    const later = await tagAlarms(async () => {
      await sweepUnansweredTags(db, recordedAt + 10 * MINUTE);
      await sweepUnansweredTags(db, recordedAt + 60 * MINUTE);
    });

    assert.deepEqual(early, []);
    assert.equal(due.length, 1);
    assert.deepEqual(
      { level: due[0].level, channel: due[0].channel, thread: due[0].thread, ts: due[0].ts },
      { level: "error", channel: CHANNEL, thread: THREAD, ts: "1790869358.078479" },
    );
    assert.deepEqual(later, [], "once per message, not once per sweep");
  });

  test("a duplicate delivery of one tag is one tag", async () => {
    const event = {
      type: "app_mention",
      channel: OTHER,
      user: "U0SWAIN",
      text: `<@${BOT}> anyone?`,
      ts: "1790869400.000100",
    };
    await relay.handle(event);
    await relay.handle(event);
    const alarms = await tagAlarms(() => sweepUnansweredTags(db, Date.now() + 10 * MINUTE));
    assert.equal(alarms.length, 1);
  });

  test("an untagged reply in an incident thread owes no answer", async () => {
    await relay.handle({
      type: "message",
      channel: CHANNEL,
      user: "U0SWAIN",
      text: "I think it's the deploy from this morning",
      ts: "1790869360.000100",
      thread_ts: THREAD,
    });
    const alarms = await tagAlarms(() => sweepUnansweredTags(db, Date.now() + 10 * MINUTE));
    assert.deepEqual(alarms, []);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM boss_tag")?.n, 0);
  });

  test("an answer marks only the messages its run read", async () => {
    for (const ts of ["1790869358.000001", "1790869358.000002"]) {
      await relay.handle({ type: "app_mention", channel: CHANNEL, user: "U0SWAIN", text: `<@${BOT}> ?`, ts, thread_ts: THREAD });
    }
    await answerTags(db, CHANNEL, ["1790869358.000001"], Date.now());
    const alarms = await tagAlarms(() => sweepUnansweredTags(db, Date.now() + 10 * MINUTE));
    assert.deepEqual(alarms.map((a) => a.ts), ["1790869358.000002"]);
  });
});
