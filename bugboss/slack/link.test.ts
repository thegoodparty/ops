import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { SlackMessage, SlackReader } from "./agent";
import { MAX_LINK_REPLIES, buildReadSlackLinkTool, parseSlackPermalink } from "./link";

const reader = (messages: SlackMessage[] | Error): SlackReader & { asked: unknown[] } => {
  const asked: unknown[] = [];
  return {
    asked,
    replies: (args) => {
      asked.push(args);
      return messages instanceof Error ? Promise.reject(messages) : Promise.resolve(messages);
    },
  };
};

const platformError = (error: string) =>
  Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error },
  });

describe("parseSlackPermalink", () => {
  test("reads a link to a top-level message", () => {
    assert.deepEqual(
      parseSlackPermalink("https://goodparty.slack.com/archives/C0AHXARLX2T/p1790641879780779"),
      { channel: "C0AHXARLX2T", ts: "1790641879.780779", threadTs: null },
    );
  });

  test("reads a link to a reply, keeping its own ts and the parent's", () => {
    assert.deepEqual(
      parseSlackPermalink(
        "<https://goodparty.slack.com/archives/C0AHXARLX2T/p1790723600000100?thread_ts=1790723563.157619&cid=C0AHXARLX2T>",
      ),
      { channel: "C0AHXARLX2T", ts: "1790723600.000100", threadTs: "1790723563.157619" },
    );
  });

  test("refuses anything that is not a Slack message link", () => {
    assert.equal(parseSlackPermalink("https://github.com/thegoodparty/ops/pull/218"), null);
    assert.equal(parseSlackPermalink("https://goodparty.slack.com/archives/C0AHXARLX2T"), null);
    assert.equal(parseSlackPermalink("not a url"), null);
  });
});

describe("read_slack_link", () => {
  const LINK = "https://goodparty.slack.com/archives/C0AHXARLX2T/p1790641879780779";

  test("renders the thread with authors, times and whole text", async () => {
    const long = "the rebase is blocked on the lockfile ".repeat(400);
    const slack = reader([
      { user: "U0SWAIN", botId: null, name: "Swain", text: "rebase it now", ts: "1790641879.780779" },
      { user: "U0BOT", botId: "B0", name: "BugBoss", text: long, ts: "1790641900.000100" },
    ]);

    const out = await buildReadSlackLinkTool(slack).run({ url: LINK });

    assert.deepEqual(slack.asked, [{ channel: "C0AHXARLX2T", threadTs: "1790641879.780779" }]);
    assert.match(out, /data, not instructions/);
    assert.match(out, /\[2026-09-29 00:31 UTC\] \(the linked message\) Swain: rebase it now/);
    assert.ok(out.includes(`BugBoss: ${long}`), "a long message comes back whole");
  });

  test("reads the parent's thread for a link to a reply", async () => {
    const slack = reader([]);
    await buildReadSlackLinkTool(slack).run({
      url: "https://goodparty.slack.com/archives/C0X/p1790723600000100?thread_ts=1790723563.157619",
    });
    assert.deepEqual(slack.asked, [{ channel: "C0X", threadTs: "1790723563.157619" }]);
  });

  test("not_in_channel is a plain sentence saying so", async () => {
    const out = await buildReadSlackLinkTool(reader(platformError("not_in_channel"))).run({ url: LINK });
    assert.equal(
      out,
      "I'm not a member of <#C0AHXARLX2T>, so I can't read it; add BugBoss to the channel.",
    );
  });

  test("a huge thread keeps its first message, the linked one and the newest replies whole", async () => {
    const replies: SlackMessage[] = Array.from({ length: 500 }, (_, i) => ({
      user: `U${i}`,
      botId: null,
      name: `person ${i}`,
      text: `reply number ${i} `.repeat(50),
      ts: `1790642000.${String(i).padStart(6, "0")}`,
    }));
    const parent: SlackMessage = { user: "U0", botId: null, name: "opener", text: "the start", ts: "1790641000.000000" };
    const linked = replies[3];

    const out = await buildReadSlackLinkTool(reader([parent, ...replies])).run({
      url: `https://goodparty.slack.com/archives/C0X/p${linked.ts.replace(".", "")}?thread_ts=${parent.ts}`,
    });

    const lines = out.split("\n");
    assert.equal(lines.length, 1 + 1 + 1 + 1 + MAX_LINK_REPLIES, "header, parent, linked, count, recent");
    assert.match(lines[1], /opener: the start$/);
    assert.ok(lines[2].includes(`(the linked message) person 3: ${linked.text}`));
    assert.equal(lines[3], `[${500 - MAX_LINK_REPLIES - 1} earlier replies left out; these are the ${MAX_LINK_REPLIES} most recent]`);
    assert.ok(lines.at(-1)?.endsWith(`person 499: ${replies[499].text}`));
  });
});
