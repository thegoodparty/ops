import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as http from "node:http";
import * as path from "node:path";

/**
 * The claim script, run against a stub of the two endpoints it uses. Phase 2
 * item 11 of `docs/bifrost-gateway.md`.
 *
 * The script is shell, so this exercises it as the container does: a real
 * process, real curl and jq, a real PUT. What it pins is the part that would
 * be destructive if it drifted — that the payload sent back is the server's own
 * config with `auth_config` added and nothing else changed — plus the two
 * properties that are reasons the container exists at all: a claimed instance
 * is a no-op, and the credential never reaches stdout or stderr.
 */

const SCRIPT = path.resolve(__dirname, "bifrost/bootstrap.sh");
const TOKEN = "setup-token-for-the-test";
const USERNAME = "bifrost-admin";
const PASSWORD = "test-admin-password-Aa1!";

type RecordedRequest = {
  method: string;
  url: string;
  token: string;
  body: string;
};

type StubState = {
  config: Record<string, unknown>;
  authActive: boolean;
  setupTokenConfigured?: boolean;
  putStatus?: number;
};

type BootstrapResult = {
  status: number | null;
  output: string;
};

const runBootstrap = (baseUrl: string): Promise<BootstrapResult> =>
  new Promise((resolve, reject) => {
    // spawn, not spawnSync: the stub server runs on this event loop, and a
    // synchronous child would block the responses the script is waiting for.
    const child = spawn("sh", [SCRIPT], {
      env: {
        ...process.env,
        BIFROST_API_BASE_URL: baseUrl,
        BIFROST_SETUP_TOKEN: TOKEN,
        BIFROST_ADMIN_USERNAME: USERNAME,
        BIFROST_ADMIN_PASSWORD: PASSWORD,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, output }));
  });

/**
 * Starts a stub that behaves like the pinned tag where the script can see it:
 * `is-auth-enabled` reports the setup lock, `GET /api/config` returns the
 * stored view, and `PUT /api/config` accepts the payload and lifts the lock.
 */
const withStubBifrost = async (
  state: StubState,
  run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>,
): Promise<void> => {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        token: String(request.headers["x-bifrost-setup-token"] ?? ""),
        body,
      });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/session/is-auth-enabled") {
        response.end(
          JSON.stringify({
            is_auth_enabled: state.authActive,
            setup_required: !state.authActive,
            setup_token_configured: state.setupTokenConfigured ?? true,
            has_valid_token: false,
            auth_type: state.authActive ? "session" : "none",
            inference_auth_enforced: true,
          }),
        );
        return;
      }
      if (request.url === "/api/config" && request.method === "GET") {
        response.end(JSON.stringify(state.config));
        return;
      }
      if (request.url === "/api/config" && request.method === "PUT") {
        if (state.putStatus && state.putStatus !== 200) {
          response.statusCode = state.putStatus;
          response.end(JSON.stringify({ error: "rejected" }));
          return;
        }
        state.config = JSON.parse(body) as Record<string, unknown>;
        state.authActive = true;
        response.end(JSON.stringify({}));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object", "the stub did not bind");
  try {
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

/** The config the server returns on a fresh instance: no `auth_config` yet. */
const freshConfig = () => ({
  client_config: {
    enforce_auth_on_inference: true,
    allowed_origins: ["https://bifrost.workbench.goodparty.org"],
    drop_excess_requests: false,
    log_retention_days: 90,
  },
  framework_config: {
    pricing_url: "https://example.test/pricing.json",
    model_parameters_url: "https://example.test/parameters.json",
  },
  // Not part of this endpoint's real response; it is here so the test proves
  // the script does not rebuild the body from a shape it expects.
  providers: { fireworks: { keys: [{ name: "fireworks-primary" }] } },
  is_db_connected: true,
});

describe("bifrost bootstrap claim", () => {
  it("creates the first admin account without changing anything else", async () => {
    await withStubBifrost(
      { config: freshConfig(), authActive: false },
      async (baseUrl, requests) => {
        const result = await runBootstrap(baseUrl);
        assert.equal(result.status, 0, result.output);

        const put = requests.find(
          (request) => request.method === "PUT" && request.url === "/api/config",
        );
        assert.ok(put, "the claim did not PUT /api/config");
        assert.equal(put.token, TOKEN, "the PUT must carry the setup token");

        const sent = JSON.parse(put.body) as Record<string, unknown>;
        assert.deepEqual(sent.auth_config, {
          admin_username: USERNAME,
          admin_password: PASSWORD,
          is_enabled: true,
        });

        // The round-trip is the point: everything the server returned is sent
        // back untouched, so a claim cannot drop the client or framework
        // config the store holds.
        const { auth_config: _authConfig, ...withoutAuthConfig } = sent;
        assert.deepEqual(withoutAuthConfig, freshConfig());
      },
    );
  });

  it("never prints the admin password or the setup token", async () => {
    await withStubBifrost(
      { config: freshConfig(), authActive: false },
      async (baseUrl) => {
        const result = await runBootstrap(baseUrl);
        assert.equal(result.status, 0, result.output);
        assert.ok(!result.output.includes(PASSWORD), result.output);
        assert.ok(!result.output.includes(TOKEN), result.output);
      },
    );
  });

  it("is a no-op once dashboard auth is active", async () => {
    await withStubBifrost(
      { config: freshConfig(), authActive: true },
      async (baseUrl, requests) => {
        const result = await runBootstrap(baseUrl);
        assert.equal(result.status, 0, result.output);
        assert.deepEqual(
          requests.map((request) => `${request.method} ${request.url}`),
          ["GET /api/session/is-auth-enabled"],
          "a claimed instance must not be written to again",
        );
      },
    );
  });

  it("fails, without writing, when no setup token reached the process", async () => {
    await withStubBifrost(
      {
        config: freshConfig(),
        authActive: false,
        setupTokenConfigured: false,
      },
      async (baseUrl, requests) => {
        const result = await runBootstrap(baseUrl);
        assert.notEqual(result.status, 0);
        assert.ok(
          !requests.some((request) => request.method === "PUT"),
          "a locked instance with no token must not be written to",
        );
      },
    );
  });

  it("leaves an existing admin account with auth disabled alone", async () => {
    // Re-enabling auth is a deliberate act that needs current_password or the
    // setup token as proof; a machine loop must not flip the switch back on.
    const config = {
      ...freshConfig(),
      auth_config: {
        admin_username: { value: USERNAME },
        admin_password: { value: "<redacted>" },
        is_enabled: false,
      },
    };
    await withStubBifrost(
      { config, authActive: false },
      async (baseUrl, requests) => {
        const result = await runBootstrap(baseUrl);
        assert.equal(result.status, 0, result.output);
        assert.ok(
          !requests.some((request) => request.method === "PUT"),
          "the claim must not re-enable dashboard auth",
        );
        assert.ok(result.output.includes("leaving it alone"), result.output);
      },
    );
  });

  it("fails when the server rejects the claim", async () => {
    await withStubBifrost(
      { config: freshConfig(), authActive: false, putStatus: 500 },
      async (baseUrl) => {
        const result = await runBootstrap(baseUrl);
        assert.notEqual(result.status, 0);
        assert.ok(result.output.includes("500"), result.output);
      },
    );
  });
});
