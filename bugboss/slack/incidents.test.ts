import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createIncidentReferences,
  renderIncidentRefs,
  withIncidentReferences,
  type IncidentLinks,
} from "./incidents";
import type { SlackBlock } from "./blocks";

const PERMALINK = "https://goodparty.slack.com/archives/C09/p1700000000000100";

/** Every incident has a thread and every link resolves. */
const everything: IncidentLinks = {
  permalink: (incidentId) => Promise.resolve(`${PERMALINK}${incidentId}`),
};

/** Nothing has a thread, which is what a fresh incident looks like. */
const nothing: IncidentLinks = { permalink: () => Promise.resolve(null) };

const render = (text: string, here: string | null = null, links = everything) =>
  renderIncidentRefs(text, here, links);

describe("capitalisation, which happens whatever else does", () => {
  test("a lower-case reference is capitalised", async () => {
    assert.equal(
      await render("see incident 4", "4"),
      "see Incident 4",
      "the thread's own incident is not linked, and is still capitalised",
    );
  });

  test("a shouted one is brought back down", async () => {
    assert.equal(await render("INCIDENT 4 again", "4"), "Incident 4 again");
  });

  test("an already-correct one is left as it is", async () => {
    assert.equal(await render("Incident 4", "4"), "Incident 4");
  });

  test("the plural is capitalised too, so there is no exception to learn", async () => {
    assert.equal(await render("incidents 4", "4"), "Incidents 4");
  });

  test("a hash is kept, because it is how a person wrote it", async () => {
    assert.equal(await render("incident #4", "4"), "Incident #4");
  });
});

describe("linking", () => {
  test("an incident that is not this thread's gets a link", async () => {
    assert.equal(
      await render("also incident 7", "4"),
      `also <${PERMALINK}7|Incident 7>`,
    );
  });

  test("the incident whose thread this is gets none", async () => {
    const answer = await render("incident 4 and incident 7", "4");
    assert.equal(answer, `Incident 4 and <${PERMALINK}7|Incident 7>`);
  });

  test("outside any thread, everything is linked", async () => {
    assert.equal(await render("incident 4", null), `<${PERMALINK}4|Incident 4>`);
  });

  test("an incident with no thread reads as plain capitalised text", async () => {
    assert.equal(await render("incident 9", null, nothing), "Incident 9");
  });

  /**
   * A link is a convenience and the text is somebody's answer. Losing the
   * link loses a convenience; letting the failure out loses the answer.
   */
  test("a permalink that throws costs the link and nothing else", async () => {
    const answer = await render("incident 9 is the one", null, {
      permalink: () => Promise.reject(new Error("ratelimited")),
    });
    assert.equal(answer, "Incident 9 is the one");
  });
});

describe("what a message full of references costs", () => {
  /**
   * `createCachingLinker` learns the workspace domain from its first real
   * answer and derives every later link from it as string work. Asked in
   * order, a board naming ten incidents is one API call; fired together it
   * is ten, because none of them has taught it anything yet.
   */
  test("links are resolved in order, not all at once", async () => {
    const inFlight: string[] = [];
    let concurrent = 0;
    const answer = await render("incident 4, incident 7 and incident 9", null, {
      permalink: async (id) => {
        inFlight.push(id);
        concurrent = Math.max(concurrent, inFlight.length);
        await Promise.resolve();
        inFlight.pop();
        return `${PERMALINK}${id}`;
      },
    });

    assert.equal(concurrent, 1);
    assert.match(answer, /Incident 4/);
    assert.match(answer, /Incident 9/);
  });

  /**
   * Ten incidents against a Slack that is refusing is ten consecutive
   * ten-second deadlines, paid by whoever is waiting on the post.
   */
  test("one refusal stops the rest of the message asking", async () => {
    let asked = 0;
    const answer = await render("incident 4, incident 7 and incident 9", null, {
      permalink: () => {
        asked++;
        return Promise.reject(new Error("ratelimited"));
      },
    });

    assert.equal(asked, 1);
    assert.equal(answer, "Incident 4, Incident 7 and Incident 9");
  });
});

describe("what the pass must not touch", () => {
  test("a quoted log line inside code is left exactly as it was", async () => {
    const text = "here: `incident 7 not found` and incident 7";
    assert.equal(
      await render(text, null),
      `here: \`incident 7 not found\` and <${PERMALINK}7|Incident 7>`,
    );
  });

  test("a fenced block is left alone", async () => {
    const text = "```\nincident 7\n```\nincident 7";
    assert.equal(
      await render(text, null),
      `\`\`\`\nincident 7\n\`\`\`\n<${PERMALINK}7|Incident 7>`,
    );
  });

  /**
   * The merge announcements write "incident 82's thread" as a link label.
   * Left out, that label would be the one place in the system still saying
   * "incident" in lower case, which is the inconsistency this removes.
   */
  test("a reference inside a link label is capitalised, never re-linked", async () => {
    const text = `see <https://example.com/x|incident 82's thread>`;
    assert.equal(
      await render(text, null),
      `see <https://example.com/x|Incident 82's thread>`,
    );
  });

  test("a url is never rewritten, however much it looks like a reference", async () => {
    const text = "<https://example.com/incident%2099|the writeup>";
    assert.equal(await render(text, null), text);
  });

  /**
   * A bare number after a conjunction is a count, a duration, a status code
   * and an hour of the day far more often than it is an incident id. A
   * reference this misses is readable prose; one it invents is a link to the
   * wrong thread that looks exactly as authoritative as a right one.
   */
  test("a bare number is never turned into a reference", async () => {
    assert.equal(
      await render("incident 4 and 5 minutes later", "4"),
      "Incident 4 and 5 minutes later",
    );
  });

  test("a word that merely starts with incident is not a reference", async () => {
    assert.equal(await render("incidental 4", null), "incidental 4");
  });

  test("text with nothing to do is returned untouched", async () => {
    const text = "the pool is saturated and nothing else";
    assert.equal(await render(text, null), text);
  });
});

// ---------------------------------------------------------------------------
// The production pass
// ---------------------------------------------------------------------------

const stubThreads = (threads: Record<string, string>) => ({
  incidentForThread: (threadTs: string) =>
    Object.entries(threads).find(([, ts]) => ts === threadTs)?.[0] ?? null,
  threadOf: (incidentId: string) => threads[incidentId] ?? null,
});

describe("createIncidentReferences", () => {
  test("resolves a thread ts to the incident standing in it", async () => {
    const refs = createIncidentReferences({
      threads: stubThreads({ "4": "400.0", "7": "700.0" }),
      permalink: (ts) => Promise.resolve(`${PERMALINK}/${ts}`),
    });

    assert.equal(
      await refs.render("incident 4 and incident 7", "400.0"),
      `Incident 4 and <${PERMALINK}/700.0|Incident 7>`,
    );
  });

  /**
   * `createCachingLinker` already collapses this to string work once it has
   * parsed the workspace out of one permalink -- but when it cannot,
   * `permalink_shape_unknown` fires and every link costs a round trip. This
   * pass asks for a link every time an answer names an incident, so without
   * a memo here that alarm would go from a quiet tenfold to a loud one.
   */
  test("asks Slack for a given incident's link once, ever", async () => {
    let asked = 0;
    const refs = createIncidentReferences({
      threads: stubThreads({ "7": "700.0" }),
      permalink: (ts) => {
        asked++;
        return Promise.resolve(`${PERMALINK}/${ts}`);
      },
    });

    await refs.render("incident 7", null);
    await refs.render("incident 7 again", null);
    await refs.render("still incident 7", "400.0");

    assert.equal(asked, 1);
  });

  /**
   * The relay posts the rest of a split opening message into the thread
   * before it records that thread on the incident, so "this thread belongs
   * to no incident" is true for a moment and false forever after. Caching
   * that moment would leave every later message in the thread linking the
   * incident to itself.
   */
  test("a thread that has no incident yet is asked about again", async () => {
    const threads: Record<string, string> = {};
    const refs = createIncidentReferences({
      threads: stubThreads(threads),
      permalink: (ts) => Promise.resolve(`${PERMALINK}/${ts}`),
    });

    assert.equal(
      await refs.render("incident 4 opened", "400.0"),
      "Incident 4 opened",
      "nothing to link to yet, and nothing to link from",
    );

    threads["4"] = "400.0";

    assert.equal(
      await refs.render("incident 4 is fixing", "400.0"),
      "Incident 4 is fixing",
      "and once the thread is recorded, it is still not linked to itself",
    );
  });

  test("an incident with no thread is asked about again once it has one", async () => {
    const threads: Record<string, string> = {};
    const refs = createIncidentReferences({
      threads: stubThreads(threads),
      permalink: (ts) => Promise.resolve(`${PERMALINK}/${ts}`),
    });

    assert.equal(await refs.render("incident 7", null), "Incident 7");
    threads["7"] = "700.0";
    assert.equal(
      await refs.render("incident 7", null),
      `<${PERMALINK}/700.0|Incident 7>`,
    );
  });
});

// ---------------------------------------------------------------------------
// The decorator
// ---------------------------------------------------------------------------

const fakeClient = () => {
  const posts: { threadTs: string | null; text: string }[] = [];
  const choices: { text: string; blocks: readonly SlackBlock[] }[] = [];
  const edits: { channel: string; ts: string; text: string }[] = [];
  return {
    posts,
    choices,
    edits,
    post: (threadTs: string | null, text: string) => {
      posts.push({ threadTs, text });
      return Promise.resolve({ ts: "ts-1" });
    },
    postChoice: (
      _threadTs: string | null,
      text: string,
      blocks: readonly SlackBlock[],
    ) => {
      choices.push({ text, blocks });
      return Promise.resolve({ ts: "ts-2" });
    },
    update: (channel: string, ts: string, text: string) => {
      edits.push({ channel, ts, text });
      return Promise.resolve();
    },
    /** Kept so the spread proves it survives: nothing else may be dropped. */
    react: () => Promise.resolve(),
  };
};

describe("withIncidentReferences", () => {
  const refs = () =>
    createIncidentReferences({
      threads: stubThreads({ "4": "400.0", "7": "700.0" }),
      permalink: (ts) => Promise.resolve(`${PERMALINK}/${ts}`),
    });

  test("every ordinary post goes through the pass", async () => {
    const inner = fakeClient();
    const slack = withIncidentReferences(inner, refs());

    await slack.post("400.0", "same cause as incident 7");

    assert.equal(
      inner.posts[0].text,
      `same cause as <${PERMALINK}/700.0|Incident 7>`,
    );
  });

  /**
   * A question with buttons is the one message BugBoss builds with Block
   * Kit, and its fallback text is what every notification shows. It is a
   * different call on the client, which is exactly how a pass that sat on
   * `post` alone would miss it.
   */
  test("a question with buttons goes through it too", async () => {
    const inner = fakeClient();
    const slack = withIncidentReferences(inner, refs());

    await slack.postChoice("400.0", "is this incident 7?", []);

    assert.equal(inner.choices[0].text, `is this <${PERMALINK}/700.0|Incident 7>?`);
  });

  test("a header rewrite resolves against its own thread", async () => {
    const inner = fakeClient();
    const slack = withIncidentReferences(inner, refs());

    await slack.update("C09", "400.0", "incident 4 · investigating");

    assert.equal(
      inner.edits[0].text,
      "Incident 4 · investigating",
      "a header does not link the incident it heads",
    );
  });

  test("everything else on the client survives the wrapping", async () => {
    const inner = fakeClient();
    const slack = withIncidentReferences(inner, refs());
    assert.equal(typeof slack.react, "function");
  });
});
