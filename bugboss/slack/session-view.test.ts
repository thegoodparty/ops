import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeRun, excerpt, lastEntryAt, renderSessionTurns, type EntryLike } from "./session-view";

const SENTINEL = "MIDDLE_OF_THE_EVIDENCE_7f3a";

let clockAt = Date.parse("2026-09-30T14:00:00Z");
const stamp = (): number => {
  clockAt += 1000;
  return clockAt;
};

// Entries the shape `Conversation.entries()` hands back: a kind, and the one
// model message that entry contributes.
const assistant = (content: object[], extra: object = {}): EntryLike => ({
  kind: "pi.assistant",
  model: [{ role: "assistant", content, stopReason: "toolUse", timestamp: stamp(), ...extra }],
});

const result = (toolCallId: string, toolName: string, text: string, isError = false): EntryLike => ({
  kind: "pi.tool-result",
  model: [{ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: stamp() }],
});

const user = (text: string): EntryLike => ({
  kind: "pi.user",
  model: [{ role: "user", content: text, timestamp: stamp() }],
});

const width = (entries: readonly EntryLike[]): number => JSON.stringify(entries).length;

/** A file with the sentinel buried in its middle, so any slice would show it. */
const bigFile = (chars: number): string => {
  const half = "export const x = 1;\n".repeat(Math.floor(chars / 40));
  return `${half}// ${SENTINEL}\n${half}`;
};

const longThinking = [
  "I need to find where the rate limit is applied.",
  "",
  `${"The CallHub client retries on 429 and the retry budget is shared. ".repeat(40)}${SENTINEL} ${"More reasoning follows here. ".repeat(40)}`,
].join("\n");

const script = [
  "set -euo pipefail",
  ...Array.from({ length: 80 }, (_, i) => `echo step ${i} && grep -rn callhub packages/gp-api/src/${i}`),
  `echo ${SENTINEL}`,
  ...Array.from({ length: 80 }, (_, i) => `echo tail ${i}`),
].join("\n");

const originals = { file: bigFile(60_000), longThinking, script };

const bigSession = (): EntryLike[] => {
  const lines = [user("You are the incident agent for incident 2.")];
  for (let i = 0; i < 3; i++) {
    lines.push(
      assistant([
        { type: "thinking", thinking: longThinking },
        { type: "toolCall", id: `read${i}`, name: "read", arguments: { path: `src/alerts${i}.ts` } },
      ]),
      result(`read${i}`, "read", originals.file),
    );
  }
  lines.push(
    assistant([
      { type: "text", text: "Running the search script." },
      { type: "toolCall", id: "bash1", name: "bash", arguments: { command: script, timeout: 60 } },
    ]),
    result("bash1", "bash", "line\n".repeat(3000)),
  );
  lines.push(
    assistant([
      { type: "toolCall", id: "gh1", name: "bash", arguments: { command: "gh pr view 2234" } },
    ]),
    result("gh1", "bash", "no pull requests found for 2234\nexit 1", true),
  );
  lines.push(
    assistant([
      { type: "text", text: "Waiting on the merge." },
      { type: "toolCall", id: "mon1", name: "monitor", arguments: { command: "gh pr view 2234 --json state", intervalSeconds: 60 } },
    ]),
  );
  return lines;
};

describe("renderSessionTurns", () => {
  test("a 200k-character session renders as a bounded turn list", () => {
    const entries = bigSession();

    // The premise: this is the prod shape, and the raw entries are huge.
    assert.ok(width(entries) >= 199_000, `entries are ${width(entries)} characters`);

    const out = renderSessionTurns(entries, 15);
    assert.equal(out.totalTurns, 6);
    assert.equal(out.shownTurns, 6);
    assert.ok(out.text.length < 10_000, `rendered ${out.text.length} characters`);
    assert.equal(out.text.includes(SENTINEL), false, "nothing from the middle of a large text");
  });

  test("every excerpt is a whole original or a whole first unit of one", () => {
    const text = renderSessionTurns(bigSession(), 15).text;
    const quoted = [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    assert.ok(quoted.length > 0);
    const units = [
      ...Object.values(originals).flatMap((o) => [o, o.split("\n")[0], o.split(/\n\s*\n/)[0]]),
      "You are the incident agent for incident 2.",
      "Running the search script.",
      "Waiting on the merge.",
      "gh pr view 2234",
      "gh pr view 2234 --json state",
      "src/alerts0.ts",
      "src/alerts1.ts",
      "src/alerts2.ts",
    ].map((u) => u.trim());
    for (const q of quoted) {
      assert.ok(units.includes(q.trim()), `excerpt is not a whole unit: ${q}`);
    }
    assert.match(text, /read\(path: "src\/alerts0\.ts"\) → read [\d,]+ characters from src\/alerts0\.ts/);
    assert.match(text, /command: a 162-line, [\d,]+-character command whose first line is "set -euo pipefail"/);
    assert.match(text, /thought: "I need to find where the rate limit is applied\." \(first of 2 paragraphs\)/);
  });

  test("turns are bounded by count, not characters", () => {
    const out = renderSessionTurns(bigSession(), 3);
    assert.equal(out.shownTurns, 3);
    assert.equal([...out.text.matchAll(/^Turn \d+/gm)].length, 3);
    assert.match(out.text, /^\(3 earlier turns not shown\)/);
    assert.match(out.text, /^Turn 4 /m);
  });

  test("a missing result and an error result say so", () => {
    const text = renderSessionTurns(bigSession(), 2).text;
    assert.match(text, /bash\(command: "gh pr view 2234"\) → error: no pull requests found for 2234 \(first of 2 lines\)/);
    assert.match(text, /monitor\(command: "gh pr view 2234 --json state", intervalSeconds: 60\) → no result recorded/);
  });

  test("redacted thinking, a compaction and a reset render as one line each", () => {
    const entries: EntryLike[] = [
      assistant([{ type: "thinking", redacted: true }]),
      { kind: "pi.compaction", model: [{ role: "user", content: "x".repeat(50_000), timestamp: stamp() }] },
      { kind: "pi.reset", model: [{ role: "user", content: "The Boss stopped your run: wrong service.", timestamp: stamp() }] },
      { kind: "pi.system", model: [{ role: "system", content: [], timestamp: stamp() }] },
    ];
    const text = renderSessionTurns(entries, 5).text;
    assert.match(text, /thought: \(redacted reasoning\)/);
    assert.match(text, /compacted into a summary/);
    assert.match(text, /reset here, starting from: "The Boss stopped your run: wrong service\."/);
    assert.ok(text.length < 500);
  });

  test("a turn the run was stopped in says so", () => {
    const text = renderSessionTurns([assistant([{ type: "text", text: "checking" }], { stopReason: "aborted" })], 5).text;
    assert.match(text, /the run was stopped during this turn/);
  });
});

describe("describeRun", () => {
  test("a run in flight, a stopped one, a failed one and a finished one read differently", () => {
    const said = assistant([{ type: "text", text: "done" }], { stopReason: "stop" });
    assert.equal(describeRun([said], true), "a run is in progress");
    assert.equal(describeRun([said], false), "idle; its last run ended with an answer");
    assert.match(describeRun([assistant([], { stopReason: "aborted" })], false), /stopped before it finished/);
    assert.match(
      describeRun([assistant([], { stopReason: "error", errorMessage: "throttled" })], false),
      /failed model call \("throttled"\)/,
    );
    assert.equal(describeRun([user("go")], false), "it has not taken a turn yet");
  });
});

describe("lastEntryAt", () => {
  test("is the newest message timestamp, or null for nothing", () => {
    const entries = [user("a"), user("b")];
    assert.equal(lastEntryAt(entries), clockAt);
    assert.equal(lastEntryAt([]), null);
  });
});

describe("excerpt", () => {
  test("describes a single unbroken block rather than slicing it", () => {
    const block = `${"a".repeat(500)}${SENTINEL}${"b".repeat(500)}`;
    assert.equal(excerpt(block, "text"), `(${(block.length).toLocaleString("en-US")} characters of text, not shown)`);
  });

  test("a short text comes back whole", () => {
    assert.equal(excerpt("  short  ", "text"), '"short"');
  });
});
