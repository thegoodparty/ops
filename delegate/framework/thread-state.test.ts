import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseHeader,
  emitHeader,
  findLatestState,
  isPhase,
  isStatus,
} from "./thread-state";

describe("parseHeader", () => {
  it("parses a minimal valid header", () => {
    const result = parseHeader("[phase=epic,status=draft,clickup=86abc]");
    assert.deepEqual(result, {
      phase: "epic",
      status: "draft",
      clickup: "86abc",
    });
  });

  it("parses a header with optional runbooks field", () => {
    const result = parseHeader(
      "[phase=tech-design,status=blessed,clickup=p123,runbooks=abc1234]",
    );
    assert.deepEqual(result, {
      phase: "tech-design",
      status: "blessed",
      clickup: "p123",
      runbooks: "abc1234",
    });
  });

  it("ignores trailing body content after the bracketed header", () => {
    const result = parseHeader(
      "[phase=task-execution,status=draft,clickup=t1]\n\nbody text here",
    );
    assert.equal(result?.phase, "task-execution");
  });

  it("trims surrounding whitespace before matching", () => {
    const result = parseHeader(
      "   [phase=epic,status=draft,clickup=x]   ",
    );
    assert.equal(result?.phase, "epic");
  });

  it("returns null when phase is unknown", () => {
    assert.equal(
      parseHeader("[phase=foo,status=draft,clickup=x]"),
      null,
    );
  });

  it("returns null when status is unknown", () => {
    assert.equal(
      parseHeader("[phase=epic,status=approved,clickup=x]"),
      null,
    );
  });

  it("returns null when required fields are missing", () => {
    assert.equal(parseHeader("[phase=epic,status=draft]"), null);
    assert.equal(parseHeader("[phase=epic,clickup=x]"), null);
    assert.equal(parseHeader("[status=draft,clickup=x]"), null);
  });

  it("returns null for non-header strings", () => {
    assert.equal(parseHeader("just a normal message"), null);
    assert.equal(parseHeader(""), null);
    assert.equal(parseHeader("[FYI] something happened"), null);
  });

  it("does not return undefined fields as keys", () => {
    const result = parseHeader("[phase=epic,status=draft,clickup=x]");
    assert.equal(result?.runbooks, undefined);
    assert.equal("runbooks" in (result ?? {}), false);
  });
});

describe("emitHeader", () => {
  it("emits a minimal header without runbooks", () => {
    const out = emitHeader({
      phase: "epic",
      status: "draft",
      clickup: "86abc",
    });
    assert.equal(out, "[phase=epic,status=draft,clickup=86abc]");
  });

  it("emits a header with runbooks when present", () => {
    const out = emitHeader({
      phase: "tech-design",
      status: "blessed",
      clickup: "p1",
      runbooks: "abc1234",
    });
    assert.equal(
      out,
      "[phase=tech-design,status=blessed,clickup=p1,runbooks=abc1234]",
    );
  });

  it("round-trips through parseHeader", () => {
    const state = {
      phase: "task-execution" as const,
      status: "draft" as const,
      clickup: "t-99",
    };
    assert.deepEqual(parseHeader(emitHeader(state)), state);
  });
});

describe("findLatestState", () => {
  const botMsg = (text: string) => ({ text, bot_id: "B123" });
  const userMsg = (text: string) => ({ text, bot_id: undefined });

  it("returns null for an empty thread", () => {
    assert.equal(findLatestState([]), null);
  });

  it("returns null when no bot messages have a header", () => {
    assert.equal(
      findLatestState([
        userMsg("@delegate hi"),
        botMsg("Hello, how can I help?"),
      ]),
      null,
    );
  });

  it("ignores user messages even if they look like a header", () => {
    const result = findLatestState([
      userMsg("[phase=epic,status=draft,clickup=fake]"),
    ]);
    assert.equal(result, null);
  });

  it("returns the most recent bot header", () => {
    const result = findLatestState([
      botMsg("[phase=tech-design,status=draft,clickup=p1]\n\nfirst draft"),
      botMsg("[phase=tech-design,status=draft,clickup=p1]\n\niterated"),
      botMsg("[phase=tech-design,status=blessed,clickup=p1]\n\nblessed"),
    ]);
    assert.equal(result?.status, "blessed");
  });

  it("walks backward past bot messages without headers", () => {
    const result = findLatestState([
      botMsg("[phase=epic,status=draft,clickup=e1]"),
      botMsg("Working on it..."),
      botMsg("Still working..."),
    ]);
    assert.equal(result?.phase, "epic");
  });

  it("skips messages with no text", () => {
    const result = findLatestState([
      botMsg("[phase=epic,status=draft,clickup=e1]"),
      { bot_id: "B123" },
    ]);
    assert.equal(result?.phase, "epic");
  });

  it("matches header on the first non-empty line", () => {
    const result = findLatestState([
      botMsg("\n\n[phase=epic,status=blessed,clickup=e9]\n\nbody"),
    ]);
    assert.equal(result?.clickup, "e9");
  });
});

describe("isPhase / isStatus", () => {
  it("isPhase accepts known values", () => {
    assert.equal(isPhase("tech-design"), true);
    assert.equal(isPhase("epic"), true);
    assert.equal(isPhase("epic-edit"), true);
    assert.equal(isPhase("task-execution"), true);
  });

  it("isPhase rejects unknown values", () => {
    assert.equal(isPhase("foo"), false);
    assert.equal(isPhase(""), false);
    assert.equal(isPhase(undefined), false);
    assert.equal(isPhase(123), false);
  });

  it("isStatus accepts known values", () => {
    assert.equal(isStatus("draft"), true);
    assert.equal(isStatus("blessed"), true);
    assert.equal(isStatus("abandoned"), true);
  });

  it("isStatus rejects unknown values", () => {
    assert.equal(isStatus("approved"), false);
    assert.equal(isStatus(""), false);
    assert.equal(isStatus(null), false);
  });
});
