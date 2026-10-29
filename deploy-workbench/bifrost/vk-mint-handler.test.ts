import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WORKBENCH_ACCOUNT_ID } from "../../utils/accounts";
import {
  WORKBENCH_ACCESS_ROLE_PREFIX,
  type MembershipDirectory,
  type VirtualKey,
  type VirtualKeyGateway,
} from "./vk-mint-core";
import { createHandler, type HandlerDeps } from "./vk-mint-handler";

/**
 * The handler's wiring: the verified caller, the fail-closed statuses, the
 * request body being ignored, and the one property decision 3 is emphatic
 * about — no key and no body in a log line.
 */

const SETUP_TOKEN = "setup-token-value-that-must-not-be-logged";
const KEY_VALUE = "sk-bf-the-key-that-must-not-be-logged";
const EMAIL = "jeff@goodparty.org";

const workbenchArn = (session: string) =>
  `arn:aws:sts::${WORKBENCH_ACCOUNT_ID}:assumed-role/${WORKBENCH_ACCESS_ROLE_PREFIX}2c05f47560d36270/${session}`;

/** A Function URL event, payload format 2.0, with an optional body. */
const functionUrlEvent = (userArn: string, body?: unknown) => ({
  version: "2.0",
  rawPath: "/",
  rawQueryString: "",
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  requestContext: {
    http: { method: "POST", path: "/" },
    authorizer: { iam: { userArn, accountId: WORKBENCH_ACCOUNT_ID, callerId: "AIDA" } },
  },
});

const template = () => ({
  description: "lambda-managed per-user key",
  is_active: true,
  provider_configs: [{ provider: "bedrock" as const, allowed_models: ["m"], key_ids: ["*"] }],
});

const activeKey = (name: string): VirtualKey => ({
  id: `id-${name}`,
  name,
  value: KEY_VALUE,
  is_active: true,
});

const deps = (options: {
  member?: boolean;
  directoryError?: Error;
  templateError?: Error;
  tokenError?: Error;
  keys?: VirtualKey[];
  create?: (body: Record<string, unknown>) => Promise<VirtualKey>;
}) => {
  const logs: Record<string, unknown>[] = [];
  const creates: Record<string, unknown>[] = [];
  const gateway: VirtualKeyGateway = {
    list: async () => ({
      keys: options.keys?.filter((key) => key.name === EMAIL) ?? [],
      totalCount: options.keys?.length ?? 0,
    }),
    create: async (body) => {
      creates.push(body);
      return options.create
        ? options.create(body)
        : activeKey(String(body.name));
    },
    update: async (id) => ({ ...activeKey(EMAIL), id }),
  };
  const directory: MembershipDirectory = {
    getUserId: async () => (options.member === false ? null : "user-1"),
    listMemberUserIds: async () => ["user-1"],
  };

  const injected: HandlerDeps = {
    readTemplate: async () => {
      if (options.templateError) throw options.templateError;
      return template();
    },
    readSetupToken: async () => {
      if (options.tokenError) throw options.tokenError;
      return SETUP_TOKEN;
    },
    createDirectory: async () => {
      if (options.directoryError) throw options.directoryError;
      return directory;
    },
    createGateway: () => gateway,
    log: (entry) => logs.push(entry),
  };
  return { handler: createHandler(injected), logs, creates };
};

describe("the mint endpoint", () => {
  it("returns the caller's key and nothing else", async () => {
    const { handler, logs } = deps({ keys: [activeKey(EMAIL)] });
    const response = await handler(functionUrlEvent(workbenchArn(EMAIL)));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { key: KEY_VALUE, email: EMAIL });
    assert.deepEqual(logs, [{ event: "vk-mint", outcome: "existing", email: EMAIL }]);
  });

  it("ignores an email in the request body: the session name is the only identity", async () => {
    const { handler, creates } = deps({});
    const response = await handler(
      functionUrlEvent(workbenchArn(EMAIL), { email: "someone-else@goodparty.org" }),
    );
    assert.equal(response.statusCode, 200);
    // The create used the session name, not the body. Nothing parses the body.
    assert.equal(creates.length, 1);
    assert.equal(creates[0].name, EMAIL);
    assert.equal(JSON.parse(response.body).email, EMAIL);
  });

  it("refuses a caller that is not a WorkbenchAccess session with 403 and mints nothing", async () => {
    const { handler, creates } = deps({});
    const response = await handler(
      functionUrlEvent(`arn:aws:sts::${WORKBENCH_ACCOUNT_ID}:assumed-role/bifrost-task/${EMAIL}`),
    );
    assert.equal(response.statusCode, 403);
    assert.equal(creates.length, 0);
    assert.ok(!response.body.includes(KEY_VALUE));
  });

  it("refuses a direct invocation, which carries no authorizer, with 403", async () => {
    const { handler, creates } = deps({});
    const response = await handler({ body: JSON.stringify({ email: EMAIL }) });
    assert.equal(response.statusCode, 403);
    assert.equal(creates.length, 0);
  });

  it("refuses a non-member with 403 before the gateway is touched", async () => {
    const { handler, creates } = deps({ member: false });
    const response = await handler(functionUrlEvent(workbenchArn(EMAIL)));
    assert.equal(response.statusCode, 403);
    assert.equal(creates.length, 0);
  });

  it("fails closed with 503 when the directory cannot be read, and never mints", async () => {
    const { handler, creates, logs } = deps({
      directoryError: new Error("AccessDenied assuming bifrost-vk-reader"),
    });
    const response = await handler(functionUrlEvent(workbenchArn(EMAIL)));
    assert.equal(response.statusCode, 503);
    assert.equal(creates.length, 0);
    assert.equal(logs[0].reason, "membership-unavailable");
  });

  it("returns 500 when the template parameter cannot be read, and never mints", async () => {
    const { handler, creates } = deps({ templateError: new Error("ParameterNotFound") });
    const response = await handler(functionUrlEvent(workbenchArn(EMAIL)));
    assert.equal(response.statusCode, 500);
    assert.equal(creates.length, 0);
  });

  it("returns 500 when the setup token cannot be read, and never mints", async () => {
    const { handler, creates } = deps({ tokenError: new Error("ResourceNotFoundException") });
    const response = await handler(functionUrlEvent(workbenchArn(EMAIL)));
    assert.equal(response.statusCode, 500);
    assert.equal(creates.length, 0);
  });

  it("reactivates an inactive key through the handler, returning the new value", async () => {
    let updated = false;
    const handler = createHandler({
      readTemplate: async () => template(),
      readSetupToken: async () => SETUP_TOKEN,
      createDirectory: async () => ({
        getUserId: async () => "user-1",
        listMemberUserIds: async () => ["user-1"],
      }),
      createGateway: () => ({
        list: async () => ({
          keys: [{ id: "id-1", name: EMAIL, value: "sk-bf-old", is_active: false }],
          totalCount: 1,
        }),
        create: async () => {
          throw new Error("must not create a second key");
        },
        update: async () => {
          updated = true;
          return { id: "id-1", name: EMAIL, value: KEY_VALUE, is_active: true };
        },
      }),
      log: () => {},
    });
    const response = await handler(functionUrlEvent(workbenchArn(EMAIL)));
    assert.equal(response.statusCode, 200);
    assert.equal(updated, true);
    assert.deepEqual(JSON.parse(response.body), { key: KEY_VALUE, email: EMAIL });
  });

  it("never logs the key, the setup token or the request body (decision 3)", async () => {
    const { handler, logs } = deps({});
    const response = await handler(
      functionUrlEvent(workbenchArn(EMAIL), { email: "body@goodparty.org", secret: "body-secret" }),
    );
    assert.equal(response.statusCode, 200);
    const serialized = JSON.stringify(logs);
    assert.ok(!serialized.includes(KEY_VALUE), "the key must not be logged");
    assert.ok(!serialized.includes(SETUP_TOKEN), "the setup token must not be logged");
    assert.ok(!serialized.includes("body@goodparty.org"), "the request body must not be logged");
    assert.ok(!serialized.includes("body-secret"), "the request body must not be logged");
    // What is logged is the outcome and the email, which is what an operator
    // needs to answer "who minted, and did it work".
    assert.ok(serialized.includes(EMAIL));
    assert.ok(serialized.includes("created"));
    // The key exists only in the response.
    assert.ok(response.body.includes(KEY_VALUE));
  });

  it("does not leak a body through an error message", async () => {
    const { handler, logs } = deps({
      create: async () => {
        throw new Error("Bifrost answered 500 with body {\"virtual_key\":\"sk-bf-leak\"}");
      },
    });
    const response = await handler(functionUrlEvent(workbenchArn(EMAIL)));
    // A non-MintFailure is a 502 with a fixed message; the error's message (and
    // whatever a caller put in it) does not reach the response or the log.
    assert.equal(response.statusCode, 502);
    assert.ok(!response.body.includes("sk-bf-leak"));
    assert.ok(!JSON.stringify(logs).includes("sk-bf-leak"));
  });
});
