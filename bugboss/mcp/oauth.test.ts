import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { OAuthError } from "@modelcontextprotocol/server";
import { assertWorkspaceIdentity } from "./google";
import { createMcpServer } from "./index";
import type { Db } from "../db";
import {
  CLIENT_ID,
  type FakeGoogle,
  MCP_URL,
  PUBLIC_URL,
  REDIRECT_URI,
  fakeGoogle,
  jsonRpcResult,
  modernRequest,
  openTestDb,
  pkcePair,
  recordingReporter,
  stubFetch,
  stubSessions,
  testConfig,
} from "./fixtures";
import type { GoogleIdClaims } from "./google";

const config = testConfig();
const openDbs: Db[] = [];

const cimd = stubFetch({
  [CLIENT_ID]: {
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_name: "Claude Code",
      redirect_uris: [REDIRECT_URI],
    }),
  },
});

const harness = async (claims: Partial<GoogleIdClaims> = {}) => {
  const db = await openTestDb([{ id: "inc-1", status: "INVESTIGATING" }]);
  openDbs.push(db);
  const google = fakeGoogle(claims);
  const server = createMcpServer({
    config,
    db,
    sessions: stubSessions(),
    reportSignal: recordingReporter().reportSignal,
    google,
    fetchImpl: cimd,
  });
  return { server, google };
};

const authorizeUrl = (
  params: Record<string, string>,
  challenge: string,
): string => {
  const url = new URL(`${PUBLIC_URL}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "client-state-abc");
  url.searchParams.set("resource", MCP_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  return url.toString();
};

/** /authorize then /callback, returning our authorization code. */
const loginTo = async (
  server: Awaited<ReturnType<typeof harness>>["server"],
  google: FakeGoogle,
  challenge: string,
  overrides: Record<string, string> = {},
) => {
  const authorized = await server.fetch(
    new Request(authorizeUrl(overrides, challenge)),
  );
  assert.equal(authorized.status, 302, await authorized.text());
  const toGoogle = new URL(authorized.headers.get("location")!);

  const callback = await server.fetch(
    new Request(
      `${PUBLIC_URL}/callback?code=google-code&state=${encodeURIComponent(
        toGoogle.searchParams.get("state")!,
      )}`,
    ),
  );
  return { authorized, toGoogle, callback, google };
};

const tokenRequest = (form: Record<string, string>) =>
  new Request(`${PUBLIC_URL}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });

after(() => {
  for (const db of openDbs) db.close();
});

describe("the authorization code flow", () => {
  it("carries an engineer from /authorize to a working MCP call", async () => {
    const { server, google } = await harness();
    const { verifier, challenge } = pkcePair();

    const { toGoogle, callback } = await loginTo(server, google, challenge);

    // /authorize hands the browser to Google with our callback and a nonce.
    assert.equal(toGoogle.host, "accounts.google.test");
    assert.equal(
      toGoogle.searchParams.get("redirect_uri"),
      `${PUBLIC_URL}/callback`,
    );
    assert.equal(toGoogle.searchParams.get("hd"), "goodparty.org");
    assert.ok(toGoogle.searchParams.get("nonce"));

    // /callback sends the browser back to the client with our own code.
    assert.equal(callback.status, 302);
    const back = new URL(callback.headers.get("location")!);
    assert.equal(back.origin + back.pathname, REDIRECT_URI);
    assert.equal(back.searchParams.get("state"), "client-state-abc");
    assert.equal(back.searchParams.get("iss"), PUBLIC_URL);
    const code = back.searchParams.get("code");
    assert.ok(code);

    const tokenRes = await server.fetch(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        resource: MCP_URL,
      }),
    );
    assert.equal(tokenRes.status, 200);
    const issued = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      scope: string;
    };
    assert.equal(issued.token_type, "Bearer");
    assert.equal(issued.scope, "mcp");

    const mcpRes = await server.fetch(
      modernRequest({ method: "tools/list", token: issued.access_token }),
    );
    assert.equal(mcpRes.status, 200);
    const body = await jsonRpcResult(mcpRes);
    assert.ok(Array.isArray(body.result?.tools));
    await server.close();
  });

  it("tolerates the offline_access scope Claude Code appends", async () => {
    const { server, google } = await harness();
    const { verifier, challenge } = pkcePair();

    const { callback } = await loginTo(server, google, challenge, {
      scope: "mcp offline_access",
    });
    assert.equal(callback.status, 302);

    const code = new URL(callback.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const tokenRes = await server.fetch(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
      }),
    );

    assert.equal(tokenRes.status, 200);
    // Advertised so it is not an unknown scope, never granted.
    assert.equal(((await tokenRes.json()) as { scope: string }).scope, "mcp");
    await server.close();
  });

  it("refuses a replayed authorization code", async () => {
    const { server, google } = await harness();
    const { verifier, challenge } = pkcePair();
    const { callback } = await loginTo(server, google, challenge);
    const code = new URL(callback.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const form = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    };

    assert.equal((await server.fetch(tokenRequest(form))).status, 200);

    const replay = await server.fetch(tokenRequest(form));
    assert.equal(replay.status, 400);
    assert.equal(((await replay.json()) as { error: string }).error, "invalid_grant");
    await server.close();
  });

  it("refuses a code redeemed with the wrong PKCE verifier", async () => {
    const { server, google } = await harness();
    const { challenge } = pkcePair();
    const { callback } = await loginTo(server, google, challenge);
    const code = new URL(callback.headers.get("location")!).searchParams.get(
      "code",
    )!;

    const res = await server.fetch(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: pkcePair().verifier,
      }),
    );

    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_grant");
    await server.close();
  });
});

describe("the Workspace restriction", () => {
  // Each claim is checked on its own, so each one alone is enough to refuse.
  const cases: { name: string; claims: Partial<GoogleIdClaims> }[] = [
    { name: "hd names another domain", claims: { hd: "evil.example" } },
    { name: "hd is absent entirely", claims: { hd: undefined } },
    {
      name: "email_verified is false",
      claims: { email_verified: false },
    },
    {
      name: "email_verified is absent",
      claims: { email_verified: undefined },
    },
    {
      name: "email is on another domain",
      claims: { email: "engineer@evil.example" },
    },
  ];

  for (const { name, claims } of cases) {
    it(`fails closed when ${name}`, async () => {
      const { server, google } = await harness(claims);
      const { challenge } = pkcePair();

      const { callback } = await loginTo(server, google, challenge);

      assert.equal(callback.status, 302);
      const back = new URL(callback.headers.get("location")!);
      assert.equal(back.origin + back.pathname, REDIRECT_URI);
      assert.equal(back.searchParams.get("error"), "access_denied");
      assert.equal(back.searchParams.get("code"), null);
      await server.close();
    });
  }

  it("accepts only all three together", () => {
    const good: GoogleIdClaims = {
      sub: "s",
      hd: "goodparty.org",
      email_verified: true,
      email: "a@goodparty.org",
    };
    assert.equal(
      assertWorkspaceIdentity(good, "goodparty.org").email,
      "a@goodparty.org",
    );

    // An unverified email on a domain-looking address is the bypass the
    // email_verified check exists to close.
    assert.throws(
      () =>
        assertWorkspaceIdentity(
          { ...good, hd: undefined, email_verified: false },
          "goodparty.org",
        ),
      OAuthError,
    );
  });

  it("refuses an id_token whose nonce does not match the flow", async () => {
    const { server, google } = await harness({ nonce: "not-the-one" });
    const { challenge } = pkcePair();

    const { callback } = await loginTo(server, google, challenge);

    const back = new URL(callback.headers.get("location")!);
    assert.equal(back.searchParams.get("error"), "access_denied");
    await server.close();
  });

  it("refuses a tampered state on the way back", async () => {
    const { server } = await harness();

    const res = await server.fetch(
      new Request(`${PUBLIC_URL}/callback?code=x&state=not-a-jwt`),
    );

    assert.equal(res.status, 400);
    await server.close();
  });
});

describe("/authorize input checks", () => {
  it("renders rather than redirects when the redirect_uri is not registered", async () => {
    const { server } = await harness();
    const { challenge } = pkcePair();

    const res = await server.fetch(
      new Request(
        authorizeUrl({ redirect_uri: "https://attacker.example/steal" }, challenge),
      ),
    );

    // Redirecting an unvalidated redirect_uri would be an open redirect.
    assert.equal(res.status, 400);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "invalid_redirect_uri",
    );
    await server.close();
  });

  it("refuses an unknown client_id", async () => {
    const { server } = await harness();
    const { challenge } = pkcePair();

    const res = await server.fetch(
      new Request(authorizeUrl({ client_id: "who-is-this" }, challenge)),
    );

    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_client");
    await server.close();
  });

  it("resolves a pre-registered client without any CIMD fetch", async () => {
    const { server } = await harness();
    const { challenge } = pkcePair();

    const res = await server.fetch(
      new Request(
        authorizeUrl(
          {
            client_id: "cli-client",
            redirect_uri: "http://127.0.0.1:9999/callback",
          },
          challenge,
        ),
      ),
    );

    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /accounts\.google\.test/);
    await server.close();
  });

  it("requires PKCE with S256", async () => {
    const { server } = await harness();
    const { challenge } = pkcePair();

    const overrides: Record<string, string>[] = [
      { code_challenge: "" },
      { code_challenge_method: "plain" },
    ];
    for (const override of overrides) {
      const res = await server.fetch(
        new Request(authorizeUrl(override, challenge)),
      );
      assert.equal(res.status, 302);
      const back = new URL(res.headers.get("location")!);
      assert.equal(back.origin + back.pathname, REDIRECT_URI);
      assert.equal(back.searchParams.get("error"), "invalid_request");
    }
    await server.close();
  });

  it("refuses a resource that is not this MCP server", async () => {
    const { server } = await harness();
    const { challenge } = pkcePair();

    const res = await server.fetch(
      new Request(
        authorizeUrl({ resource: "https://someone-else.test/mcp" }, challenge),
      ),
    );

    const back = new URL(res.headers.get("location")!);
    assert.equal(back.searchParams.get("error"), "invalid_target");
    await server.close();
  });

  it("refuses a response_type other than code", async () => {
    const { server } = await harness();
    const { challenge } = pkcePair();

    const res = await server.fetch(
      new Request(authorizeUrl({ response_type: "token" }, challenge)),
    );

    const back = new URL(res.headers.get("location")!);
    assert.equal(back.searchParams.get("error"), "unsupported_response_type");
    await server.close();
  });
});

describe("/token input checks", () => {
  it("refuses a grant type other than authorization_code", async () => {
    const { server } = await harness();

    const res = await server.fetch(
      tokenRequest({ grant_type: "client_credentials" }),
    );

    assert.equal(res.status, 400);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "unsupported_grant_type",
    );
    await server.close();
  });

  it("refuses an access token presented as an authorization code", async () => {
    const { server } = await harness();

    const res = await server.fetch(
      tokenRequest({
        grant_type: "authorization_code",
        code: "nonsense",
        code_verifier: "nonsense",
      }),
    );

    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_grant");
    await server.close();
  });
});
