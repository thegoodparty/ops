// The Boss's `gh`: the exec seam against a fake gh binary, the tool's
// bounds, and a Boss run through the real harness asked who made a PR.
//
// Incident 94's thread is the premise: asked "who made 2265?", the Boss said
// it had no GitHub access and asked Swain to paste the link.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import { createSlackAgentModel } from "../index";
import { emptyModelUsage, type ModelReply, type ModelRequest, type SizedModelClient } from "../model";
import { SlackAgent, type ObjectStore, type SlackMessage } from "./agent";
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

const captureLogs = async <T>(fn: () => Promise<T>): Promise<{ lines: string[]; value: T }> => {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (line: unknown) => lines.push(String(line));
  console.error = (line: unknown) => lines.push(String(line));
  try {
    return { lines, value: await fn() };
  } finally {
    console.log = log;
    console.error = error;
  }
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

// ---------------------------------------------------------------------------
// Incident 94's question, through the real harness
// ---------------------------------------------------------------------------

const noS3 = (): S3Client =>
  ({
    send: async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) {
        const err = new Error("cold start");
        err.name = "NoSuchKey";
        throw err;
      }
      return {};
    },
  }) as unknown as S3Client;

const memoryStore = (): ObjectStore => {
  const objects = new Map<string, string>();
  return {
    get: (key) => Promise.resolve(objects.get(key) ?? null),
    put: (key, body) => {
      objects.set(key, body);
      return Promise.resolve();
    },
    list: (prefix) => Promise.resolve([...objects.keys()].filter((k) => k.startsWith(prefix))),
  };
};

const PR_2265 = JSON.stringify({
  number: 2265,
  title: "Group alert notifications by rule rather than by endpoint",
  author: { login: "jeffgp" },
  state: "MERGED",
});

/**
 * What the Boss did in incident 94, as a rule: with a way to read GitHub it
 * reads it, and without one it says it cannot. The model is scripted; which
 * branch it takes is decided by the tools the harness actually offered.
 */
const whoMadeModel = () => {
  const requests: ModelRequest[] = [];
  const reply = (text: string, call?: { name: string; input: Record<string, unknown> }): ModelReply => ({
    text,
    toolCalls: call ? [{ id: `call-${requests.length}`, ...call }] : [],
    usage: emptyModelUsage(),
  });
  const model: SizedModelClient = {
    contextWindow: 1_000_000,
    complete: (request) => {
      requests.push(request);
      const result = request.messages.filter((m) => m.role === "toolResult").at(-1);
      if (!result) {
        if (!request.tools.some((t) => t.name === "gh")) {
          return Promise.resolve(reply("I don't have GitHub access directly. Can you paste the link?"));
        }
        return Promise.resolve(
          reply("", { name: "gh", input: { args: ["pr", "view", "2265", "--json", "number,title,author,state"] } }),
        );
      }
      try {
        const pr = JSON.parse(result.text) as { number: number; title: string; author: { login: string }; state: string };
        return Promise.resolve(reply(`omni#${pr.number} is "${pr.title}", opened by ${pr.author.login}. It is ${pr.state.toLowerCase()}.`));
      } catch {
        return Promise.resolve(reply(`I could not read it: ${result.text}`));
      }
    },
  };
  return { model, requests };
};

describe("incident 94, replayed", () => {
  let db: Db;
  let dbDir: string;

  before(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "bugboss-gh-run-"));
    db = await Db.open({ path: join(dbDir, "boss.db"), bucket: "bugboss-test", key: "state/db", s3: noS3() });
  });

  after(() => {
    db?.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  test("asked who made omni#2265, the Boss reads it with gh and answers from it", async () => {
    const { model, requests } = whoMadeModel();
    const store = memoryStore();
    const posts: { threadTs: string | null; text: string }[] = [];
    const replies: SlackMessage[] = [];
    const ghCalls: string[][] = [];
    const gh: GhExec = (args) => {
      ghCalls.push(args);
      return Promise.resolve({ exitCode: 0, stdout: PR_2265, stderr: "", timedOut: false, overflowed: false });
    };
    const agent = new SlackAgent({
      db,
      store,
      slack: {
        post: (threadTs, text) => {
          posts.push({ threadTs, text });
          return Promise.resolve({ ts: `950.${String(posts.length).padStart(6, "0")}` });
        },
        replies: () => Promise.resolve(replies),
        permalink: (ts) => Promise.resolve(`https://goodparty.slack.com/archives/C0ALERTS/p${ts.replaceAll(".", "")}`),
      },
      model: createSlackAgentModel(model, store),
      summaryModel: model,
      config: { botUserId: "U0BUGBOSS", alertChannel: "C0ALERTS", rotationGroupId: null, incidentChannel: "C0INCIDENTS" },
      closeIncident: () => Promise.reject(new Error("no close expected")),
      openIncident: () => Promise.reject(new Error("no report expected")),
      gh,
    });

    await captureLogs(() =>
      agent.handle({
        channel: "C0ALERTS",
        threadTs: "940.000100",
        ts: "940.000100",
        user: "U0SWAIN",
        text: "<@U0BUGBOSS> look at 2265. it's a very similar PR. Who made it?",
      }),
    );

    assert.ok(requests[0].tools.some((t) => t.name === "gh"), "premise: the harness offered gh");
    assert.deepEqual(ghCalls, [["pr", "view", "2265", "--json", "number,title,author,state"]], "it looked the PR up itself");
    const answer = posts.map((p) => p.text).join("\n");
    assert.match(answer, /jeffgp/, "and answered from what gh returned");
    assert.doesNotMatch(answer, /paste/i, "rather than asking a person to paste it");
  });
});
