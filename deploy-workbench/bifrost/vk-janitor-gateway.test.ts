import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { GatewayFailure } from "./vk-mint-core";
import { VK_DESCRIPTION } from "./vk-marker";
import { createJanitorGateway } from "./vk-janitor-handler";

/**
 * The janitor's gateway adapter, against real transport rather than a mock of
 * the decision layer: a local HTTP server, the same harness
 * `vk-mint-gateway.test.ts` uses.
 *
 * What this settles that a fake gateway cannot: the setup-lock header name, a
 * list call that carries no `search` term at all (a reconcile must see every
 * key, not search hits), the `virtual_keys: null` shape an empty result comes
 * back as, and the one `PUT` the deactivation makes.
 */

type Recorded = {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

describe("the janitor's gateway client over real HTTP", () => {
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
    createJanitorGateway({ baseUrl, setupToken: "the-setup-token" });

  const reset = (next: Array<{ status: number; body: unknown }>) => {
    requests.length = 0;
    responses = [...next];
  };

  it("lists every key with no search term, carrying the setup token", async () => {
    reset([{ status: 200, body: { virtual_keys: [], count: 0, total_count: 0 } }]);
    await gateway().list({ limit: 100, offset: 200 });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
    assert.equal(
      requests[0].headers["x-bifrost-setup-token"],
      "the-setup-token",
      "the OSS setup lock's header name at transports/v2.3.0",
    );
    const url = new URL(requests[0].url ?? "", baseUrl);
    assert.equal(url.pathname, "/api/governance/virtual-keys");
    // The mint's list is a substring search; the janitor's must not be, or a
    // key whose name does not match the term would never be reconciled.
    assert.equal(url.searchParams.get("search"), null);
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(url.searchParams.get("offset"), "200");
  });

  it("reads an empty result whose virtual_keys is null", async () => {
    reset([{ status: 200, body: { virtual_keys: null, count: 0, total_count: 0 } }]);
    const page = await gateway().list({ limit: 1, offset: 0 });
    assert.deepEqual(page.keys, []);
    assert.equal(page.totalCount, 0);
  });

  it("parses the fields the verdicts need and does not retain a key value", async () => {
    reset([
      {
        status: 200,
        body: {
          virtual_keys: [
            {
              id: "vk-1",
              name: "gone@goodparty.org",
              value: "sk-bf-should-not-be-retained",
              is_active: false,
              expires_at: "2027-01-27T00:00:00Z",
              delete_after_expire: true,
              description: VK_DESCRIPTION,
            },
            { id: "vk-2", name: "x@goodparty.org" },
          ],
          count: 2,
          total_count: 2,
        },
      },
    ]);
    const page = await gateway().list({ limit: 100, offset: 0 });

    assert.deepEqual(page.keys[0], {
      id: "vk-1",
      name: "gone@goodparty.org",
      // Never copied. The janitor does not need a plaintext key, so no log
      // line or error in this process can leak one.
      value: null,
      is_active: false,
      expires_at: "2027-01-27T00:00:00Z",
      delete_after_expire: true,
      description: VK_DESCRIPTION,
    });
    assert.equal(page.keys[1].description, null);
    assert.equal(page.keys[1].is_active, null);
  });

  it("updates with a PUT to the key's own path", async () => {
    reset([
      {
        status: 200,
        body: {
          message: "ok",
          virtual_key: { id: "vk 1", name: "gone@goodparty.org", is_active: false },
        },
      },
    ]);
    const body = {
      is_active: false,
      expires_at: "2027-01-27T12:00:00Z",
      delete_after_expire: true,
    };
    const updated = await gateway().update("vk 1", body);

    assert.equal(updated.is_active, false);
    assert.equal(requests[0].method, "PUT");
    assert.equal(requests[0].url, "/api/governance/virtual-keys/vk%201");
    assert.deepEqual(JSON.parse(requests[0].body), body);
    // The tri-state flag has to survive serialization as JSON `true`, not be
    // dropped: that field is what lets Bifrost's cleanup delete the key.
    assert.match(requests[0].body, /"delete_after_expire":true/);
  });

  it("turns a non-2xx into a status-only failure that carries no body", async () => {
    reset([{ status: 500, body: { error: "sk-bf-leak-in-error-body" } }]);
    await assert.rejects(
      gateway().list({ limit: 100, offset: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof GatewayFailure);
        assert.equal(error.status, 500);
        assert.equal(error.message, "Bifrost answered 500");
        assert.ok(!error.message.includes("sk-bf-leak"));
        return true;
      },
    );
  });
});
