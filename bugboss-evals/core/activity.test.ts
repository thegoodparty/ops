import assert from "node:assert/strict";
import { test } from "node:test";

import { ActivitySchema, relative, renderTimeline, type Activity } from "./activity";

const T0 = Date.UTC(2026, 0, 1, 12);
const MIN = 60_000;

const activity: Activity = {
  alertAt: T0,
  events: [
    { at: T0, kind: "alert_fired", refire: false },
    { at: T0 + 2 * MIN, kind: "slack_post", ts: "1.1", threadTs: null, text: "Incident 12: user search 500s\nInvestigating." },
    { at: T0 + 9 * MIN, kind: "slack_human", ts: "1.2", threadTs: "1.1", text: "It works now in the admin console, you can resolve it." },
    { at: T0 + 10 * MIN, kind: "slack_post", ts: "1.3", threadTs: "1.1", text: "Was that search on prod or dev? The prod logs still show the 500." },
    { at: T0 + 40 * MIN, kind: "pr_opened", number: 7, title: "Tolerate malformed zips on read", files: ["packages/gp-api/src/users/users.schema.ts"] },
    { at: T0 + 44 * MIN, kind: "ci_run", number: 7, conclusion: "success" },
    { at: T0 + 45 * MIN, kind: "review", number: 7, state: "COMMENTED", body: "Approved.\n\nRecommendation: approve" },
    { at: T0 + 46 * MIN, kind: "merge_refused", number: 7, reason: "head is behind the base" },
    { at: T0 + 50 * MIN, kind: "pr_head_pushed", number: 7, files: ["packages/gp-api/src/users/users.schema.ts"] },
    { at: T0 + 55 * MIN, kind: "merged", number: 7 },
    { at: T0 + 56 * MIN, kind: "check_result", passed: true },
    { at: T0 + 70 * MIN, kind: "slack_update", ts: "1.1", text: "Incident 12: user search 500s\nResolved." },
    { at: T0 + 71 * MIN, kind: "slack_file", ts: "1.4", name: "postmortem.md", text: "# Postmortem\n\n## What broke\n\nStored zips." },
    { at: T0 + 3 * 60 * MIN + 2 * MIN + 7_000, kind: "closed" },
    { at: T0 + 30 * MIN, kind: "alert_fired", refire: true },
  ],
};

test("relative offsets read as minutes under an hour and hours past it", () => {
  assert.equal(relative(T0, T0), "+00:00");
  assert.equal(relative(T0 + 9 * MIN + 5_000, T0), "+09:05");
  assert.equal(relative(T0 + 3 * 60 * MIN + 2 * MIN + 7_000, T0), "+3:02:07");
  assert.equal(relative(T0 - 90_000, T0), "-01:30");
});

test("the timeline is in time order with every message rendered whole", () => {
  const text = renderTimeline(activity, (s) => s);
  const order = ["Alert fired", "the incident thread", "Human replied", "Alert fired again", "opened", "CI on", "Review on", "refused", "updated", "merged and deployed", "fault is gone", "edited", "uploaded a file", "Incident closed"];
  let last = -1;
  for (const marker of order) {
    const at = text.indexOf(marker);
    assert.ok(at > last, `${marker} comes after the previous entry`);
    last = at;
  }
  assert.match(text, /\*\*\+00:00\*\* Alert fired/);
  assert.match(text, /\*\*\+30:00\*\* Alert fired again/);
  assert.match(text, /\*\*\+3:02:07\*\* Incident closed/);
  assert.match(text, /> Incident 12: user search 500s\n> Investigating\./);
  assert.match(text, /> Was that search on prod or dev\? The prod logs still show the 500\./);
  assert.match(text, /> # Postmortem\n>\n> ## What broke\n>\n> Stored zips\./);
  assert.match(text, /Files: packages\/gp-api\/src\/users\/users\.schema\.ts/);
  assert.match(text, /Deployed fix verified: the fault is gone/);
});

test("nothing is cut: a message far longer than any cap reaches the output whole", () => {
  const text = "x".repeat(250_000) + "\nlast line";
  const rendered = renderTimeline(
    { alertAt: T0, events: [{ at: T0, kind: "slack_post", ts: "1", threadTs: null, text }] },
    (s) => s,
  );
  assert.ok(rendered.includes("x".repeat(250_000)));
  assert.match(rendered, /> last line/);
});

test("the rendering never names a runtime, an agent, a tool or a turn", () => {
  const text = renderTimeline(activity, (s) => s).toLowerCase();
  for (const word of ["bugboss", "agent", "tool", "turn", "transcript", "session"]) {
    assert.ok(!text.includes(word), `timeline mentions ${word}`);
  }
});

test("blinding is applied to headers and bodies alike", () => {
  const text = renderTimeline(activity, (s) => s.replace(/zip/gi, "<z>").replace(/#7/g, "#<n>"));
  assert.match(text, /Tolerate malformed <z>s on read/);
  assert.match(text, /Pull request #<n> opened/);
  assert.match(text, /> Stored <z>s\./);
  assert.ok(!text.includes("#7 "));
});

test("the failed check renders as still present", () => {
  const text = renderTimeline({ alertAt: T0, events: [{ at: T0, kind: "check_result", passed: false }] }, (s) => s);
  assert.match(text, /the fault is still present/);
});

test("activity.json round-trips through the schema and rejects an unknown event", () => {
  const parsed = ActivitySchema.parse(JSON.parse(JSON.stringify(activity)));
  assert.deepEqual(parsed, activity);
  assert.throws(() => ActivitySchema.parse({ alertAt: T0, events: [{ at: T0, kind: "tool_call", name: "bash" }] }));
  assert.throws(() => ActivitySchema.parse({ alertAt: T0, events: [{ at: T0, kind: "closed", extra: 1 }] }));
});
