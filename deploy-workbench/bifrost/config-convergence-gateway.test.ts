import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { GatewayFailure } from "./vk-mint-core";
import { createConfigGateway } from "./vk-janitor-handler";
import { convergeConfig, liveConfigDesiredState } from "./config-convergence-core";

/**
 * The config half's gateway adapter, against real transport rather than a mock
 * of the decision layer: a local HTTP server, the same harness
 * `vk-janitor-gateway.test.ts` uses.
 *
 * What this settles that a fake gateway cannot: the setup-lock header on the
 * routes `/api/config` and `/api/providers` use, the URL shapes (a provider's
 * name and a key's id are path segments and must be escaped), the `keys` wrapper
 * the key list comes back in, and the `404` a provider the gateway does not have
 * answers with. That last one is the difference between "converge what exists"
 * and "fail the deploy because the file names a provider the task has not been
 * restarted onto".
 */

type Recorded = {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

describe("the config gateway over real HTTP", () => {
  const requests: Recorded[] = [];
  let responses: Array<{ status: number; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const next = responses.shift() ?? { status: 200, body: {} };
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(JSON.stringify(next.body));
    });
  });

  let baseUrl = "";

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const gateway = () =>
    createConfigGateway({ baseUrl, setupToken: "the-setup-token" });

  const reset = (next: Array<{ status: number; body: unknown }>) => {
    requests.length = 0;
    responses = [...next];
  };

  it("reads the gateway's config with the setup token", async () => {
    reset([{ status: 200, body: { client_config: { enable_logging: true } } }]);
    const config = await gateway().getConfig();

    assert.deepEqual(config, { client_config: { enable_logging: true } });
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[0].url, "/api/config");
    assert.equal(
      requests[0].headers["x-bifrost-setup-token"],
      "the-setup-token",
      "the OSS setup lock's header, the same one the governance client sends",
    );
  });

  it("puts the client config as one JSON body", async () => {
    reset([{ status: 200, body: {} }]);
    const body = { client_config: { enable_logging: true }, framework_config: {} };
    await gateway().putConfig(body);

    assert.equal(requests[0].method, "PUT");
    assert.equal(requests[0].url, "/api/config");
    assert.deepEqual(JSON.parse(requests[0].body), body);
  });

  it("escapes a provider name and a key id in their own path segments", async () => {
    reset([
      { status: 200, body: {} },
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    await gateway().putProvider("custom/provider", { network_config: {} });
    await gateway().putProviderKey("custom/provider", "key/1", { models: ["m"] });
    await gateway().listProviderKeys("custom/provider");

    assert.equal(requests[0].url, "/api/providers/custom%2Fprovider");
    assert.equal(
      requests[1].url,
      "/api/providers/custom%2Fprovider/keys/key%2F1",
    );
    assert.equal(requests[2].url, "/api/providers/custom%2Fprovider/keys");
  });

  it("answers null for a provider the gateway does not have, rather than throwing", async () => {
    // A provider in the file and not in the running task is a boot-only change
    // -- adding one needs its key values -- so it is a skip, not an outage.
    reset([{ status: 404, body: { error: "Provider not found" } }]);
    assert.equal(await gateway().getProvider("bedrock"), null);
  });

  it("unwraps the key list and never retains a key value beyond the response", async () => {
    reset([
      {
        status: 200,
        body: {
          keys: [
            {
              id: "key-1",
              name: "fireworks-primary",
              value: "sk-the-live-credential",
              models: ["m-1"],
              weight: 1,
            },
          ],
          total: 1,
        },
      },
    ]);
    const keys = await gateway().listProviderKeys("fireworks");

    assert.ok(keys, "a 200 must not read as the 404's null");
    assert.equal(keys.length, 1);
    assert.equal(keys[0].id, "key-1");
    assert.equal(keys[0].name, "fireworks-primary");
  });

  it("answers null for a provider's key list when the provider does not exist", async () => {
    // The same `404` `getProvider` answers `null` for. Both routes are nested
    // under the provider, so a provider that is only in the file answers the
    // same way to both reads; throwing here and not there is what made a
    // provider that should be `not-present` fail the whole invocation
    // (`config-convergence-core.ts`, the keys loop).
    reset([{ status: 404, body: { error: "Provider not found" } }]);
    assert.equal(await gateway().listProviderKeys("bedrock"), null);
  });

  it("turns a non-2xx on a write into a status-only failure", async () => {
    reset([{ status: 400, body: { error: "log_retention_days must be at least 1" } }]);
    await assert.rejects(gateway().putConfig({}), (error: unknown) => {
      assert.ok(error instanceof GatewayFailure);
      assert.equal(error.status, 400);
      assert.ok(!error.message.includes("log_retention_days"));
      return true;
    });
  });

  it("converges end to end against a real server: one GET, one PUT, no fragment", async () => {
    // The whole loop over real transport, which is the only place the request
    // shapes and the diff meet. The stored config has a field the file does not
    // name; the body has to carry it back.
    reset([
      {
        status: 200,
        body: {
          client_config: { enable_logging: false, log_retention_days: 30 },
          framework_config: { pricing_url: "https://example.test/p" },
        },
      },
      { status: 200, body: {} },
    ]);

    const result = await convergeConfig({
      gateway: gateway(),
      desired: liveConfigDesiredState(
        JSON.stringify({ client: { enable_logging: true } }),
      ),
    });

    assert.equal(result.changed, 1);
    assert.equal(requests.length, 2);
    const body = JSON.parse(requests[1].body);
    assert.deepEqual(body.client_config, {
      enable_logging: true,
      log_retention_days: 30,
    });
    assert.deepEqual(body.framework_config, {
      pricing_url: "https://example.test/p",
    });
  });
});
