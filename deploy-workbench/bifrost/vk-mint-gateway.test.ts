import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import {
  GetUserIdCommand,
  ListGroupMembershipsCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-identitystore";

import {
  GatewayFailure,
  KeyNameConflict,
  type VirtualKey,
} from "./vk-mint-core";
import {
  createBifrostGateway,
  createMembershipDirectory,
  type IdentityStoreSender,
} from "./vk-mint-handler";

/**
 * The adapters, against real transport rather than a mock of the decision
 * layer: a local HTTP server for the gateway client, and a fake `send` for the
 * Identity Store.
 *
 * These are the things a fake gateway cannot settle, so they are worth the
 * bytes: the header name the setup lock requires, the `virtual_keys: null`
 * shape an empty result comes back as, the `409` that decision 4 leans on, and
 * a paginated membership read that has to reach the last page.
 */

type Recorded = {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

describe("the gateway client over real HTTP", () => {
  const requests: Recorded[] = [];
  let responses: Array<{ status: number; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
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
    createBifrostGateway({ baseUrl, setupToken: "the-setup-token" });

  const reset = (next: Array<{ status: number; body: unknown }>) => {
    requests.length = 0;
    responses = [...next];
  };

  it("sends the setup token in X-Bifrost-Setup-Token and URL-encodes the search", async () => {
    reset([{ status: 200, body: { virtual_keys: [], count: 0, total_count: 0 } }]);
    await gateway().list({ search: "jeff+vk@goodparty.org", limit: 100, offset: 0 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
    assert.equal(
      requests[0].headers["x-bifrost-setup-token"],
      "the-setup-token",
      "the OSS setup lock's header name at transports/v2.3.0",
    );
    const url = new URL(requests[0].url ?? "", baseUrl);
    assert.equal(url.pathname, "/api/governance/virtual-keys");
    assert.equal(url.searchParams.get("search"), "jeff+vk@goodparty.org");
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(url.searchParams.get("offset"), "0");
  });

  it("reads an empty result whose virtual_keys is null", async () => {
    reset([{ status: 200, body: { virtual_keys: null, count: 0, total_count: 0 } }]);
    const page = await gateway().list({ search: "jeff@goodparty.org", limit: 1, offset: 0 });
    assert.deepEqual(page.keys, []);
    assert.equal(page.totalCount, 0);
  });

  it("parses the fields the mint reads, and defaults the ones a key does not carry", async () => {
    reset([
      {
        status: 200,
        body: {
          virtual_keys: [
            {
              id: "vk-1",
              name: "jeff@goodparty.org",
              value: "sk-bf-1",
              is_active: false,
              expires_at: "2027-01-27T00:00:00Z",
              delete_after_expire: true,
              description: "lambda-managed per-user key",
            },
            { id: "vk-2", name: "x@goodparty.org" },
          ],
          count: 2,
          total_count: 2,
        },
      },
    ]);
    const page = await gateway().list({ search: "goodparty.org", limit: 100, offset: 0 });
    assert.deepEqual(page.keys[0], {
      id: "vk-1",
      name: "jeff@goodparty.org",
      value: "sk-bf-1",
      is_active: false,
      expires_at: "2027-01-27T00:00:00Z",
      delete_after_expire: true,
      description: "lambda-managed per-user key",
    });
    assert.deepEqual(page.keys[1], {
      id: "vk-2",
      name: "x@goodparty.org",
      value: null,
      is_active: null,
      expires_at: null,
      delete_after_expire: null,
      description: null,
    });
  });

  it("creates with the body it was given and accepts 200 or 201", async () => {
    const created: VirtualKey = {
      id: "vk-1",
      name: "jeff@goodparty.org",
      value: "sk-bf-created",
      is_active: true,
    };
    reset([
      { status: 200, body: { message: "ok", virtual_key: created } },
      { status: 201, body: { message: "ok", virtual_key: created } },
    ]);
    const body = { name: "jeff@goodparty.org", is_active: true };
    assert.equal((await gateway().create(body)).value, "sk-bf-created");
    assert.equal((await gateway().create(body)).value, "sk-bf-created");
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/api/governance/virtual-keys");
    assert.equal(requests[0].headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(requests[0].body), body);
  });

  it("turns a duplicate name into KeyNameConflict, which the mint rereads on", async () => {
    reset([{ status: 409, body: { error: "A virtual key with this name already exists" } }]);
    await assert.rejects(
      gateway().create({ name: "jeff@goodparty.org" }),
      (error: unknown) => error instanceof KeyNameConflict,
    );
  });

  it("does not put a response body into an error", async () => {
    reset([{ status: 500, body: { error: "boom", virtual_key: { value: "sk-bf-leak" } } }]);
    await assert.rejects(
      gateway().list({ search: "jeff@goodparty.org", limit: 1, offset: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof GatewayFailure);
        assert.equal(error.status, 500);
        assert.equal(error.message, "Bifrost answered 500");
        assert.ok(!error.message.includes("sk-bf-leak"));
        return true;
      },
    );
  });

  it("updates with a PUT to the key's own path", async () => {
    reset([
      {
        status: 200,
        body: {
          message: "ok",
          virtual_key: {
            id: "vk 1",
            name: "jeff@goodparty.org",
            value: "sk-bf-reactivated",
            is_active: true,
          },
        },
      },
    ]);
    const body = { is_active: true, expires_at: "", delete_after_expire: null };
    const updated = await gateway().update("vk 1", body);
    assert.equal(updated.value, "sk-bf-reactivated");
    assert.equal(requests[0].method, "PUT");
    assert.equal(requests[0].url, "/api/governance/virtual-keys/vk%201");
    assert.deepEqual(JSON.parse(requests[0].body), body);
    // The tri-state clear has to survive serialization as JSON null, not be
    // dropped: `delete_after_expire: null` is what returns the key to
    // inheriting the gateway's deletion policy.
    assert.match(requests[0].body, /"delete_after_expire":null/);
  });
});

describe("the directory reads over a fake Identity Store", () => {
  const commands: unknown[] = [];

  const directory = (respond: (command: unknown) => unknown) => {
    const client: IdentityStoreSender = {
      send: async (command: any) => {
        commands.push(command);
        return respond(command);
      },
    } as IdentityStoreSender;
    return createMembershipDirectory({
      client,
      identityStoreId: "d-test",
      groupId: "g-engineers",
    });
  };

  it("reads every page of the group and keeps only user ids", async () => {
    commands.length = 0;
    const dir = directory((command) => {
      assert.ok(command instanceof ListGroupMembershipsCommand);
      return (command.input.NextToken === undefined
        ? {
            GroupMemberships: [
              { MemberId: { UserId: "u-1" }, MembershipId: "m-1" },
              // A non-user member cannot come from this group; skipping it is
              // deliberate rather than comparing an empty string.
              { MemberId: {}, MembershipId: "m-2" },
            ],
            NextToken: "page-2",
          }
        : { GroupMemberships: [{ MemberId: { UserId: "u-2" }, MembershipId: "m-3" }] }) as never;
    });

    assert.deepEqual(await dir.listMemberUserIds(), ["u-1", "u-2"]);
    assert.equal(commands.length, 2);
    const second = commands[1] as ListGroupMembershipsCommand;
    assert.equal(second.input.NextToken, "page-2");
    assert.equal(second.input.GroupId, "g-engineers");
    assert.equal(second.input.IdentityStoreId, "d-test");
  });

  it("resolves an email on the emails.value index", async () => {
    commands.length = 0;
    const dir = directory(() => ({ UserId: "u-1" }) as never);
    assert.equal(await dir.getUserId("jeff@goodparty.org"), "u-1");
    const command = commands[0] as GetUserIdCommand;
    assert.equal(command.input.AlternateIdentifier?.UniqueAttribute?.AttributePath, "emails.value");
    assert.equal(
      command.input.AlternateIdentifier?.UniqueAttribute?.AttributeValue,
      "jeff@goodparty.org",
    );
  });

  it("treats a missing user as null and every other error as a failure", async () => {
    const missing = directory(() => {
      throw new ResourceNotFoundException({ message: "no user", $metadata: {} });
    });
    assert.equal(await missing.getUserId("gone@goodparty.org"), null);

    const throttled = directory(() => {
      throw new Error("ThrottlingException");
    });
    await assert.rejects(throttled.getUserId("jeff@goodparty.org"));
  });
});
