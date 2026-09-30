import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ALL_CLEAR,
  OPEN_STATUSES,
  renderBoard,
  renderBoardLine,
  renderHeader,
  type BoardRow,
} from "./board";

const row = (over: Partial<BoardRow> = {}): BoardRow => ({
  incidentId: "4",
  status: "FIXING",
  summary: "Loki reads are being rejected",
  firstSignalTitle: "memory above 90% on bugboss-prod",
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

describe("the three fields", () => {
  test("the summary is what the incident is, not the alert that opened it", () => {
    assert.match(renderBoardLine(row()), /Loki reads are being rejected/);
    assert.doesNotMatch(renderBoardLine(row()), /memory above 90%/);
  });

  /**
   * The case this whole field exists for, in reverse: until an agent has
   * written a title, the first alert is still the best thing we have and
   * dropping to nothing would make the board unreadable on a fresh incident.
   */
  test("with no summary it falls back to the first signal's title", () => {
    assert.match(
      renderBoardLine(row({ summary: null })),
      /memory above 90% on bugboss-prod/,
    );
  });

  test("with neither, it says so rather than leaving a gap", () => {
    assert.match(
      renderBoardLine(row({ summary: null, firstSignalTitle: null })),
      /no title recorded/,
    );
  });

  /**
   * "What is running and needs nothing from you" is what makes "what needs
   * you" worth trusting, which is why it is said out loud rather than left
   * to the absence of a line.
   */
  test("an incident nobody is waiting on says so", () => {
    assert.match(renderBoardLine(row()), /waiting on nobody/);
  });

  test("a waiting incident shows what is being waited on, verbatim", () => {
    assert.match(
      renderBoardLine(row({ waitingFor: "the fix PR to be reviewed and merged" })),
      /the fix PR to be reviewed and merged/,
    );
  });

  test("RESOLVED reads as what is left, not as a word that contradicts the board", () => {
    const header = renderBoardLine(row({ status: "RESOLVED" }));
    assert.match(header, /writing the post-mortem/);
  });
});

describe("one set of facts, two shapes", () => {
  test("the header and the board line agree on the title and on the person needed", () => {
    const one = row({ monitorWaitingFor: "someone to merge omni#2240", monitorStartedAt: 1 });
    const header = renderHeader(one, null);
    const line = renderBoardLine(one);
    for (const text of [header, line]) {
      assert.match(text, /Incident 4/);
      assert.match(text, /Loki reads are being rejected/);
      assert.match(text, /merge omni#2240/);
    }
    assert.doesNotMatch(header, /FIXING/, "the header carries no status");
  });

  test("a board line is one line, whatever is in it", () => {
    const line = renderBoardLine(row({ waitingFor: "somebody\nto look" }));
    assert.equal(line.split("\n").length, 1);
  });
});

describe("the board", () => {
  test("leads with how many are open, which is the first thing anyone asks", () => {
    const board = renderBoard("Open incidents", [row(), row({ incidentId: "7" })]);
    assert.match(board.split("\n")[0], /2 open/);
  });

  test("one line per incident and nothing else", () => {
    const board = renderBoard("Open incidents", [row(), row({ incidentId: "7" })]);
    assert.equal(board.split("\n").length, 3);
  });

  /**
   * Nothing here resolves a link. Every line names its incident in prose and
   * the outbound pass in `incidents.ts` links it, which is also what stops a
   * thread's own header linking to itself.
   */
  test("it names incidents in prose, never as an assembled url", () => {
    const board = renderBoard("Open incidents", [row()]);
    assert.doesNotMatch(board, /https:/);
    assert.match(board, /Incident 4/);
  });

  test("the all-clear says the board is empty, not that an incident closed", () => {
    assert.match(ALL_CLEAR, /board is clear/);
  });
});

describe("what counts as open", () => {
  /**
   * The same list the dispatcher keeps an agent on and the relay calls
   * AGENT_RUNNING_STATUSES. A fourth definition of "open" is how a board and
   * a dispatcher come to disagree about whether anything is happening.
   */
  test("open is the three statuses an agent is still driving", () => {
    assert.deepEqual([...OPEN_STATUSES], ["INVESTIGATING", "FIXING", "RESOLVED"]);
  });
});

describe("escaping", () => {
  test("a summary out of a model cannot eat the line", () => {
    const line = renderBoardLine(row({ summary: "reads of <redis> failing" }));
    assert.match(line, /&lt;redis&gt;/);
    assert.ok(line.endsWith("waiting on nobody"), line);
  });
});
