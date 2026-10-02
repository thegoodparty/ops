// The Boss's `gh`: the exec seam against a fake gh binary, and the tool's
// bounds. Incident 94, the Boss asked who made a PR, is replayed in
// agent.test.ts.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { buildGhTool, createGhExec, MAX_GH_OUTPUT_CHARS, type GhExec, type GhOutcome } from "./gh";

const TOKEN = "ghs_FAKEINSTALLATIONTOKEN0123456789";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-gh-test-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fakeBinary = (name: string, script: string): string => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
};

describe("the gh exec seam", () => {
  test("argv reaches gh as literal arguments, never through a shell", async () => {
    const bin = fakeBinary("gh-argv", 'for a in "$@"; do printf "[%s]\\n" "$a"; done');
    const out = await createGhExec({ token: async () => TOKEN, binary: bin })([
      "pr",
      "view",
      "2265; echo pwned",
      "--jq",
      ".author.login | ascii_downcase",
      "$(id)",
    ]);
    assert.equal(out.exitCode, 0);
    assert.deepEqual(out.stdout.trim().split("\n"), [
      "[pr]",
      "[view]",
      "[2265; echo pwned]",
      "[--jq]",
      "[.author.login | ascii_downcase]",
      "[$(id)]",
    ]);
  });

  test("the child gets the installation token and none of the Boss's other secrets", async () => {
    process.env.BUGBOSS_TEST_OTHER_SECRET = "xoxb-slack-token";
    try {
      const bin = fakeBinary(
        "gh-env",
        [
          `[ "$GH_TOKEN" = "${TOKEN}" ] && echo "gh_token=ok"`,
          `[ "$GITHUB_TOKEN" = "${TOKEN}" ] && echo "github_token=ok"`,
          'echo "other=${BUGBOSS_TEST_OTHER_SECRET:-absent}"',
          'echo "repo=$GH_REPO"',
          'echo "echoed=$GH_TOKEN" >&2',
        ].join("\n"),
      );
      const out = await createGhExec({ token: async () => TOKEN, binary: bin })(["api", "rate_limit"]);
      assert.match(out.stdout, /gh_token=ok/);
      assert.match(out.stdout, /github_token=ok/);
      assert.match(out.stdout, /other=absent/, "the Boss's environment is not inherited");
      assert.match(out.stdout, /repo=thegoodparty\/omni/);
      assert.ok(!out.stderr.includes(TOKEN), "a token gh prints is scrubbed before anyone reads it");
      assert.match(out.stderr, /echoed=\[token\]/);
    } finally {
      delete process.env.BUGBOSS_TEST_OTHER_SECRET;
    }
  });

  test("a non-zero exit hands back gh's stderr", async () => {
    const bin = fakeBinary("gh-fail", 'echo "GraphQL: Could not resolve to a PullRequest with the number of 99999." >&2; exit 1');
    const tool = buildGhTool(createGhExec({ token: async () => TOKEN, binary: bin }));
    const text = await tool.run({ args: ["pr", "view", "99999"] });
    assert.match(text, /^gh exited 1\./);
    assert.match(text, /Could not resolve to a PullRequest/);
  });

  test("a call past its bound is stopped and says so", async () => {
    const bin = fakeBinary("gh-slow", "sleep 5");
    const out = await createGhExec({ token: async () => TOKEN, binary: bin, timeoutMs: 200 })(["run", "watch"]);
    assert.equal(out.timedOut, true);
  });
});

const fixed = (outcome: Partial<GhOutcome>): { exec: GhExec; calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    exec: (args) => {
      calls.push(args);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false, overflowed: false, ...outcome });
    },
  };
};

describe("the gh tool", () => {
  test("output over the budget is refused whole, never cut", async () => {
    const head = "HEAD-OF-A-VERY-LONG-LIST";
    const { exec } = fixed({ stdout: head + "x".repeat(MAX_GH_OUTPUT_CHARS) });
    const text = await buildGhTool(exec).run({ args: ["pr", "list", "--limit", "1000"] });
    assert.match(text, /^Refused: gh pr printed \d+ characters/);
    assert.match(text, /--json/, "and it says how to ask for less");
    assert.ok(!text.includes(head), "none of the output is shown");
  });

  test("output that overflowed the pipe is refused, not shown partial", async () => {
    const { exec } = fixed({ stdout: "partial", overflowed: true, exitCode: null });
    const text = await buildGhTool(exec).run({ args: ["pr", "diff", "2265"] });
    assert.match(text, /^Refused:/);
    assert.ok(!text.includes("partial"));
  });

  test("commands that would expose the token or run another program never run", async () => {
    const { exec, calls } = fixed({ stdout: TOKEN });
    for (const args of [["auth", "token"], ["alias", "set", "x", "!sh"], ["extension", "install", "a/b"], ["config", "set", "git_protocol", "ssh"]]) {
      assert.match(await buildGhTool(exec).run({ args }), /^Refused:/);
    }
    assert.deepEqual(calls, []);
  });

  test("without App credentials the tool exists and says it cannot run", async () => {
    const text = await buildGhTool(null).run({ args: ["pr", "view", "2265"] });
    assert.match(text, /^Unavailable:/);
  });

  test("a malformed call is refused before anything runs", async () => {
    const { exec, calls } = fixed({});
    assert.match(await buildGhTool(exec).run({ args: "pr view 2265" }), /^Refused: args must be/);
    assert.match(await buildGhTool(exec).run({ args: ["gh", "pr", "view", "2265"] }), /^Refused: leave out/);
    assert.deepEqual(calls, []);
  });
});
