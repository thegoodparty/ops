import assert from "node:assert/strict";
import { test } from "node:test";

import { cutAtPrOpen, flagValue, rewriteGitHubHost, viewFromResult } from "./checkpoint";

// A small synthetic Pi session in the shape BugBoss writes. No production data.
const entry = (id: string, parentId: string | null, body: Record<string, unknown>) =>
  JSON.stringify({ id, parentId, timestamp: "2026-09-29T00:00:00.000Z", ...body });

const assistant = (id: string, calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>, at: number) =>
  entry(id, null, {
    type: "message",
    message: {
      role: "assistant",
      timestamp: at,
      content: calls.map((call) => ({ type: "toolCall", ...call })),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    },
  });

const result = (id: string, toolCallId: string, toolName: string, text: string) =>
  entry(id, null, {
    type: "message",
    message: { role: "toolResult", toolCallId, toolName, isError: false, content: [{ type: "text", text }] },
  });

const VIEW = { incident: { id: "7", status: "FIXING", rootCause: "a cause" }, signals: [{ id: "s1" }] };

const SESSION = [
  JSON.stringify({ type: "session", version: 3, id: "7", timestamp: "2026-09-29T00:00:00.000Z", cwd: "/work/7/omni" }),
  entry("p", null, { type: "custom", customType: "bugboss_prompt", data: { systemPrompt: "S", toolNames: [], modelId: "m" } }),
  entry("u", null, { type: "message", message: { role: "user", content: "go" } }),
  assistant("a1", [{ id: "c1", name: "get_incident", arguments: {} }], 1000),
  result("r1", "c1", "get_incident", `ok\n\n${JSON.stringify(VIEW, null, 2)}\n\nDIRECTIVES\nRESUMED after 3s.`),
  assistant("a2", [{ id: "c2", name: "report_root_cause", arguments: { cause: "Pool exhaustion." } }], 2000),
  result("r2", "c2", "report_root_cause", "ok"),
  assistant("a3", [{ id: "c3", name: "bash", arguments: { command: "git checkout -b fix/pool && git push -u origin fix/pool" } }], 3000),
  result("r3", "c3", "bash", "branch 'fix/pool' set up to track 'origin/fix/pool'."),
  // Refused: opened nothing, so it is not the first PR.
  assistant("a4", [{ id: "c4", name: "bash", arguments: { command: "gh pr create --title x" } }], 4000),
  result("r4", "c4", "bash", "error: gh: not authenticated"),
  assistant(
    "a5",
    [
      {
        id: "c5",
        name: "bash",
        arguments: {
          command: `cd /work/7/omni && gh pr create --base main --title "Bound the pool" --body "$(cat <<'EOF'\nWhy it matters.\n\nMore.\nEOF\n)"`,
        },
      },
      { id: "c6", name: "bash", arguments: { command: "gh pr view --json url" } },
    ],
    5000,
  ),
  result("r5", "c5", "bash", "https://github.com/thegoodparty/omni/pull/2213"),
  result("r6", "c6", "bash", '{"url":"https://github.com/thegoodparty/omni/pull/2213"}'),
  assistant("a7", [{ id: "c7", name: "monitor", arguments: { command: "gh pr checks 2213" } }], 6000),
  result("r7", "c7", "monitor", "all green"),
  assistant("a8", [{ id: "c8", name: "bash", arguments: { command: "gh pr create --head fix/second --title Second" } }], 7000),
  result("r8", "c8", "bash", "https://github.com/thegoodparty/omni/pull/2214"),
].join("\n");

test("the cut ends with the PR-opening turn and every result of that turn", () => {
  const c = cutAtPrOpen(SESSION);
  const lines = c.jsonl.trim().split("\n");
  assert.equal(JSON.parse(lines[lines.length - 1]).id, "r6");
  assert.ok(!c.jsonl.includes("all green"));
  assert.equal(c.turns, 5);
  assert.equal(c.prOpenedAt, 5000);
});

test("a refused gh pr create does not count as opening a PR", () => {
  assert.equal(cutAtPrOpen(SESSION).pr.number, 2213);
});

test("it reads the PR, branch, title, heredoc body, view and root cause", () => {
  const c = cutAtPrOpen(SESSION);
  assert.deepEqual(c.pr, { owner: "thegoodparty", repo: "omni", number: 2213, url: "https://github.com/thegoodparty/omni/pull/2213" });
  assert.equal(c.branch, "fix/pool");
  assert.equal(c.title, "Bound the pool");
  assert.equal(c.body, "Why it matters.\n\nMore.");
  assert.deepEqual(c.view, VIEW);
  assert.equal(c.rootCause, "Pool exhaustion.");
  assert.equal(c.cwd, "/work/7/omni");
  assert.equal(c.incidentId, "7");
});

test("the second PR's phase is reachable, with its branch from --head", () => {
  const c = cutAtPrOpen(SESSION, 2);
  assert.equal(c.pr.number, 2214);
  assert.equal(c.branch, "fix/second");
  assert.throws(() => cutAtPrOpen(SESSION, 3), /never opened PR number 3/);
});

test("the GitHub host is rewritten in tool results only", () => {
  const withAssistantUrl = `${SESSION}\n${assistant("a9", [{ id: "c9", name: "bash", arguments: { command: "gh pr view https://github.com/thegoodparty/omni/pull/2213" } }], 8000)}`;
  const rewritten = rewriteGitHubHost(withAssistantUrl, "github:8444");
  assert.match(rewritten, /https:\/\/github:8444\/thegoodparty\/omni\/pull\/2213/);
  const last = JSON.parse(rewritten.trim().split("\n").at(-1) as string);
  assert.match(JSON.stringify(last), /https:\/\/github\.com\/thegoodparty/);
  // Lines that are not tool results come through byte for byte.
  const before = withAssistantUrl.split("\n");
  const after = rewritten.split("\n");
  before.forEach((line, i) => {
    if (!line.includes('"toolResult"')) assert.equal(after[i], line);
  });
});

test("flagValue handles quoted, bare and heredoc values", () => {
  assert.equal(flagValue('gh pr create --title "a \\"b\\" c"', "--title"), 'a \\"b\\" c');
  assert.equal(flagValue("gh pr create --head fix/x --title y", "--head"), "fix/x");
  assert.equal(flagValue("gh pr create --title 'single'", "--title"), "single");
  assert.equal(flagValue("gh pr create", "--body"), null);
});

test("viewFromResult refuses a result that is not an ok view", () => {
  assert.equal(viewFromResult("error: nope"), null);
  assert.equal(viewFromResult("ok\n\nnot json"), null);
});
