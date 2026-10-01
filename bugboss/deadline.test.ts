import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";

import { beforeDeadline, deadline } from "./deadline";

const ROOT = join(__dirname, "..");

interface Site {
  file: string;
  line: number;
  call: string;
  span: string;
  /** Locals in the same file holding a `deadline(...)`, which a span may name instead. */
  signals: string[];
}

interface Allowed {
  file: string;
  /** Text the site's own arguments must still carry: its bound. */
  bound: string;
  reason: string;
}

// Sites bounded before `deadline.ts` existed, each by a constant of its own
// that the scan checks is still in the call.
const ALLOWED: Allowed[] = [
  { file: "bugboss/github.ts", bound: "PR_STATE_TIMEOUT_MS", reason: "the Boss's PR state read, 5s" },
  { file: "bugboss/ingress/grafana.ts", bound: "QUERY_TIMEOUT_MS", reason: "the Loki prefetch, 8s" },
  { file: "bugboss/slack/client.ts", bound: "UPLOAD_CALL_TIMEOUT_MS", reason: "the upload WebClient, 8s, retries off" },
  { file: "bugboss/slack/client.ts", bound: "byteUploadTimeoutMs", reason: "the file-byte POST, sized to the file" },
  { file: "bugboss/agent/session.ts", bound: "abortSignal", reason: "session GET/PUT, SESSION_STORE_TIMEOUT_MS (#224)" },
  { file: "bugboss/bedrock/index.ts", bound: "abortSignal", reason: "model stream, aborted by the idle watchdog (#224)" },
  { file: "bugboss/scripts/send-alert.ts", bound: "body", reason: "an operator CLI a person is watching" },
];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });

/** The argument list starting at the `(` at `open`, parens balanced. */
const argumentsAt = (text: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
};

/**
 * Every outbound call site in one file: fetch and its injected aliases, AWS
 * sends, WebClients. An S3Client is bounded per send, so the send is the site.
 */
const sitesIn = (file: string, source: string): Site[] => {
  const text = source
    .split("\n")
    .map((line) => (/^\s*(\/\/|\/?\*)/.test(line) ? "" : line))
    .join("\n");
  const signals = [...text.matchAll(/const (\w+) = deadline\(/g)].map((m) => m[1]);
  const aliases = [...text.matchAll(/const (\w+) = [^;\n]*\?\? fetch\b/g)].map((m) => m[1]);
  const callers = ["fetch", ...aliases].map((name) => `(?<![\\w.])${name}\\(`);
  const pattern = new RegExp(
    [...callers, String.raw`\.send\(\s*new \w+Command\(`, String.raw`new WebClient\(`].join("|"),
    "g",
  );
  return [...text.matchAll(pattern)].map((m) => {
    const open = m.index + m[0].indexOf("(");
    return {
      file,
      line: text.slice(0, m.index).split("\n").length,
      call: m[0],
      span: argumentsAt(text, open),
      signals,
    };
  });
};

const bounded = (site: Site): boolean => {
  if (site.call.startsWith("new WebClient")) return site.span.includes("DEADLINES.");
  return (
    site.span.includes("deadline(") ||
    site.signals.some((name) => new RegExp(`[sS]ignal: ${name}\\b`).test(site.span))
  );
};

const allowedFor = (site: Site): Allowed | undefined =>
  ALLOWED.find((a) => a.file === site.file && site.span.includes(a.bound));

const scan = () => {
  const sites = sourceFiles(join(ROOT, "bugboss")).flatMap((path) =>
    sitesIn(relative(ROOT, path), readFileSync(path, "utf8")),
  );
  return {
    sites,
    unbounded: sites.filter((s) => !bounded(s) && !allowedFor(s)),
  };
};

describe("every outbound call has a deadline", () => {
  test("no fetch, AWS send or WebClient in bugboss is without a deadline", () => {
    const { unbounded } = scan();
    assert.deepEqual(
      unbounded.map((s) => `${s.file}:${s.line} ${s.call}`),
      [],
      "route each through bugboss/deadline.ts, or add it to ALLOWED with the bound it already carries",
    );
  });

  test("the scan sees the sites it is meant to", () => {
    const { sites } = scan();
    const where = (file: string) => sites.filter((s) => s.file === file).length;
    assert.ok(where("bugboss/agent/run.ts") >= 2, "the tool-API calls go through an injected alias of fetch");
    assert.ok(where("bugboss/http/toolapi.ts") >= 1);
    assert.ok(where("bugboss/db/index.ts") >= 2);
    assert.ok(where("bugboss/slack/client.ts") >= 6);
  });

  test("every allowlist entry still names a live site", () => {
    const { sites } = scan();
    const stale = ALLOWED.filter((a) => !sites.some((s) => !bounded(s) && allowedFor(s) === a));
    assert.deepEqual(stale.map((a) => `${a.file} (${a.bound})`), []);
  });

  test("an unbounded call is caught, however it is spelled", () => {
    const found = (source: string) =>
      sitesIn("x.ts", source).filter((s) => !bounded(s)).map((s) => s.call.trim());
    assert.deepEqual(found(`const r = await fetch(url, { method: "GET" });`), ["fetch("]);
    assert.deepEqual(found(`const http = deps.fetchImpl ?? fetch;\nawait http(url, {\n  method,\n});`), ["http("]);
    assert.deepEqual(found(`await s3.send(\n  new PutObjectCommand({ Bucket }),\n);`).length, 1);
    assert.deepEqual(found(`const web = new WebClient(token, { retryConfig });`), ["new WebClient("]);
    assert.deepEqual(found(`await fetch(url, { signal: deadline("github") });`), []);
    assert.deepEqual(found(`const signal = deadline("dbRestore");\nawait s3.send(new GetObjectCommand({}), { abortSignal: signal });`), []);
    assert.deepEqual(found(`const signal = other();\nawait s3.send(new GetObjectCommand({}), { abortSignal: signal });`).length, 1);
    assert.deepEqual(found(`// a thrown fetch(url) in prose\napp.fetch(req);`), []);
  });
});

describe("beforeDeadline", () => {
  test("rejects a body read that outlives the deadline", async () => {
    // AbortSignal.timeout's timer does not hold the process open, and nothing
    // else here would.
    const held = setTimeout(() => {}, 1_000);
    const stalled = new Promise<string>(() => {});
    await assert.rejects(beforeDeadline(deadline("slackStore", 20), stalled), { name: "TimeoutError" });
    clearTimeout(held);
  });

  test("passes a read that finishes in time straight through", async () => {
    assert.equal(await beforeDeadline(deadline("slackStore", 1_000), Promise.resolve("ok")), "ok");
  });
});
