// What the closing report is allowed to say about a PR.
//
// This is worth its own file because every failure in here is designed to be
// invisible: a PR GitHub will not answer for is left out of the result and
// renders as "state not known", which is the right behaviour for a report
// that must not block a close, and also means a broken auth header or a
// wrong url shape would degrade silently forever while still producing a
// perfectly plausible-looking report. The request shape and the mapping from
// GitHub's answer are the parts nothing downstream can notice being wrong.
//
// The one outcome worth avoiding is saying a PR merged when it did not, so
// the mapping is pinned in both directions: GitHub reports `closed` for a
// merged PR too, and `merged_at` is the only thing that separates them.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createPrStateReader, tokenFromFile } from "./github";

interface Sent {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | null | undefined;
}

type Answer =
  | { body: unknown; status?: number }
  | { throws: unknown };

/**
 * One `logging.ts` line, cut down to the parts these tests are about. The
 * level is the claim being made -- `error` says a human has to change
 * something, `info` says a request went badly once -- and the two are worth
 * pinning because the result is identical either way, so nothing else in the
 * suite can tell them apart.
 */
interface Emitted {
  level: string;
  event: string;
}

/**
 * Runs one lookup against a stubbed fetch. `answers` is keyed by PR number,
 * so a single call can be asked about several PRs with different outcomes --
 * which is the real shape, since an incident's `prUrls` is a list.
 */
const read = async (
  urls: string[],
  answers: Record<string, Answer>,
  token: () => Promise<string> = async () => "ghs-token",
): Promise<{
  states: Record<string, string | null>;
  sent: Sent[];
  tokens: number;
  emitted: Emitted[];
}> => {
  const original = globalThis.fetch;
  const originalError = console.error;
  const originalLog = console.log;
  const sent: Sent[] = [];
  const emitted: Emitted[] = [];
  const capture = (line: string) => {
    const parsed = JSON.parse(line) as Emitted;
    emitted.push({ level: parsed.level, event: parsed.event });
  };
  console.error = capture;
  console.log = capture;
  let tokens = 0;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: init?.signal,
    });
    const answer = answers[url.split("/").pop() ?? ""];
    if (!answer) throw new Error(`no stubbed answer for ${url}`);
    if ("throws" in answer) throw answer.throws;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const reader = createPrStateReader(async () => {
      tokens++;
      return token();
    });
    const states = (await reader.states(urls)) as Record<string, string | null>;
    return { states, sent, tokens, emitted };
  } finally {
    globalThis.fetch = original;
    console.error = originalError;
    console.log = originalLog;
  }
};

const pr = (n: number): string => `https://github.com/thegoodparty/omni/pull/${n}`;

test("an open PR reads as open", async () => {
  const { states } = await read([pr(1)], {
    "1": { body: { state: "open", merged_at: null } },
  });

  assert.deepEqual(states, { [pr(1)]: "open" });
});

test("a merged PR reads as merged even though GitHub calls it closed", async () => {
  // The whole reason merged_at is consulted at all. A report that said
  // "closed" for the PR that fixed the incident would be actively wrong.
  const { states } = await read([pr(2)], {
    "2": { body: { state: "closed", merged_at: "2026-09-27T10:04:00Z" } },
  });

  assert.deepEqual(states, { [pr(2)]: "merged" });
});

test("a PR closed without merging reads as closed", async () => {
  const { states } = await read([pr(3)], {
    "3": { body: { state: "closed", merged_at: null } },
  });

  assert.deepEqual(states, { [pr(3)]: "closed" });
});

test("a state GitHub has never used before is not guessed at", async () => {
  const { states } = await read([pr(4)], {
    "4": { body: { state: "draft", merged_at: null } },
  });

  assert.deepEqual(
    states,
    { [pr(4)]: null },
    "an unrecognised state is 'not known', not the nearest guess",
  );
});

test("a PR that 404s is left unanswered rather than called closed", async () => {
  // A deleted repo, a PR in a repo the App is not installed on, or a number
  // the model invented. None of those mean the PR did not merge.
  const { states } = await read([pr(5)], {
    "5": { status: 404, body: { message: "Not Found" } },
  });

  assert.deepEqual(states, {}, "absent, which renders as 'state not known'");
});

test("a GitHub call that fails outright leaves the states empty and does not throw", async () => {
  const { states } = await read([pr(6)], {
    "6": { throws: new Error("ECONNRESET") },
  });

  assert.deepEqual(states, {});
});

test("a request that outlives its bound is a missing state, not a hung report", async () => {
  const aborted = new Error("The operation was aborted due to timeout");
  aborted.name = "TimeoutError";
  const { states } = await read([pr(7)], { "7": { throws: aborted } });

  assert.deepEqual(states, {});
});

// The degradation is the same in all six cases below -- the state is absent
// and the report says "state not known". What differs is whether anyone
// should be woken, and since the result carries no trace of the difference,
// the level is the only place it exists.

test("a 401 is a rotated key, not news about this PR", async () => {
  const { states, emitted } = await read([pr(16)], {
    "16": { status: 401, body: { message: "Bad credentials" } },
  });

  assert.deepEqual(states, {});
  assert.deepEqual(emitted, [
    { level: "error", event: "pr_state_unavailable" },
  ]);
});

test("a 403 is a suspended or throttled installation and reads the same way", async () => {
  const { states, emitted } = await read([pr(17)], {
    "17": { status: 403, body: { message: "Resource not accessible" } },
  });

  assert.deepEqual(states, {});
  assert.deepEqual(emitted, [
    { level: "error", event: "pr_state_unavailable" },
  ]);
});

test("a 404 is the App missing from the repository, which is also somebody's to fix", async () => {
  // GitHub masks a repository an installation cannot see as 404, so this is
  // indistinguishable from a wrong number here -- and a wrong number the
  // model invented is still worth a human's attention.
  const { states, emitted } = await read([pr(18)], {
    "18": { status: 404, body: { message: "Not Found" } },
  });

  assert.deepEqual(states, {});
  assert.deepEqual(emitted, [
    { level: "error", event: "pr_state_unavailable" },
  ]);
});

test("a 5xx from GitHub is weather and stays at log level", async () => {
  const { states, emitted } = await read([pr(19)], {
    "19": { status: 500, body: { message: "Server Error" } },
  });

  assert.deepEqual(states, {});
  assert.deepEqual(emitted, [{ level: "info", event: "pr_state_unavailable" }]);
});

test("the bound firing is the bound doing its job, not a failure nobody asked for", async () => {
  const timedOut = new Error("The operation was aborted due to timeout");
  timedOut.name = "TimeoutError";
  const { states, emitted } = await read([pr(20)], {
    "20": { throws: timedOut },
  });

  assert.deepEqual(states, {});
  assert.deepEqual(emitted, [{ level: "info", event: "pr_state_unavailable" }]);
});

test("a transport error that is not the bound is a failure nobody asked for", async () => {
  const { states, emitted } = await read([pr(21)], {
    "21": { throws: new Error("ECONNRESET") },
  });

  assert.deepEqual(states, {});
  assert.deepEqual(emitted, [
    { level: "error", event: "pr_state_unavailable" },
  ]);
});

test("one PR failing does not cost the report the others", async () => {
  const { states } = await read([pr(8), pr(9), pr(10)], {
    "8": { body: { state: "closed", merged_at: "2026-09-27T10:04:00Z" } },
    "9": { throws: new Error("ECONNRESET") },
    "10": { body: { state: "open", merged_at: null } },
  });

  assert.deepEqual(states, { [pr(8)]: "merged", [pr(10)]: "open" });
});

test("anything that is not a pull request url is never fetched", async () => {
  const { states, sent } = await read(
    [
      "https://github.com/thegoodparty/omni/issues/42",
      "https://github.com/thegoodparty/omni/pull/notanumber",
      "https://example.com/thegoodparty/omni/pull/42",
      "see the PR",
      "",
    ],
    {},
  );

  assert.deepEqual(states, {});
  assert.deepEqual(sent, [], "prUrls is model output, so it is parsed, not trusted");
});

test("a PR url with a tab or a fragment on it still resolves", async () => {
  const { states, sent } = await read(
    [
      "https://github.com/thegoodparty/omni/pull/11/files",
      " https://github.com/thegoodparty/omni/pull/12?diff=split ",
      "https://github.com/thegoodparty/omni/pull/13#discussion_r1",
    ],
    {
      "11": { body: { state: "open", merged_at: null } },
      "12": { body: { state: "open", merged_at: null } },
      "13": { body: { state: "open", merged_at: null } },
    },
  );

  assert.equal(Object.keys(states).length, 3);
  // Keyed by the url the incident row actually holds, whitespace and all,
  // because that is what the renderer looks up.
  assert.equal(states[" https://github.com/thegoodparty/omni/pull/12?diff=split "], "open");
  assert.deepEqual(
    sent.map((s) => s.url).sort(),
    [
      "https://api.github.com/repos/thegoodparty/omni/pulls/11",
      "https://api.github.com/repos/thegoodparty/omni/pulls/12",
      "https://api.github.com/repos/thegoodparty/omni/pulls/13",
    ],
    "the tab, the query and the fragment are not part of the API path",
  );
});

test("the request carries the installation token, the API version, and a bound", async () => {
  const { sent, tokens } = await read([pr(14)], {
    "14": { body: { state: "open", merged_at: null } },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.authorization, "Bearer ghs-token");
  assert.equal(sent[0].headers.accept, "application/vnd.github+json");
  assert.equal(sent[0].headers["x-github-api-version"], "2022-11-28");
  // Unbounded, this would hold the report sweep open on somebody else's
  // host. Every other fetch in bugboss is bounded and so is this one.
  assert.ok(sent[0].signal instanceof AbortSignal, "the request is bounded");
  assert.equal(sent[0].signal?.aborted, false);
  assert.equal(tokens, 1, "one token per lookup, not one per PR");
});

test("a token that cannot be minted is raised, not swallowed into an empty answer", async () => {
  // The caller in report/ alarms and renders every PR as "state not known".
  // Returning {} from here instead would make a GitHub App that is simply
  // misconfigured indistinguishable from an incident that opened no PRs.
  await assert.rejects(
    read([pr(15)], {}, async () => {
      throw new Error("bad private key");
    }),
    /bad private key/,
  );
});

test("no PRs means no calls at all", async () => {
  const { states, sent } = await read([], {});

  assert.deepEqual(states, {});
  assert.deepEqual(sent, []);
});

test("a token file is read on every use, so a harness that rewrites it is picked up", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = join(mkdtempSync(join(tmpdir(), "token-")), "token");
  const token = tokenFromFile(path);

  writeFileSync(path, "ghs_first\n");
  assert.equal(await token(), "ghs_first");
  writeFileSync(path, "ghs_second");
  assert.equal(await token(), "ghs_second");
  writeFileSync(path, "\n");
  await assert.rejects(token(), /holds no GitHub token/);
});
