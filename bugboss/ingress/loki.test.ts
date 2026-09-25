// The Loki client's request, not its parsing. linesFrom is covered with the
// rest of the adapter; what is covered here is the URL and the header.
//
// This is worth its own file because the caller in prefetch catches every
// failure and turns it into "EVIDENCE UNAVAILABLE", by design. That is the
// right behaviour for a Loki that is down, but it also means a wrong proxy
// path or a wrong auth scheme degrades silently forever and looks exactly
// like an alert with nothing to say about it. The request shape is the part
// nothing downstream can notice being wrong.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_GRAFANA_URL,
  DEFAULT_LOKI_DATASOURCE_UID,
  createLokiQuery,
} from "./grafana";

interface Captured {
  url: URL;
  headers: Record<string, string>;
}

/** Runs one query against a stubbed fetch and returns what it sent. */
const capture = async (
  env: NodeJS.ProcessEnv,
  body: unknown = { data: { resultType: "streams", result: [] } },
  status = 200,
): Promise<Captured> => {
  const original = globalThis.fetch;
  let seen: Captured | undefined;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    seen = {
      url: new URL(String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await createLokiQuery(env)('{app="x"}', {
      start: 1_700_000_000_000,
      end: 1_700_000_060_000,
      limit: 10,
    });
  } finally {
    globalThis.fetch = original;
  }
  if (!seen) throw new Error("fetch was never called");
  return seen;
};

test("queries Loki through the Grafana datasource proxy", async () => {
  const sent = await capture({ GRAFANA_SERVICE_ACCOUNT_TOKEN: "sa-token" });

  assert.equal(sent.url.origin, DEFAULT_GRAFANA_URL);
  assert.equal(
    sent.url.pathname,
    `/api/datasources/proxy/uid/${DEFAULT_LOKI_DATASOURCE_UID}/loki/api/v1/query_range`,
    "the path after the proxy prefix is the Loki API verbatim",
  );
});

test("authenticates with the service account token as a bearer", async () => {
  const sent = await capture({ GRAFANA_SERVICE_ACCOUNT_TOKEN: "sa-token" });

  assert.equal(sent.headers.authorization, "Bearer sa-token");
  assert.equal(
    sent.headers.accept,
    "application/json",
    "the proxy content-negotiates, so this is not optional",
  );
});

test("honours an overridden Grafana url and datasource uid", async () => {
  const sent = await capture({
    GRAFANA_SERVICE_ACCOUNT_TOKEN: "sa-token",
    // Trailing slash on purpose: the base is concatenated, so a stray one
    // produces a double slash the proxy does not route.
    GRAFANA_URL: "https://other.grafana.net/",
    LOKI_DATASOURCE_UID: "other-logs",
  });

  assert.equal(sent.url.origin, "https://other.grafana.net");
  assert.equal(
    sent.url.pathname,
    "/api/datasources/proxy/uid/other-logs/loki/api/v1/query_range",
  );
});

test("sends the window in nanoseconds, newest first", async () => {
  const sent = await capture({ GRAFANA_SERVICE_ACCOUNT_TOKEN: "sa-token" });

  assert.equal(sent.url.searchParams.get("query"), '{app="x"}');
  assert.equal(sent.url.searchParams.get("start"), "1700000000000000000");
  assert.equal(sent.url.searchParams.get("end"), "1700000060000000000");
  assert.equal(sent.url.searchParams.get("limit"), "10");
  assert.equal(sent.url.searchParams.get("direction"), "backward");
});

test("refuses to run without a service account token", async () => {
  await assert.rejects(
    () =>
      createLokiQuery({})('{app="x"}', { start: 0, end: 1, limit: 1 }),
    /not configured/,
    "a missing credential is a configuration fault, not an empty result",
  );
});

test("reports the status and never the body on an error", async () => {
  // A Loki error body echoes the query back, and the query is registry text
  // that reaches a model prompt downstream.
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('{"error":"parse error at {app=\\"x\\"}"}', {
      status: 400,
    })) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        createLokiQuery({ GRAFANA_SERVICE_ACCOUNT_TOKEN: "t" })('{app="x"}', {
          start: 0,
          end: 1,
          limit: 1,
        }),
      (err: Error) => {
        assert.match(err.message, /HTTP 400/);
        assert.doesNotMatch(err.message, /parse error/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});
