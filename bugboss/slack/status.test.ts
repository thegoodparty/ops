import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { toMrkdwn } from "./format";
import {
  forModelToPaste,
  neededFromHuman,
  renderStatusCard,
  renderStatusHeader,
  renderStatusLine,
  type StatusCardView,
  type StatusFacts,
} from "./status";

const AT = Date.parse("2026-09-30T15:00:00Z");
const MIN = 60_000;

const facts = (over: Partial<StatusFacts> = {}): StatusFacts => ({
  incidentId: "85",
  status: "FIXING",
  summary: "CallHub rate-limit rejection dropped a paid robocall run",
  firstSignalTitle: "callhub 429 above threshold",
  mergedInto: null,
  waitingFor: null,
  liftsOnReply: null,
  waitStartedAt: null,
  waitWakeAt: null,
  questionAskedAt: null,
  questionText: null,
  monitorWaitingFor: null,
  monitorStartedAt: null,
  unreadQuestions: 0,
  ...over,
});

const view = (over: Partial<StatusCardView> = {}): StatusCardView => ({
  facts: facts(),
  usersImpacted: 1,
  prUrls: ["https://github.com/thegoodparty/omni/pull/2234"],
  now: "Its fix is approved and green, and it is waiting for somebody to merge it.",
  lastActivityAt: AT - 4 * MIN,
  spend: "96 turns, 812345 tokens on us.anthropic.claude-opus-5, estimated cost $12.40 (derived from those tokens, not an invoiced figure)",
  at: AT,
  ...over,
});

const merge = {
  waitingFor: "someone to merge thegoodparty/omni#2234",
  liftsOnReply: 1,
  waitStartedAt: AT - 12 * MIN,
};

/**
 * Snapshot-style: the whole card, byte for byte, per state. A card that
 * reads differently each time is the failure this exists to end, so a change
 * to any of these is a change to what every reader sees and has to be made
 * here on purpose.
 */
describe("the card, one per lifecycle state", () => {
  test("INVESTIGATING", () => {
    assert.equal(
      renderStatusCard(
        view({
          facts: facts({ status: "INVESTIGATING" }),
          usersImpacted: null,
          prUrls: [],
          now: "It is reading CallHub's error logs to find when the rejections started.",
        }),
      ),
      [
        "*Incident 85* · CallHub rate-limit rejection dropped a paid robocall run",
        "*Investigating* → Fixing → Resolved → Closed",
        "*Now:* It is reading CallHub's error logs to find when the rejections started.",
        "*Waiting on:* nobody",
        "*Impact:* not measured yet",
        "*PR:* none opened",
        "*Last agent activity:* 4 min ago · *Spent so far:* 96 turns, 812345 tokens on us.anthropic.claude-opus-5, estimated cost $12.40 (derived from those tokens, not an invoiced figure)",
      ].join("\n"),
    );
  });

  test("FIXING, waiting on a merge", () => {
    assert.equal(
      renderStatusCard(view({ facts: facts(merge) })),
      [
        "*Incident 85* · CallHub rate-limit rejection dropped a paid robocall run",
        "Investigating → *Fixing* → Resolved → Closed",
        "*Now:* Its fix is approved and green, and it is waiting for somebody to merge it.",
        "*Waiting on:* someone to merge thegoodparty/omni#2234 (since 12 min ago)",
        "*Impact:* 1 user affected",
        "*PR:* <https://github.com/thegoodparty/omni/pull/2234|thegoodparty/omni#2234>",
        "*Last agent activity:* 4 min ago · *Spent so far:* 96 turns, 812345 tokens on us.anthropic.claude-opus-5, estimated cost $12.40 (derived from those tokens, not an invoiced figure)",
      ].join("\n"),
    );
  });

  test("RESOLVED", () => {
    assert.equal(
      renderStatusCard(
        view({
          facts: facts({ status: "RESOLVED" }),
          now: "It is writing the post-mortem after two clean robocall runs.",
          lastActivityAt: AT - 3 * 60 * MIN,
        }),
      ),
      [
        "*Incident 85* · CallHub rate-limit rejection dropped a paid robocall run",
        "Investigating → Fixing → *Resolved* → Closed",
        "*Now:* It is writing the post-mortem after two clean robocall runs.",
        "*Waiting on:* nobody; the agent is writing the post-mortem",
        "*Impact:* 1 user affected",
        "*PR:* <https://github.com/thegoodparty/omni/pull/2234|thegoodparty/omni#2234>",
        "*Last agent activity:* 3 h ago · *Spent so far:* 96 turns, 812345 tokens on us.anthropic.claude-opus-5, estimated cost $12.40 (derived from those tokens, not an invoiced figure)",
      ].join("\n"),
    );
  });

  test("CLOSED", () => {
    assert.equal(
      renderStatusCard(
        view({
          facts: facts({ status: "CLOSED" }),
          now: "It finished the post-mortem and ended its run.",
          lastActivityAt: AT - 3 * 24 * 60 * MIN,
        }),
      ),
      [
        "*Incident 85* · CallHub rate-limit rejection dropped a paid robocall run",
        "Investigating → Fixing → Resolved → *Closed*",
        "*Now:* It finished the post-mortem and ended its run.",
        "*Waiting on:* nobody; this incident is over",
        "*Impact:* 1 user affected",
        "*PR:* <https://github.com/thegoodparty/omni/pull/2234|thegoodparty/omni#2234>",
        "*Last agent activity:* 3 days ago · *Spent so far:* 96 turns, 812345 tokens on us.anthropic.claude-opus-5, estimated cost $12.40 (derived from those tokens, not an invoiced figure)",
      ].join("\n"),
    );
  });

  test("MERGED is off the lifecycle, and says where it went", () => {
    assert.equal(
      renderStatusCard(
        view({
          facts: facts({ status: "MERGED", mergedInto: "79" }),
          now: "It stopped when this incident was merged.",
          prUrls: [],
          usersImpacted: 0,
        }),
      ),
      [
        "*Incident 85* · CallHub rate-limit rejection dropped a paid robocall run",
        "*Merged* into incident 79, which carries on from here · Investigating → Fixing → Resolved → Closed ended with it",
        "*Now:* It stopped when this incident was merged.",
        "*Waiting on:* nobody; it was merged into incident 79",
        "*Impact:* 0 users affected",
        "*PR:* none opened",
        "*Last agent activity:* 4 min ago · *Spent so far:* 96 turns, 812345 tokens on us.anthropic.claude-opus-5, estimated cost $12.40 (derived from those tokens, not an invoiced figure)",
      ].join("\n"),
    );
  });

  test("parked on a spent budget says so on the lifecycle line", () => {
    const parked = facts({
      status: "INVESTIGATING",
      waitingFor: "a person to decide what happens next; the turn budget is spent",
      liftsOnReply: 0,
      waitStartedAt: AT - 2 * 60 * MIN,
    });
    assert.equal(
      renderStatusCard(view({ facts: parked, now: "summary unavailable", prUrls: [] })),
      [
        "*Incident 85* · CallHub rate-limit rejection dropped a paid robocall run",
        "*Investigating* → Fixing → Resolved → Closed · *PARKED*: the agent's turn budget is spent, so a message will not wake it",
        "*Now:* summary unavailable",
        "*Waiting on:* a person to decide what happens next; the turn budget is spent (since 2 h ago)",
        "*Impact:* 1 user affected",
        "*PR:* none opened",
        "*Last agent activity:* 4 min ago · *Spent so far:* 96 turns, 812345 tokens on us.anthropic.claude-opus-5, estimated cost $12.40 (derived from those tokens, not an invoiced figure)",
      ].join("\n"),
    );
  });

  /**
   * The premise of "parked": a wait that a message lifts is an ordinary wait
   * on a person, and calling it parked would tell a reader nothing they say
   * can move it, which is false.
   */
  test("a wait a message lifts is not parked", () => {
    const card = renderStatusCard(view({ facts: facts(merge) }));
    assert.doesNotMatch(card, /PARKED/);
  });

  /**
   * A Boss close leaves the spent-budget wait row behind, which is exactly
   * incident 2. The premise is that the row is still there when it closes.
   */
  test("a closed or merged incident is never shown parked, whatever wait row is left", () => {
    const leftover = { waitingFor: "a person to decide", liftsOnReply: 0, waitStartedAt: AT - MIN };
    assert.match(renderStatusLine(facts({ ...leftover, status: "INVESTIGATING" })), /PARKED/, "premise");
    for (const status of ["CLOSED", "MERGED"] as const) {
      const done = facts({ ...leftover, status, mergedInto: status === "MERGED" ? "79" : null });
      assert.doesNotMatch(renderStatusCard(view({ facts: done })), /PARKED/);
      assert.doesNotMatch(renderStatusLine(done), /PARKED/);
      assert.doesNotMatch(renderStatusHeader(done, null), /Needs a human/);
    }
  });

  test("with no session, the activity and spend say so instead of inventing a number", () => {
    const card = renderStatusCard(
      view({ lastActivityAt: null, spend: null, now: "the agent has not recorded a turn yet" }),
    );
    assert.match(card, /\*Last agent activity:\* none recorded · \*Spent so far:\* nothing recorded/);
  });
});

describe("waiting on", () => {
  test("an unanswered agent question, with its age and its words", () => {
    const card = renderStatusCard(
      view({
        facts: facts({
          questionAskedAt: AT - 9 * MIN,
          questionText: "Was the 14:02 deploy a rollback?",
        }),
      }),
    );
    assert.match(
      card,
      /\*Waiting on:\* an answer to the agent's question \(asked 9 min ago\): "Was the 14:02 deploy a rollback\?"/,
    );
  });

  test("a monitor wait shows what the agent said it waits for", () => {
    const card = renderStatusCard(
      view({
        facts: facts({
          monitorWaitingFor: "someone to merge omni#2189 or #2195",
          monitorStartedAt: AT - 30 * MIN,
        }),
      }),
    );
    assert.match(card, /\*Waiting on:\* someone to merge omni#2189 or #2195 \(since 30 min ago\)/);
  });

  test("a monitor wait recorded before it had a label says a check is running", () => {
    const one = facts({ monitorWaitingFor: null, monitorStartedAt: AT - 30 * MIN });
    assert.match(renderStatusCard(view({ facts: one })), /\*Waiting on:\* a check the agent is running \(since 30 min ago\)/);
    assert.match(renderStatusLine(one), /waiting on a check the agent is running$/);
  });

  /**
   * The prod line this replaced ran two clauses into each other, because the
   * spent-budget wait and the agent's open question were both parts of one
   * list. A parked incident is waiting on a person to pick it up, and that is
   * the whole of it.
   */
  test("a parked incident is one sentence, whatever else is outstanding", () => {
    const parked = facts({
      status: "INVESTIGATING",
      waitingFor: "a person, after the 200-turn budget for this incident ran out",
      liftsOnReply: 0,
      waitStartedAt: AT - 2 * 60 * MIN,
      questionAskedAt: AT - 3 * 60 * MIN,
      questionText: "Should I revert #2189?",
      monitorWaitingFor: null,
      monitorStartedAt: AT - 3 * 60 * MIN,
    });
    assert.equal(
      renderStatusLine(parked),
      "• *Incident 85* · INVESTIGATING, PARKED · CallHub rate-limit rejection dropped a paid robocall run · waiting on a person to decide what happens next; the turn budget is spent",
    );
    assert.match(
      renderStatusCard(view({ facts: parked })),
      /\*Waiting on:\* a person to decide what happens next; the turn budget is spent \(since 2 h ago\)\n/,
    );
  });

  test("questions nobody has read yet are the Boss's to read", () => {
    assert.match(renderStatusLine(facts({ unreadQuestions: 2 })), /waiting on the Boss to read 2 questions from the agent/);
  });
});

describe("the one-line form", () => {
  test("is the same facts as the card, on one line", () => {
    const one = facts(merge);
    assert.equal(
      renderStatusLine(one),
      "• *Incident 85* · FIXING · CallHub rate-limit rejection dropped a paid robocall run · waiting on someone to merge thegoodparty/omni#2234",
    );
    assert.equal(
      renderStatusLine(facts({ ...merge, liftsOnReply: 0 })),
      "• *Incident 85* · FIXING, PARKED · CallHub rate-limit rejection dropped a paid robocall run · waiting on a person to decide what happens next; the turn budget is spent",
    );
  });

  /**
   * A header is rewritten whenever its text changes, so an age in it would
   * rewrite every thread's header every minute against a Tier 3 budget.
   */
  test("carries no clock, so a header does not change while nothing happens", () => {
    const waiting = facts({ ...merge, questionAskedAt: AT - MIN, questionText: "q?" });
    for (const text of [renderStatusLine(waiting), renderStatusHeader(waiting, null)]) {
      assert.doesNotMatch(text, /ago/);
    }
  });

  test("the card and the line agree on where it is and what it waits on", () => {
    const one = facts(merge);
    const card = renderStatusCard(view({ facts: one }));
    const line = renderStatusLine(one);
    assert.ok(card.includes("*Fixing*") && line.includes("· FIXING ·"));
    assert.ok(card.includes("someone to merge thegoodparty/omni#2234") && line.includes("someone to merge thegoodparty/omni#2234"));
  });
});

describe("pasting", () => {
  /**
   * The Boss pastes the card and its answer goes through `toMrkdwn`, which
   * escapes. Handing it already-escaped text would post `&amp;lt;`, so what
   * the model gets is unescaped, and one pass at the boundary gives back
   * exactly the card code rendered.
   */
  test("what the model pastes posts as the card code rendered", () => {
    const card = renderStatusCard(
      view({ facts: facts({ summary: "reads of <redis> & friends failing" }) }),
    );
    assert.match(card, /&lt;redis&gt; &amp; friends/, "premise: the rendered card is escaped");
    assert.equal(toMrkdwn(forModelToPaste(card)), card);
  });
});

describe("what the header asks of a person", () => {
  test("nothing waiting on a person is no line at all, not \"nobody\"", () => {
    assert.equal(neededFromHuman(facts()), null);
    assert.doesNotMatch(renderStatusHeader(facts(), null), /Needs a human|nobody/);
  });

  test("a park only a person lifts asks for them; a timed cooldown does not", () => {
    const park = { waitingFor: "someone to flip the flag in Amplitude", liftsOnReply: 1, waitStartedAt: AT };
    assert.equal(neededFromHuman(facts(park)), "Needs a human to flip the flag in Amplitude");
    assert.equal(neededFromHuman(facts({ ...park, waitWakeAt: AT + 60 * MIN })), null);
  });

  test("the agent's question needs a person once the Boss has read it and not answered", () => {
    const asked = { questionAskedAt: AT, questionText: "Which org is this?" };
    assert.equal(neededFromHuman(facts({ ...asked, unreadQuestions: 1 })), null, "still with the Boss");
    assert.equal(neededFromHuman(facts(asked)), "Needs a human to answer the agent's question");
  });

  test("a label that names nobody to act follows a colon rather than being bent into a verb", () => {
    assert.equal(
      neededFromHuman(facts({ monitorWaitingFor: "the fix PR to be reviewed and merged", monitorStartedAt: AT })),
      "Needs a human: the fix PR to be reviewed and merged",
    );
  });

  test("a spent budget with a wake time of its own needs nobody", () => {
    const parked = { waitingFor: "a person to decide", liftsOnReply: 0, waitStartedAt: AT };
    assert.equal(neededFromHuman(facts(parked)), "Needs a human to decide what happens next", "premise");
    assert.equal(neededFromHuman(facts({ ...parked, waitWakeAt: AT + 60 * MIN })), null);
  });

  test("a closed incident needs nobody, whatever wait row is left", () => {
    assert.equal(neededFromHuman(facts({ status: "CLOSED", monitorWaitingFor: "someone to merge", monitorStartedAt: AT })), null);
  });
});
