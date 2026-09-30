import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { excerpt, renderSessionTurns } from "./session-view";

const SENTINEL = "MIDDLE_OF_THE_EVIDENCE_7f3a";

let clockAt = Date.parse("2026-09-30T14:00:00Z");
const stamp = (): string => {
  clockAt += 1000;
  return new Date(clockAt).toISOString();
};

const assistant = (content: object[], extra: object = {}): string =>
  JSON.stringify({
    type: "message",
    timestamp: stamp(),
    message: { role: "assistant", content, stopReason: "toolUse", ...extra },
  });

const result = (toolCallId: string, toolName: string, text: string, isError = false): string =>
  JSON.stringify({
    type: "message",
    timestamp: stamp(),
    message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError },
  });

const user = (text: string): string =>
  JSON.stringify({ type: "message", timestamp: stamp(), message: { role: "user", content: text } });

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

const bigSession = (): string => {
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
  return lines.join("\n");
};

describe("renderSessionTurns", () => {
  test("a 200k-character session renders as a bounded turn list", () => {
    const body = bigSession();
    const lines = body.split("\n");

    // The premise: this is the prod shape, and the old tail was huge.
    assert.ok(body.length >= 199_000, `body is ${body.length} characters`);
    assert.ok(lines.slice(-60).join("\n").length > 150_000);

    const out = renderSessionTurns(body, 15);
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

  test("a torn last line does not throw and is counted", () => {
    const body = `${bigSession()}\n{"type":"message","mess`;
    const out = renderSessionTurns(body, 2);
    assert.match(out.text, /\(1 unreadable line skipped\)/);
    assert.equal(out.shownTurns, 2);
  });

  test("redacted thinking, compaction and exit records render as one line each", () => {
    const body = [
      assistant([{ type: "thinking", redacted: true }]),
      JSON.stringify({ type: "compaction", timestamp: stamp(), summary: "x".repeat(50_000) }),
      JSON.stringify({ type: "custom", customType: "bugboss_exit", timestamp: stamp(), data: { reason: "turns_exhausted", at: 1, attempt: 1 } }),
    ].join("\n");
    const text = renderSessionTurns(body, 5).text;
    assert.match(text, /thought: \(redacted reasoning\)/);
    assert.match(text, /compacted into a summary/);
    assert.match(text, /Run ended: turns_exhausted/);
    assert.ok(text.length < 500);
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
