import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { OAuthError } from "@modelcontextprotocol/server";
import { createMcpServer } from "./index";
import { serveMcp } from "./serve";
import { createTokenService } from "./tokens";
import type { Db } from "../db";
import {
  MCP_URL,
  PUBLIC_URL,
  jsonRpcResult,
  modernRequest,
  openTestDb,
  recordingReporter,
  stubSessions,
  testConfig,
  toolPayload,
} from "./fixtures";

const config = testConfig();
const tokens = createTokenService(config);

const validToken = tokens.mintAccessToken({
  identity: { sub: "google-sub-1", email: "engineer@goodparty.org" },
  clientId: "cli-client",
  scopes: ["mcp"],
}).token;

const noScopeToken = tokens.mintAccessToken({
  identity: { sub: "google-sub-1", email: "engineer@goodparty.org" },
  clientId: "cli-client",
  scopes: ["something-else"],
}).token;

const openDbs: Db[] = [];

const harness = async (
  opts: {
    sessions?: ReturnType<typeof stubSessions>;
    reporter?: ReturnType<typeof recordingReporter>;
  } = {},
) => {
  const db = await openTestDb([
    { id: "inc-1", status: "INVESTIGATING", usersImpacted: 12 },
    { id: "inc-2", status: "FIXING", rootCause: "bad migration" },
    { id: "inc-3", status: "CLOSED" },
  ]);
  openDbs.push(db);
  const reporter = opts.reporter ?? recordingReporter();
  const server = createMcpServer({
    config,
    db,
    sessions: opts.sessions ?? stubSessions(),
    reportSignal: reporter.reportSignal,
  });
  return { db, server, reporter };
};

const callTool = async (
  server: Awaited<ReturnType<typeof harness>>["server"],
  name: string,
  args: Record<string, unknown>,
) => {
  const res = await server.fetch(
    modernRequest({
      method: "tools/call",
      params: { name, arguments: args },
      token: validToken,
    }),
  );
  assert.equal(res.status, 200);
  const body = await jsonRpcResult(res);
  assert.ok(body.result, `expected a result, got ${JSON.stringify(body.error)}`);
  return body.result!;
};

after(() => {
  for (const db of openDbs) db.close();
});

describe("the MCP endpoint", () => {
  it("refuses an unauthenticated POST with a 401 and a usable challenge", async () => {
    const { server } = await harness();

    const res = await server.fetch(modernRequest({ method: "tools/list" }));

    assert.equal(res.status, 401);
    const challenge = res.headers.get("www-authenticate");
    assert.ok(challenge, "no WWW-Authenticate header");
    assert.match(challenge, /^Bearer /);
    assert.match(challenge, /error="invalid_token"/);
    // Without resource_metadata the client cannot find the authorization
    // server and the OAuth flow never starts.
    assert.match(
      challenge,
      /resource_metadata="https:\/\/bugboss\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
    await server.close();
  });

  it("refuses a token that lacks the mcp scope", async () => {
    const { server } = await harness();

    const res = await server.fetch(
      modernRequest({ method: "tools/list", token: noScopeToken }),
    );

    assert.equal(res.status, 403);
    assert.match(res.headers.get("www-authenticate") ?? "", /insufficient_scope/);
    await server.close();
  });

  it("answers GET and DELETE with 405", async () => {
    const { server } = await harness();

    for (const method of ["GET", "DELETE"]) {
      const res = await server.fetch(new Request(MCP_URL, { method }));
      assert.equal(res.status, 405, `${method} should be 405`);
      assert.equal(res.headers.get("allow"), "POST");
    }
    await server.close();
  });

  it("answers server/discover with no prior handshake", async () => {
    const { server } = await harness();

    const res = await server.fetch(
      modernRequest({ method: "server/discover", token: validToken }),
    );

    assert.equal(res.status, 200);
    const body = await jsonRpcResult(res);
    assert.deepEqual(body.result?.supportedVersions, ["2026-07-28"]);
    assert.ok(body.result?.capabilities);
    await server.close();
  });

  it("lists every tool without an initialize", async () => {
    const { server } = await harness();

    const res = await server.fetch(
      modernRequest({ method: "tools/list", token: validToken }),
    );

    const body = await jsonRpcResult(res);
    const names = (body.result?.tools as { name: string }[]).map((t) => t.name);
    assert.deepEqual(names.sort(), [
      "get_incident",
      "list_open_incidents",
      "query_incidents",
      "read_agent_session",
      "report_signal",
    ]);
    await server.close();
  });

  it("never opens a subscriptions/listen stream", async () => {
    const { server } = await harness();

    const res = await server.fetch(
      modernRequest({ method: "subscriptions/listen", token: validToken }),
    );

    const body = await jsonRpcResult(res);
    assert.equal(body.result, undefined);
    assert.match(body.error?.message ?? "", /Subscription limit reached/);
    await server.close();
  });
});

describe("the tools", () => {
  it("reads one incident with its signals", async () => {
    const { server } = await harness();

    const payload = toolPayload(
      await callTool(server, "get_incident", { incidentId: "inc-1" }),
    );

    const incident = payload.incident as Record<string, unknown>;
    assert.equal(incident.id, "inc-1");
    assert.equal(incident.usersImpacted, 12);
    assert.deepEqual(incident.prUrls, []);
    assert.equal((payload.signals as unknown[]).length, 1);
    await server.close();
  });

  it("reports a missing incident as a tool error, not a protocol error", async () => {
    const { server } = await harness();

    const result = await callTool(server, "get_incident", {
      incidentId: "nope",
    });

    assert.equal(result.isError, true);
    await server.close();
  });

  it("lists open incidents and leaves out the closed one", async () => {
    const { server } = await harness();

    const payload = (await callTool(server, "list_open_incidents", {})) as {
      content: { text: string }[];
    };
    const rows = JSON.parse(payload.content[0].text) as { id: string }[];

    assert.deepEqual(
      rows.map((r) => r.id).sort(),
      ["inc-1", "inc-2"],
    );
    await server.close();
  });

  it("runs read-only SQL", async () => {
    const { server } = await harness();

    const payload = toolPayload(
      await callTool(server, "query_incidents", {
        sql: "SELECT id, status FROM incident WHERE status = ?",
        params: ["FIXING"],
      }),
    );

    assert.equal(payload.rowCount, 1);
    assert.deepEqual(payload.rows, [{ id: "inc-2", status: "FIXING" }]);
    await server.close();
  });

  it("refuses a write through the SQL tool", async () => {
    const { server } = await harness();

    const plain = await callTool(server, "query_incidents", {
      sql: "DELETE FROM incident",
    });
    assert.equal(plain.isError, true);

    // RETURNING is the case that actually reaches SQLite, so this is the one
    // that proves the read-only connection is what stops a write.
    const returning = await callTool(server, "query_incidents", {
      sql: "DELETE FROM incident RETURNING id",
    });
    assert.equal(returning.isError, true);
    assert.match(
      (returning.content as { text: string }[])[0].text,
      /readonly database/i,
    );
    await server.close();
  });

  it("returns the tail of an agent session", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const { server } = await harness({
      sessions: stubSessions({
        "inc-1": {
          incidentId: "inc-1",
          key: "sessions/incident/inc-1/session.jsonl",
          updatedAt: 1_700_000_000_000,
          sizeBytes: 4096,
          content: lines.join("\n"),
        },
      }),
    });

    const payload = toolPayload(
      await callTool(server, "read_agent_session", {
        incidentId: "inc-1",
        tailLines: 3,
      }),
    );

    assert.equal(payload.totalLines, 200);
    assert.equal(payload.tail, "line 197\nline 198\nline 199");
    await server.close();
  });

  it("says so when there is no session yet", async () => {
    const { server } = await harness();

    const result = await callTool(server, "read_agent_session", {
      incidentId: "inc-1",
    });

    assert.equal(result.isError, true);
    await server.close();
  });

  it("files a human bug report attributed to the caller", async () => {
    const reporter = recordingReporter({
      signalId: "sig-99",
      incidentId: "inc-2",
    });
    const { server } = await harness({ reporter });

    const payload = toolPayload(
      await callTool(server, "report_signal", {
        title: "Pro upgrades look broken",
        body: "Checkout 500s on the confirm step.",
      }),
    );

    assert.equal(payload.signalId, "sig-99");
    assert.equal(payload.incidentId, "inc-2");

    assert.equal(reporter.filed.length, 1);
    const filed = reporter.filed[0];
    assert.equal(filed.via, "mcp");
    // Attribution comes from the bearer token, never the tool arguments.
    assert.equal(filed.reportedBy, "engineer@goodparty.org");
    // The adapter takes the title from the first line.
    assert.equal(
      filed.text,
      "Pro upgrades look broken\n\nCheckout 500s on the confirm step.",
    );
    await server.close();
  });
});

describe("the discovery documents", () => {
  it("serves RFC 9728 protected resource metadata", async () => {
    const { server } = await harness();

    const res = await server.fetch(
      new Request(`${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`),
    );

    assert.equal(res.status, 200);
    const doc = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    assert.equal(doc.resource, MCP_URL);
    assert.deepEqual(doc.authorization_servers, [PUBLIC_URL]);
    await server.close();
  });

  it("serves our own authorization server metadata", async () => {
    const { server } = await harness();

    const res = await server.fetch(
      new Request(`${PUBLIC_URL}/.well-known/oauth-authorization-server`),
    );

    assert.equal(res.status, 200);
    const doc = (await res.json()) as Record<string, unknown>;
    assert.equal(doc.issuer, PUBLIC_URL);
    assert.equal(doc.authorization_endpoint, `${PUBLIC_URL}/authorize`);
    assert.equal(doc.token_endpoint, `${PUBLIC_URL}/token`);
    assert.deepEqual(doc.code_challenge_methods_supported, ["S256"]);
    assert.equal(doc.client_id_metadata_document_supported, true);
    // DCR stays off: deprecated, and an unauthenticated write endpoint.
    assert.equal(doc.registration_endpoint, undefined);
    await server.close();
  });
});

describe("the standalone listener", () => {
  // Automates check A: the 401 challenge has to survive a real HTTP hop
  // spelled `WWW-Authenticate`, or OAuth discovery never starts.
  it("serves the challenge over real HTTP", async () => {
    const db = await openTestDb();
    openDbs.push(db);
    const { mcp, server } = serveMcp({
      config,
      db,
      sessions: stubSessions(),
      reportSignal: recordingReporter().reportSignal,
      port: 0,
      hostname: "127.0.0.1",
    });
    if (!server.listening) {
      await new Promise<void>((resolve) =>
        server.once("listening", () => resolve()),
      );
    }
    const { port } = server.address() as AddressInfo;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

      assert.equal(res.status, 401);
      const challenge = res.headers.get("www-authenticate");
      assert.ok(challenge, "WWW-Authenticate did not survive the HTTP hop");
      assert.match(challenge, /resource_metadata="/);

      const notAllowed = await fetch(`http://127.0.0.1:${port}/mcp`);
      assert.equal(notAllowed.status, 405);
      assert.equal(notAllowed.headers.get("allow"), "POST");
    } finally {
      server.close();
      await mcp.close();
    }
  });
});

describe("the token verifier", () => {
  it("throws OAuthError rather than Error, so the gate can answer 401", async () => {
    await assert.rejects(
      () => tokens.verifyAccessToken("not-a-jwt"),
      (err: unknown) => {
        // A plain Error would produce a 500, and a 500 never triggers Claude
        // Code's OAuth flow.
        assert.ok(OAuthError.isInstance(err), "verifier threw a plain Error");
        assert.equal((err as OAuthError).code, "invalid_token");
        return true;
      },
    );
  });

  it("refuses a token signed with another secret", async () => {
    const other = createTokenService(testConfig({ jwtSecret: "different" }));
    const foreign = other.mintAccessToken({
      identity: { sub: "x", email: "engineer@goodparty.org" },
      clientId: "cli-client",
      scopes: ["mcp"],
    }).token;

    await assert.rejects(() => tokens.verifyAccessToken(foreign), OAuthError);
  });

  it("refuses a token minted for a different audience", async () => {
    const elsewhere = createTokenService(
      testConfig({ publicUrl: "https://elsewhere.test" }),
    );
    const foreign = elsewhere.mintAccessToken({
      identity: { sub: "x", email: "engineer@goodparty.org" },
      clientId: "cli-client",
      scopes: ["mcp"],
    }).token;

    await assert.rejects(() => tokens.verifyAccessToken(foreign), OAuthError);
  });
});
