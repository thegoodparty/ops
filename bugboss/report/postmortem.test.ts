import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PostmortemSections, TimelineEvent } from "../types";
import { mergeTimeline, parsePostmortemSections, postmortemProblem, words } from "./postmortem";
import { PRACTICE_CHANGES, SECTIONS } from "./postmortem.fixture";
import { POSTMORTEM_HEADINGS, renderPostmortem } from "./render";

const event = (id: number, iso: string, summary: string, evidenceUrl: string | null = null): TimelineEvent => ({
  id,
  kind: "other",
  occurredAt: Date.parse(iso),
  recordedAt: Date.parse(iso) + 60_000,
  summary,
  evidenceUrl,
});

const with_ = (patch: Partial<PostmortemSections>): PostmortemSections => ({ ...SECTIONS, ...patch });

describe("a post-mortem section that is missing is refused with what to write", () => {
  it("accepts the real incident's sections", () => {
    assert.equal(postmortemProblem(SECTIONS, []), null);
  });

  const cases: [string, Partial<PostmortemSections>, RegExp][] = [
    ["at a glance", { atAGlance: "  " }, /atAGlance is empty: write two or three sentences/],
    ["timeline", { timeline: [] }, /timeline is empty: add a row for each moment/],
    ["user impact", { userImpact: "" }, /userImpact is empty: say what users experienced/],
    ["root cause", { rootCause: "\n" }, /rootCause is empty: name the mechanism/],
    ["five whys", { fiveWhys: SECTIONS.fiveWhys.slice(0, 4) }, /fiveWhys has 4 entries; it takes exactly 5/],
    ["a because", { fiveWhys: SECTIONS.fiveWhys.map((s, i) => (i === 2 ? { ...s, because: "" } : s)) }, /fiveWhys\[2\] needs both a why and a because/],
    ["resolution actions", { resolutionActions: [] }, /resolutionActions needs at least one entry/],
    ["practice changes", { practiceChanges: "" }, /practiceChanges is empty: write about 200 words/],
  ];
  for (const [name, patch, reason] of cases) {
    it(`refuses an empty ${name}`, () => {
      assert.match(postmortemProblem(with_(patch), []) ?? "", reason);
    });
  }

  it("refuses a time that is not UTC, and says how to write one", () => {
    const problem = postmortemProblem(
      with_({ timeline: [{ at: "2026-10-01 02:14", event: "first error" }] }),
      [],
    );
    assert.match(problem ?? "", /timeline\[0\]\.at "2026-10-01 02:14" is not a UTC time: write it as ISO 8601 ending in Z/);
  });

  it("refuses a row with no time and nothing recorded to take one from", () => {
    assert.match(
      postmortemProblem(with_({ timeline: [{ event: "first error" }] }), []) ?? "",
      /timeline\[0\] has no time/,
    );
  });

  it("refuses a recorded event id this incident does not have, naming the ones it does", () => {
    const recorded = [event(7, "2026-10-01T02:14:30Z", "first error")];
    assert.match(
      postmortemProblem(with_({ timeline: [{ recordedEventId: 9, event: "first error" }] }), recorded) ?? "",
      /recordedEventId 9 is not one of this incident's recorded events \(ids 7\)/,
    );
  });
});

describe("practiceChanges is about 200 words, refused rather than cut", () => {
  it("the fixture is inside the range it tests", () => {
    const count = words(PRACTICE_CHANGES);
    assert.ok(count >= 100 && count <= 300, `${count} words`);
  });

  it("refuses an overlong one and says keep it to about 200 words", () => {
    const long = `${PRACTICE_CHANGES} ${PRACTICE_CHANGES}`;
    assert.match(
      postmortemProblem(with_({ practiceChanges: long }), []) ?? "",
      new RegExp(`practiceChanges is ${words(long)} words; keep it to about 200 words\\.`),
    );
  });

  it("refuses a short one and asks for the bigger picture", () => {
    assert.match(
      postmortemProblem(with_({ practiceChanges: "Add a test." }), []) ?? "",
      /practiceChanges is 3 words; think bigger/,
    );
  });

  it("renders every word of an accepted one", () => {
    assert.ok(renderPostmortem(SECTIONS, []).includes(PRACTICE_CHANGES));
  });
});

describe("the agent's timeline and the recorded one become one table", () => {
  const recorded = [
    event(1, "2026-10-01T02:14:30.229Z", "First save refused with 503", "https://grafana.example/explore"),
    event(2, "2026-10-01T03:00:00Z", "Root cause found from trace"),
    event(3, "2026-10-01T06:55:12Z", "First save on the new build shows no transaction open"),
  ];

  it("uses the recorded time for a row that names its event, and keeps the agent's words", () => {
    const merged = mergeTimeline(
      [{ recordedEventId: 2, at: "2026-10-01T03:05:00Z", event: "Cause confirmed from a trace." }],
      recorded,
    );
    const row = merged.find((r) => r.event === "Cause confirmed from a trace.");
    assert.equal(row?.at, Date.parse("2026-10-01T03:00:00Z"));
    assert.ok(!merged.some((r) => r.event === "Root cause found from trace"), "not printed twice");
  });

  it("treats a row citing the same evidence within minutes as the recorded event", () => {
    const merged = mergeTimeline(
      [{ at: "2026-10-01T02:14:00Z", event: "First refusal.", evidenceUrl: "https://grafana.example/explore" }],
      recorded,
    );
    assert.equal(merged[0].at, recorded[0].occurredAt);
    assert.equal(merged.filter((r) => r.evidenceUrl === "https://grafana.example/explore").length, 1);
  });

  it("keeps recorded events no row describes, in time order", () => {
    const merged = mergeTimeline([{ at: "2026-10-01T04:29:16Z", event: "Fix merged." }], recorded);
    assert.deepEqual(
      merged.map((r) => r.event),
      [
        "First save refused with 503",
        "Root cause found from trace",
        "Fix merged.",
        "First save on the new build shows no transaction open",
      ],
    );
  });
});

describe("the stored post-mortem", () => {
  it("has the six written sections in order, the timeline as a table", () => {
    const md = renderPostmortem(SECTIONS, []);
    const order = [
      POSTMORTEM_HEADINGS.atAGlance,
      POSTMORTEM_HEADINGS.timeline,
      POSTMORTEM_HEADINGS.userImpact,
      POSTMORTEM_HEADINGS.rootCause,
      POSTMORTEM_HEADINGS.fiveWhys,
      POSTMORTEM_HEADINGS.resolutionActions,
      POSTMORTEM_HEADINGS.practiceChanges,
    ].map((h) => md.indexOf(`## ${h}\n`));
    assert.ok(order.every((at) => at >= 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(md, /\| When \| What \| Evidence \|\n\| --- \| --- \| --- \|\n\| 2026-10-01 02:14:30 UTC \| First of 7 list saves/);
    assert.match(md, /^5\. \*\*Why did nothing catch that before production\?\*\* No test/m);
  });

  it("round-trips through the column it is stored in", () => {
    assert.deepEqual(parsePostmortemSections(JSON.stringify(SECTIONS)), SECTIONS);
    assert.equal(parsePostmortemSections("{not json"), null);
    assert.equal(parsePostmortemSections(JSON.stringify({ ...SECTIONS, fiveWhys: "five" })), null);
  });
});
