import assert from "node:assert/strict";
import { describe, test } from "node:test";

import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from "axios";

import { createCachingLinker, createSlackFileUploader } from "./client";
import type { ReportUpload } from "../report";

const INCIDENTS = "C0DEVALERTS";
const ELSEWHERE = "C0RANDOM";

const answer = (messageTs: string, channel = INCIDENTS): string =>
  `https://goodparty.slack.com/archives/${channel}/p${messageTs.replaceAll(".", "")}`;

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
    const linker = createCachingLinker(
      {
        permalink: (ts) => {
          asked.push(ts);
          return Promise.resolve(answer(ts));
        },
      },
      INCIDENTS,
    );

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
    const linker = createCachingLinker(
      {
        permalink: (ts) => {
          calls++;
          return new Promise((resolve) => setTimeout(() => resolve(answer(ts)), 5));
        },
      },
      INCIDENTS,
    );

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
    const linker = createCachingLinker(
      {
        permalink: (ts) => {
          calls++;
          return calls === 1
            ? Promise.reject(new Error("ratelimited"))
            : Promise.resolve(answer(ts));
        },
      },
      INCIDENTS,
    );

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
    const linker = createCachingLinker(
      {
        permalink: (ts) => {
          asked.push(ts);
          return Promise.resolve(`https://goodparty.slack.com/something-else/${ts}`);
        },
      },
      INCIDENTS,
    );

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

  test("a thread in another channel is linked to that channel", async () => {
    const asked: { ts: string; channel?: string }[] = [];
    const linker = createCachingLinker(
      {
        permalink: (ts, channel) => {
          asked.push({ ts, channel });
          return Promise.resolve(answer(ts, channel ?? INCIDENTS));
        },
      },
      INCIDENTS,
    );

    assert.equal(await linker.permalink("100.000200"), answer("100.000200"));
    assert.equal(
      await linker.permalink("300.000400", ELSEWHERE),
      answer("300.000400", ELSEWHERE),
      "only the workspace was learned, so the channel is still the caller's",
    );
    assert.deepEqual(asked, [{ ts: "100.000200", channel: undefined }]);
  });

  test("a channel that comes back as a different one teaches nothing", async () => {
    // Deriving from an answer about somewhere else would send every later
    // reader to a link to nowhere.
    const asked: string[] = [];
    const linker = createCachingLinker(
      {
        permalink: (ts) => {
          asked.push(ts);
          return Promise.resolve(answer(ts, "C0SOMEWHEREELSE"));
        },
      },
      INCIDENTS,
    );

    const lines = await captureLogs(async () => {
      await linker.permalink("100.000200");
      await linker.permalink("300.000400");
    });

    assert.equal(asked.length, 2);
    assert.ok(lines.some((line) => line.includes('"permalink_shape_unknown"')));
  });

  test("the query parameters Slack puts on its own links teach the workspace too", async () => {
    // Verbatim out of production: ten of these in a second and a half, every
    // one of them unreadable, so the workspace was never learned and every
    // incident in the answer cost its own round trip. It is also what Slack's
    // "Copy link" hands a person, so nothing about it is exotic.
    const asked: string[] = [];
    const linker = createCachingLinker(
      {
        permalink: (ts) => {
          asked.push(ts);
          return Promise.resolve(
            `${answer(ts)}?thread_ts=${ts}&cid=${INCIDENTS}`,
          );
        },
      },
      INCIDENTS,
    );

    let first = "";
    const lines = await captureLogs(async () => {
      first = await linker.permalink("1790357486.538869");
      await linker.permalink("300.000400");
      await linker.permalink("500.000600");
    });

    assert.equal(
      first,
      `${answer("1790357486.538869")}?thread_ts=1790357486.538869&cid=${INCIDENTS}`,
      "the answer Slack gave is still what the first caller gets",
    );
    assert.deepEqual(
      asked,
      ["1790357486.538869"],
      "one round trip for three links, not three",
    );
    assert.ok(
      !lines.some((line) => line.includes("permalink_shape_unknown")),
      "this is Slack's own shape and nothing is wrong with it",
    );
  });

  test("a link to a message inside a thread teaches the workspace and nothing else", async () => {
    // The parameters carry the parent thread's timestamp, which is not the
    // linked message's own. Reading either of them back out would point every
    // later link at the wrong message, so neither is read: what is taken is
    // the workspace, and the timestamp is the one the caller asked with.
    const asked: string[] = [];
    const linker = createCachingLinker(
      {
        permalink: (ts) => {
          asked.push(ts);
          return Promise.resolve(
            `${answer(ts)}?thread_ts=1790000000.000001&cid=${INCIDENTS}`,
          );
        },
      },
      INCIDENTS,
    );

    await linker.permalink("1790357486.538869");

    assert.equal(
      await linker.permalink("300.000400"),
      answer("300.000400"),
      "derived from the timestamp asked for, never from the parent in the query",
    );
    assert.deepEqual(asked, ["1790357486.538869"]);
  });

  test("an unreadable answer is said once, not once per row", async () => {
    // Fifty rows against one defect is fifty identical alarms, which is how
    // an alarm stops meaning anything.
    const linker = createCachingLinker(
      {
        permalink: (ts) =>
          Promise.resolve(`https://goodparty.slack.com/something-else/${ts}`),
      },
      INCIDENTS,
    );

    const lines = await captureLogs(async () => {
      await linker.permalink("100.000200");
      await linker.permalink("300.000400");
      await linker.permalink("500.000600");
    });

    assert.equal(
      lines.filter((line) => line.includes('"permalink_shape_unknown"')).length,
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// The upload
// ---------------------------------------------------------------------------

/**
 * `createSlackFileUploader` is the one thing in this file that talks to Slack
 * for real, and it does so over two different transports on purpose: the two
 * API calls go through the WebClient, which is axios underneath, and the POST
 * to the signed url is a bare `fetch` because that host is not Slack and
 * takes no token. So both are stubbed. Replacing only `globalThis.fetch`
 * would leave `files.getUploadURLExternal` reaching out to slack.com from the
 * test suite, and replacing only the axios adapter would let the POST out.
 *
 * What is worth covering here is everything the three steps promise each
 * other: the bound on the middle one, the byte count the first one promises
 * and the last one is checked against, and the rule that a POST which did not
 * land must never be completed. None of that is visible from `report/`, which
 * sees one `upload()` that either resolved or did not.
 */

const SIGNED_URL = "https://files.slack.test/upload?t=abc";

interface ApiCall {
  /** The bare method name, e.g. `files.completeUploadExternal`. */
  method: string;
  params: URLSearchParams;
  /** The WebClient's own bound. Zero is the SDK default, i.e. none. */
  timeout: number;
}

interface Attempt {
  url: string;
  method: string;
  signal: AbortSignal | null;
  /**
   * Read inside the stub rather than afterwards. A signal already aborted
   * when the request was handed over would mean the POST never went at all,
   * and that is indistinguishable from a healthy one once the call returns.
   */
  abortedAtCall: boolean;
  bytes: number;
}

interface UploadRun {
  api: ApiCall[];
  posts: Attempt[];
  /**
   * Captured rather than asserted with `assert.rejects` because every failure
   * here is also a claim about which API calls did and did not happen, and
   * those live on the same run.
   */
  error: Error | null;
}

interface Ticket {
  ok: boolean;
  upload_url?: string;
  file_id?: string;
}

const A_FILE: ReportUpload = {
  channel: "C0DEVALERTS",
  threadTs: "100.000200",
  filename: "inc-1.md",
  title: "inc-1 post-mortem",
  content: "the document",
  comment: "post-mortem attached",
};

const drive = async (
  file: ReportUpload,
  options: {
    ticket?: Ticket;
    upload?: () => Promise<Response>;
    /** A status the API answers with, for the retry question. */
    apiStatus?: number;
  } = {},
): Promise<UploadRun> => {
  const api: ApiCall[] = [];
  const posts: Attempt[] = [];
  const realAdapter = axios.defaults.adapter;
  const realFetch = globalThis.fetch;
  let error: Error | null = null;

  axios.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
    const url = `${config.baseURL ?? ""}${config.url ?? ""}`;
    const method = url.slice(url.lastIndexOf("/") + 1);
    api.push({
      method,
      params: new URLSearchParams(String(config.data ?? "")),
      timeout: config.timeout ?? 0,
    });
    const data: Ticket =
      method === "files.getUploadURLExternal"
        ? (options.ticket ?? { ok: true, upload_url: SIGNED_URL, file_id: "F0DOC" })
        : { ok: true };
    return Promise.resolve({
      data,
      status: options.apiStatus ?? 200,
      statusText: options.apiStatus ? "Server Error" : "OK",
      headers: {},
      config,
      // `buildResult` reads this to spot the one method that answers with a
      // file rather than JSON, and dies on an adapter that omits it.
      request: { path: `/api/${method}` },
    } as AxiosResponse<Ticket>);
  }) as typeof axios.defaults.adapter;

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const signal = init?.signal ?? null;
    posts.push({
      url: String(input),
      method: init?.method ?? "GET",
      signal,
      abortedAtCall: signal !== null && signal.aborted,
      bytes: Buffer.isBuffer(init?.body) ? init.body.byteLength : -1,
    });
    return options.upload ? options.upload() : new Response("OK", { status: 200 });
  }) as typeof fetch;

  try {
    await createSlackFileUploader("xoxb-test").upload(file);
  } catch (err) {
    error = err as Error;
  } finally {
    axios.defaults.adapter = realAdapter;
    globalThis.fetch = realFetch;
  }

  return { api, posts, error };
};

const methods = (run: UploadRun): string[] => run.api.map((call) => call.method);

const paramsFor = (run: UploadRun, method: string): URLSearchParams => {
  const call = run.api.find((each) => each.method === method);
  if (!call) throw new Error(`${method} was never called: ${methods(run).join(", ")}`);
  return call.params;
};

describe("an upload is bounded, or it is not an upload", () => {
  test("the POST to the signed url carries a live abort signal", async () => {
    const run = await drive(A_FILE);

    assert.equal(run.error, null);
    assert.equal(run.posts.length, 1);
    const [post] = run.posts;
    assert.equal(post.url, SIGNED_URL);
    assert.equal(post.method, "POST");
    // The signal is the whole point of this test. Deleting it is a one-line
    // change that nothing else in the suite would notice, and it puts the
    // report sweep back to waiting for as long as somebody else's host cares
    // to hold the socket -- which is strictly worse than the inline fallback.
    assert.ok(post.signal instanceof AbortSignal, "the POST has no timeout");
    assert.equal(post.abortedAtCall, false, "a dead signal means it never went");
    // The two API calls either side are bounded too, and by the same number.
    // The SDK's default is zero, so an unbounded WebClient looks like a
    // working one right up until Slack stops answering.
    for (const call of run.api) {
      assert.ok(call.timeout > 0, `${call.method} is unbounded`);
      assert.equal(call.timeout, run.api[0].timeout);
    }
  });

  test("an upload that outlives its bound fails rather than completing", async () => {
    const run = await drive(A_FILE, {
      upload: () => {
        // The shape `AbortSignal.timeout` actually rejects with.
        const timedOut = new Error("The operation was aborted due to timeout");
        timedOut.name = "TimeoutError";
        return Promise.reject(timedOut);
      },
    });

    assert.equal(run.error?.name, "TimeoutError");
    assert.equal(run.posts.length, 1, "the POST was attempted");
    // Completing an upload whose bytes never arrived is the one outcome worse
    // than failing: Slack publishes a file the reader cannot open, and the
    // inline fallback never runs because nothing threw.
    assert.deepEqual(methods(run), ["files.getUploadURLExternal"]);
  });

  test("a rejection from the signed url says which status, and completes nothing", async () => {
    const run = await drive(A_FILE, {
      upload: () =>
        Promise.resolve(
          new Response("too big", { status: 413, statusText: "Payload Too Large" }),
        ),
    });

    // The status is the only part of this a human can act on: 413 is a
    // document to shorten, 403 is an expired ticket, 500 is Slack's problem.
    assert.match(String(run.error?.message), /413/);
    assert.deepEqual(methods(run), ["files.getUploadURLExternal"]);
  });

  test("a ticket missing either half of itself throws before any POST", async () => {
    for (const ticket of [
      { ok: true, file_id: "F0DOC" },
      { ok: true, upload_url: SIGNED_URL },
      { ok: true },
    ]) {
      const run = await drive(A_FILE, { ticket });

      assert.match(String(run.error?.message), /no upload url/, JSON.stringify(ticket));
      // Posting a body to `undefined` resolves against nothing useful and the
      // failure would be reported as whatever that host answered.
      assert.equal(run.posts.length, 0, JSON.stringify(ticket));
      assert.deepEqual(methods(run), ["files.getUploadURLExternal"]);
    }
  });

  test("the length promised is bytes, not characters", async () => {
    // A post-mortem quoting a log line is rarely pure ASCII, and Slack
    // rejects the completion when the promised length does not match what
    // arrived -- so a character count fails only on the documents that
    // contain the interesting part.
    const content = "rate rose 4% — timeouts on /café 🎉";
    const run = await drive({ ...A_FILE, content });

    const promised = Number(paramsFor(run, "files.getUploadURLExternal").get("length"));
    assert.equal(promised, Buffer.byteLength(content, "utf8"));
    assert.ok(
      promised > content.length,
      `${promised} vs ${content.length}: the fixture has no multi-byte characters`,
    );
    assert.equal(run.posts[0]?.bytes, promised, "what was sent is what was promised");
    assert.equal(run.error, null);
  });

  test("the completion names the thread the incident is already in", async () => {
    const run = await drive(A_FILE);

    const done = paramsFor(run, "files.completeUploadExternal");
    // Without these the file lands in the channel root as a message nobody is
    // watching, detached from the incident it explains.
    assert.equal(done.get("channel_id"), "C0DEVALERTS");
    assert.equal(done.get("thread_ts"), "100.000200");
    assert.equal(done.get("initial_comment"), "post-mortem attached");
    assert.equal(
      done.get("files"),
      JSON.stringify([{ id: "F0DOC", title: "inc-1 post-mortem" }]),
      "the file id comes from the ticket, not from anything the caller knows",
    );
  });

  test("a report with no thread still uploads, into the channel", async () => {
    const run = await drive({ ...A_FILE, threadTs: null });

    assert.equal(run.error, null);
    const done = paramsFor(run, "files.completeUploadExternal");
    assert.equal(done.get("channel_id"), "C0DEVALERTS");
    assert.equal(done.get("thread_ts"), null, "absent, not the string \"null\"");
  });
});

describe("the upload does not retry its way past the tick it has", () => {
  test("a retryable failure is attempted once, not five times over five minutes", async () => {
    // This is the bound that is easy to get wrong because every individual
    // request still looks bounded. The SDK's default policy spreads five
    // attempts over five minutes, which is ten dispatcher ticks of the report
    // sweep held open -- against a documented guarantee that a Slack which
    // will not take the file degrades to thread text on the tick that noticed
    // the close. Retrying also buys nothing here: the other side of this
    // failure is the same report, in the thread, as text.
    const run = await drive(A_FILE, { apiStatus: 500 });

    assert.ok(run.error, "a 500 from Slack fails the upload");
    assert.deepEqual(
      methods(run),
      ["files.getUploadURLExternal"],
      "one attempt, and nothing downstream of it",
    );
    assert.deepEqual(run.posts, [], "no POST to a signed url it never received");
  });

  test("every API call carries the same per-call bound", async () => {
    // Zero is the SDK default and means unbounded. With retries off, the
    // per-call bound is the whole story: three steps at 8s is 24s of worst
    // case, inside the 30s tick.
    const run = await drive(A_FILE);

    const bounds = [...new Set(run.api.map((call) => call.timeout))];
    assert.equal(bounds.length, 1, `mixed bounds: ${bounds.join(", ")}`);
    assert.ok(bounds[0] > 0, "an unbounded WebClient call is the defect");
    assert.ok(
      run.api.length * bounds[0] < 30_000,
      `${run.api.length} calls at ${bounds[0]}ms must fit one 30s tick`,
    );
  });
});
