import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createCachingLinker } from "./client";

const ARCHIVE = "https://goodparty.slack.com/archives/C0DEVALERTS";

const answer = (messageTs: string): string =>
  `${ARCHIVE}/p${messageTs.replaceAll(".", "")}`;

const captureLogs = async (fn: () => Promise<unknown>): Promise<string[]> => {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (line: unknown) => lines.push(String(line));
  console.error = (line: unknown) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines;
};

describe("a permalink is paid for once", () => {
  test("the first real answer teaches every later link", async () => {
    const asked: string[] = [];
    const linker = createCachingLinker({
      permalink: (ts) => {
        asked.push(ts);
        return Promise.resolve(answer(ts));
      },
    });

    assert.equal(await linker.permalink("100.000200"), answer("100.000200"));
    assert.equal(await linker.permalink("300.000400"), answer("300.000400"));
    assert.equal(await linker.permalink("500.000600"), answer("500.000600"));

    assert.deepEqual(
      asked,
      ["100.000200"],
      "an answer naming three incidents is one round trip, not three",
    );
  });

  test("two callers racing the same link do not both pay for it", async () => {
    let calls = 0;
    const linker = createCachingLinker({
      permalink: (ts) => {
        calls++;
        return new Promise((resolve) => setTimeout(() => resolve(answer(ts)), 5));
      },
    });

    const [a, b] = await Promise.all([
      linker.permalink("100.000200"),
      linker.permalink("100.000200"),
    ]);

    assert.equal(a, answer("100.000200"));
    assert.equal(b, a);
    assert.equal(calls, 1);
  });

  test("a failure is not remembered as an answer", async () => {
    let calls = 0;
    const linker = createCachingLinker({
      permalink: (ts) => {
        calls++;
        return calls === 1
          ? Promise.reject(new Error("ratelimited"))
          : Promise.resolve(answer(ts));
      },
    });

    await assert.rejects(linker.permalink("100.000200"), /ratelimited/);
    assert.equal(
      await linker.permalink("100.000200"),
      answer("100.000200"),
      "the next caller gets to try again",
    );
    assert.equal(calls, 2);
  });

  test("an answer it cannot read is still the right link, and is said out loud", async () => {
    const asked: string[] = [];
    const linker = createCachingLinker({
      permalink: (ts) => {
        asked.push(ts);
        return Promise.resolve(`https://goodparty.slack.com/something-else/${ts}`);
      },
    });

    let first = "";
    const lines = await captureLogs(async () => {
      first = await linker.permalink("100.000200");
      await linker.permalink("300.000400");
    });

    assert.equal(first, "https://goodparty.slack.com/something-else/100.000200");
    assert.equal(asked.length, 2, "nothing was learned, so both cost a call");
    assert.ok(
      lines.some((line) => line.includes('"permalink_shape_unknown"')),
      "a silent rise in Slack calls is exactly what nobody notices",
    );
  });
});
