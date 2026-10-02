import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveBedrockModel } from "../bedrock/model";
import type { TimelineEvent } from "../types";
import type { BugbossHarness, ConversationId } from "./harness";
import {
  COMPACTION_KEEP_RECENT_TOKENS,
  createStageCompaction,
  reserveTokensFor,
  STAGE_FOR_TIMELINE_KIND,
  stageCompactionInstructions,
} from "./stages";

const TIMELINE: TimelineEvent[] = [
  {
    id: 1,
    kind: "first_error",
    occurredAt: Date.parse("2026-09-30T19:02:11Z"),
    recordedAt: Date.parse("2026-09-30T19:21:00Z"),
    summary: "first 502 on POST /v1/outreach",
    evidenceUrl: "https://goodparty.grafana.net/explore?left=first-502",
  },
];

// Asserts the two properties the number exists for, against the real
// catalog entry for the model this agent runs, rather than restating the
// formula -- which is how a reserve smaller than one response once passed.
test("the compaction reserve leaves room for a maximum response", async () => {
  const model = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });

  assert.ok(reserveTokensFor(model) >= model.maxTokens, "Pi would ask for output that cannot fit");
  assert.ok(reserveTokensFor(model) > COMPACTION_KEEP_RECENT_TOKENS, "a reserve under the kept tail cannot be reached");
  assert.ok(reserveTokensFor(model) < model.contextWindow / 2, "and it is headroom, not the window");
});

test("each stage prompt keeps what its next stage needs, and the timeline verbatim", () => {
  const rootCause = stageCompactionInstructions("root_cause", TIMELINE);
  assert.match(rootCause, /moved from investigating to fixing/);
  assert.match(stageCompactionInstructions("fix_opened", TIMELINE), /fix pull request for this incident has just been opened/);
  assert.match(stageCompactionInstructions("fix_merged", TIMELINE), /has just merged/);
  for (const stage of ["root_cause", "fix_opened", "fix_merged"] as const) {
    const prompt = stageCompactionInstructions(stage, TIMELINE);
    assert.match(prompt, /2026-09-30T19:02:11\.000Z first_error: first 502 on POST \/v1\/outreach/);
    assert.match(prompt, /\(https:\/\/goodparty\.grafana\.net\/explore\?left=first-502\)/);
  }
});

test("the stage prompt says what to do when nothing has been recorded", () => {
  const prompt = stageCompactionInstructions("root_cause", []);
  assert.match(prompt, /No timeline events have been recorded yet/);
  assert.match(prompt, /track_incident_timeline_event/);
});

test("only a fix PR and a merge are stage transitions among the timeline kinds", () => {
  assert.deepEqual(STAGE_FOR_TIMELINE_KIND, { fix_pr_opened: "fix_opened", fix_merged: "fix_merged" });
});

const fakeHarness = (tokens: number) => {
  const compacted: string[] = [];
  const bugboss = {
    context: {},
    conversation: async () => ({
      context: async () => ({
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [], usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 } },
        ],
      }),
      compact: async (instructions: string) => {
        compacted.push(instructions);
        return 1;
      },
    }),
  } as unknown as BugbossHarness;
  return { bugboss, compacted };
};

test("two transitions in one round compact once, for the later stage", async () => {
  const { bugboss, compacted } = fakeHarness(200_000);
  const logged: string[] = [];
  const stages = createStageCompaction({
    harness: () => bugboss,
    timeline: async () => [
      ...TIMELINE,
      { ...TIMELINE[0], id: 2, kind: "goal_verdict", summary: "root_cause met: fine" },
    ],
    log: (event) => logged.push(event),
  });
  const id = 3 as ConversationId;

  stages.request(id, "root_cause");
  stages.request(id, "fix_opened");
  await stages.flush(id);
  await stages.flush(id);

  assert.equal(compacted.length, 1, "one summary for the round, and nothing left for the next");
  assert.match(compacted[0], /fix pull request for this incident has just been opened/);
  assert.match(compacted[0], /first 502/);
  assert.doesNotMatch(compacted[0], /root_cause met/, "verdicts are bookkeeping and stay out of the summary");
  assert.ok(logged.includes("stage_compaction_coalesced"));
});

test("a transition on a small context is skipped rather than paid for", async () => {
  const { bugboss, compacted } = fakeHarness(10_000);
  const logged: string[] = [];
  const stages = createStageCompaction({ harness: () => bugboss, timeline: async () => TIMELINE, log: (e) => logged.push(e) });

  stages.request(3 as ConversationId, "root_cause");
  await stages.flush(3 as ConversationId);

  assert.deepEqual(compacted, []);
  assert.ok(logged.includes("stage_compaction_skipped"));
});

test("an unreadable timeline costs the stage its timeline, not its compaction", async () => {
  const { bugboss, compacted } = fakeHarness(200_000);
  const stages = createStageCompaction({
    harness: () => bugboss,
    timeline: async () => {
      throw new Error("db is down");
    },
    log: () => {},
  });

  stages.request(3 as ConversationId, "fix_merged");
  await stages.flush(3 as ConversationId);

  assert.equal(compacted.length, 1);
  assert.match(compacted[0], /No timeline events have been recorded yet/);
});
