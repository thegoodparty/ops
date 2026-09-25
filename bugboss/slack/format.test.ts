import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MAX_MESSAGE_CHARS,
  bullets,
  channelLink,
  escape,
  link,
  mrkdwn,
  postProse,
  raw,
  splitForSlack,
  toMrkdwn,
  userMention,
} from "./format";

describe("escape", () => {
  test("escapes the three characters Slack reads as markup", () => {
    assert.equal(escape("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  });

  test("escapes the ampersand first, so an entity is not double-escaped", () => {
    // Escaping `<` before `&` produces &amp;lt; and the reader sees the entity.
    assert.equal(escape("<"), "&lt;");
    assert.equal(escape("&<"), "&amp;&lt;");
  });

  test("a log line with an angle bracket keeps everything after it", () => {
    const line = 'level=error msg="parse failed near <div> at offset 12" id=7';
    const escaped = escape(line);
    assert.ok(escaped.endsWith("id=7"), escaped);
    assert.ok(!escaped.includes("<"), escaped);
  });

  test("is deliberately not idempotent: a literal &amp; survives as itself", () => {
    assert.equal(escape("&amp;"), "&amp;amp;");
  });

  test("leaves text with nothing to escape untouched", () => {
    assert.equal(escape("*bold* `code` _italic_"), "*bold* `code` _italic_");
  });
});

describe("mrkdwn", () => {
  test("the literal parts are formatting and the interpolations are data", () => {
    assert.equal(
      mrkdwn`*Incident ${"inc-1"} opened*`,
      "*Incident inc-1 opened*",
    );
  });

  test("an interpolated value cannot open a Slack entity", () => {
    assert.equal(
      mrkdwn`*${"<!channel> 500s on /a&b"}*`,
      "*&lt;!channel&gt; 500s on /a&amp;b*",
    );
  });

  test("numbers interpolate without escaping", () => {
    assert.equal(mrkdwn`${12} signals`, "12 signals");
  });

  test("raw() is the only way past escaping", () => {
    assert.equal(mrkdwn`${raw("<!here> ")}hello`, "<!here> hello");
  });

  test("an interpolation that is not a string, number or raw throws", () => {
    const missing = undefined as unknown as string;
    assert.throws(() => mrkdwn`owner: ${missing}`, /interpolation #1/);
    const nothing = null as unknown as string;
    assert.throws(() => mrkdwn`owner: ${nothing}`, /interpolation #1/);
  });

  test("a NaN count throws rather than posting the word NaN", () => {
    assert.throws(() => mrkdwn`${Number.NaN} signals`, /interpolation #1 is NaN/);
  });
});

describe("entities", () => {
  test("mentions and channel links render as entities", () => {
    assert.equal(userMention("U0HUMAN"), "<@U0HUMAN>");
    assert.equal(channelLink("C0DEVALERTS"), "<#C0DEVALERTS>");
  });

  test("an id that could break out of the entity throws", () => {
    for (const bad of ["U<script", "U|x", "U 1", "", "U>"]) {
      assert.throws(() => userMention(bad), /unusable Slack user id/, bad);
      assert.throws(() => channelLink(bad), /unusable Slack channel id/, bad);
    }
  });

  test("a link is <url> or <url|label>, with both sides escaped", () => {
    assert.equal(link("https://x.test/a"), "<https://x.test/a>");
    assert.equal(link("https://x.test/a", "the PR"), "<https://x.test/a|the PR>");
    assert.equal(
      link("https://x.test/?a=1&b=2", "a&b"),
      "<https://x.test/?a=1&amp;b=2|a&amp;b>",
    );
  });

  test("a pipe in a label becomes a slash rather than truncating the label", () => {
    assert.equal(link("https://x.test", "a|b"), "<https://x.test|a/b>");
  });

  test("a link with no url throws", () => {
    assert.throws(() => link("   "), /needs a url/);
  });

  test("only a real destination may become a link", () => {
    assert.equal(link("mailto:a@b.test"), "<mailto:a@b.test>");
    // Anything else inside <> is a directive, not a destination, and an agent
    // supplies these: prUrls comes straight off a tool call.
    for (const bad of ["!channel", "!subteam^S0ROTATION", "@U0HUMAN", "/relative"]) {
      assert.throws(() => link(bad), /not a linkable url/, bad);
    }
  });

  test("bullets are the literal character, because Slack has no list markup", () => {
    assert.equal(bullets(["one", "two"]), "• one\n• two");
  });
});

describe("toMrkdwn", () => {
  test("Markdown bold, italic and strike become their mrkdwn spellings", () => {
    assert.equal(toMrkdwn("**bold**"), "*bold*");
    assert.equal(toMrkdwn("__bold__"), "*bold*");
    assert.equal(toMrkdwn("~~gone~~"), "~gone~");
  });

  test("headings become a bold line, because Slack has none", () => {
    assert.equal(toMrkdwn("## Root cause\ntext"), "*Root cause*\ntext");
    assert.equal(toMrkdwn("###### Deep"), "*Deep*");
  });

  test("Markdown links become Slack links", () => {
    assert.equal(
      toMrkdwn("see [the PR](https://github.test/o/r/pull/1)"),
      "see <https://github.test/o/r/pull/1|the PR>",
    );
  });

  test("a url query string survives the escaping it goes through", () => {
    assert.equal(
      toMrkdwn("[q](https://g.test/?a=1&b=2)"),
      "<https://g.test/?a=1&amp;b=2|q>",
    );
  });

  test("Markdown bullets become the bullet character", () => {
    assert.equal(toMrkdwn("- one\n* two\n  + three"), "• one\n• two\n  • three");
  });

  test("a pipe table becomes a monospaced block, which is what holds columns", () => {
    assert.equal(
      toMrkdwn("| env | rate |\n|-----|------|\n| prod | 4% |"),
      "```\n| env | rate |\n| prod | 4% |\n```",
    );
  });

  test("pipes that are not a table are left alone", () => {
    assert.equal(toMrkdwn("| grep foo | wc -l"), "| grep foo | wc -l");
  });

  test("prose outside an entity is escaped", () => {
    assert.equal(
      toMrkdwn("parse failed near <div> at a & b"),
      "parse failed near &lt;div&gt; at a &amp; b",
    );
  });

  test("a quoted log line does not eat the rest of the post", () => {
    const out = toMrkdwn("saw `<Foo>` then <Bar> then done");
    assert.ok(out.endsWith("then done"), out);
    assert.ok(!out.includes("<"), out);
  });

  test("mentions and links the agent wrote are kept as entities", () => {
    assert.equal(
      toMrkdwn("<@U0HUMAN> see <https://x.test/a|here> in <#C0DEV>"),
      "<@U0HUMAN> see <https://x.test/a|here> in <#C0DEV>",
    );
  });

  test("a Markdown link cannot smuggle a broadcast past the escaping", () => {
    // `<!channel|look>` is a real page. The link rewrite is the one place that
    // builds an entity out of model-supplied text, so it checks the scheme.
    assert.equal(toMrkdwn("[look](!channel)"), "[look](!channel)");
    assert.equal(toMrkdwn("[me](@U0HUMAN)"), "[me](@U0HUMAN)");
    assert.equal(toMrkdwn("[rel](./docs.md)"), "[rel](./docs.md)");
  });

  test("an agent cannot page the rotation: broadcasts render as literal text", () => {
    for (const ping of ["<!here>", "<!channel>", "<!subteam^S0ROTATION>"]) {
      const out = toMrkdwn(`${ping} look at this`);
      assert.doesNotMatch(out, /<!here>|<!channel>|<!subteam\^/, ping);
      assert.ok(out.startsWith("&lt;!"), out);
    }
  });

  test("code is escaped but never converted", () => {
    assert.equal(
      toMrkdwn("```\n**not bold**\n<html>\n```"),
      "```\n**not bold**\n&lt;html&gt;\n```",
    );
    assert.equal(toMrkdwn("`a<b && c>d`"), "`a&lt;b &amp;&amp; c&gt;d`");
  });

  test("an unterminated fence is still treated as code", () => {
    assert.equal(toMrkdwn("```\n**x** <y>"), "```\n**x** &lt;y&gt;");
  });

  test("conversion outside a fence still runs when a fence is present", () => {
    assert.equal(
      toMrkdwn("## Cause\n```\n**raw**\n```\n**after**"),
      "*Cause*\n```\n**raw**\n```\n*after*",
    );
  });

  test("empty text stays empty", () => {
    assert.equal(toMrkdwn(""), "");
  });
});

describe("splitForSlack", () => {
  const paragraphs = (count: number): string =>
    Array.from({ length: count }, (_, i) => `line ${i} ${"x".repeat(90)}`).join("\n");

  test("a message that fits is one message with no continuation marker", () => {
    assert.deepEqual(splitForSlack("short"), ["short"]);
  });

  test("a long message becomes several, each inside the budget", () => {
    const parts = splitForSlack(paragraphs(120));
    assert.ok(parts.length > 1, `expected a split, got ${parts.length}`);
    for (const part of parts) {
      assert.ok(part.length <= MAX_MESSAGE_CHARS, `${part.length} chars`);
    }
  });

  test("every line survives the split, in order", () => {
    const original = paragraphs(120);
    const rejoined = splitForSlack(original)
      .map((part) => part.replace(/\n_\(\d+\/\d+\)_$/, ""))
      .join("\n");
    assert.equal(rejoined, original);
  });

  test("the parts say which part they are", () => {
    const parts = splitForSlack(paragraphs(120));
    parts.forEach((part, index) => {
      assert.ok(
        part.endsWith(`_(${index + 1}/${parts.length})_`),
        part.slice(-20),
      );
    });
  });

  test("a code fence open at a split is closed and reopened", () => {
    const body = ["```", paragraphs(120), "```"].join("\n");
    const parts = splitForSlack(body);
    assert.ok(parts.length > 1);
    for (const part of parts) {
      const fences = part.split("\n").filter((l) => l.trimStart().startsWith("```"));
      assert.equal(fences.length % 2, 0, `unbalanced fence in:\n${part.slice(0, 80)}`);
    }
  });

  test("a single over-long line is split at a space rather than mid-word", () => {
    const parts = splitForSlack(new Array(900).fill("word").join(" "));
    assert.ok(parts.length > 1);
    for (const part of parts) {
      assert.doesNotMatch(part.replace(/\n_\(\d+\/\d+\)_$/, ""), /wor$|^ord/);
    }
  });

  test("a split never lands inside a link, which would leave a bare <", () => {
    const url = `https://ci.test/runs/${"9".repeat(60)}`;
    const line = Array.from({ length: 60 }, (_, i) => `step ${i} <${url}|run ${i}>`).join(" ");
    for (const part of splitForSlack(line)) {
      const body = part.replace(/\n_\(\d+\/\d+\)_$/, "");
      assert.equal(
        (body.match(/</g) ?? []).length,
        (body.match(/>/g) ?? []).length,
        body.slice(-120),
      );
    }
  });

  test("a line with no spaces at all still splits rather than overflowing", () => {
    const parts = splitForSlack("z".repeat(9000));
    assert.ok(parts.length > 1);
    for (const part of parts) {
      assert.ok(part.length <= MAX_MESSAGE_CHARS, `${part.length} chars`);
    }
  });

  test("a budget too small to say anything in throws instead of looping", () => {
    assert.throws(() => splitForSlack("x".repeat(500), 10), /200 or more/);
    assert.throws(() => splitForSlack("x".repeat(500), 1.5), /200 or more/);
  });
});

describe("postProse", () => {
  const recorder = () => {
    const sent: string[] = [];
    let n = 0;
    return {
      sent,
      post: async (text: string) => {
        sent.push(text);
        n += 1;
        return { ts: `ts-${n}` };
      },
    };
  };

  test("converts on the way out and returns the first ts", async () => {
    const slack = recorder();
    const result = await postProse(slack.post, "## Cause\n**bad** <config>");
    assert.deepEqual(slack.sent, ["*Cause*\n*bad* &lt;config&gt;"]);
    assert.deepEqual(result, { ts: "ts-1" });
  });

  test("a long post becomes consecutive messages, none of them truncated", async () => {
    const slack = recorder();
    const long = Array.from({ length: 400 }, (_, i) => `- finding ${i}`).join("\n");
    const result = await postProse(slack.post, long);
    assert.ok(slack.sent.length > 1, `expected a split, got ${slack.sent.length}`);
    assert.deepEqual(result, { ts: "ts-1" });
    assert.ok(slack.sent.join("").includes("• finding 399"));
  });
});
