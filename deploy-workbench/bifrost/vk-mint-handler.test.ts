import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { WORKBENCH_ACCOUNT_ID } from "../../utils/accounts";
import {
  WORKBENCH_ACCESS_ROLE_PREFIX,
  type MembershipDirectory,
  type VirtualKey,
  type VirtualKeyGateway,
} from "./vk-mint-core";
import { createBifrostGateway, createHandler, type HandlerDeps } from "./vk-mint-handler";
import type {
  GovernanceOverrides,
  GovernanceTemplate,
} from "./governance-desired-state";

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
  provider_configs: [
    {
      provider: "bedrock" as const,
      allowed_models: ["m"],
      key_ids: ["*"],
    },
  ],
});

/**
 * The template's provider list as the create body must carry it, with the
 * budgets set every entry now names: an entry with none says so with `[]`
 * rather than by leaving the field out, because on the update path an omitted
 * `budgets` leaves that entry's existing ones alone (decision 18 of
 * `docs/bifrost-reconciler.md`).
 */
const templateProviderConfigsWithBudgets = () =>
  template().provider_configs.map((entry) => ({ ...entry, budgets: [] }));

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
  overridesError?: Error;
  tokenError?: Error;
  keys?: VirtualKey[];
  create?: (body: Record<string, unknown>) => Promise<VirtualKey>;
  /** The per-person document the handler reads beside the template. */
  overrides?: Record<string, unknown>;
  /** The template the handler reads; defaults to the one-provider fixture. */
  template?: Record<string, unknown>;
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
    readGovernance: async () => {
      if (options.templateError) throw options.templateError;
      if (options.overridesError) throw options.overridesError;
      return {
        template: (options.template ?? template()) as unknown as GovernanceTemplate,
        overrides: (options.overrides ?? {}) as GovernanceOverrides,
      };
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
    assert.deepEqual(JSON.parse(response.body), {
      key: KEY_VALUE,
      email: EMAIL,
      usage: { budgets: [] },
    });
    assert.deepEqual(logs, [{ event: "vk-mint", outcome: "existing", email: EMAIL }]);
  });

  it("returns the caller's own spend beside the key, and logs neither", async () => {
    const { handler, logs } = deps({
      keys: [
        {
          ...activeKey(EMAIL),
          provider_configs: [
            {
              provider: "bedrock",
              budgets: [{ max_limit: 1500, reset_duration: "1M", current_usage: 412.37 }],
            },
          ],
        },
      ],
    });
    const response = await handler(functionUrlEvent(workbenchArn(EMAIL)));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body).usage, {
      budgets: [{ scope: "bedrock", max_limit: 1500, current_usage: 412.37, reset_duration: "1M" }],
    });
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
      readGovernance: async () => ({ template: template(), overrides: {} }),
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
    assert.deepEqual(JSON.parse(response.body), {
      key: KEY_VALUE,
      email: EMAIL,
      usage: { budgets: [] },
    });
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

describe("the caller's usage over the real gateway adapter", () => {
  /**
   * The create path end to end, through the adapter that is deployed rather
   * than through a fake that hands back the governance directly. That
   * distinction is the bug: a fake gateway that returns `budgets` proves the
   * decision layer reads them, and nothing about whether `toKey` copied them
   * out of the response. `#550` shipped the fake-only version, and the
   * deployed mint answered `usage.budgets: []` for a key with budgets.
   */
  const requests: Array<{ method?: string; url?: string }> = [];
  let responses: Array<{ status: number; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url });
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

  /** The handler over the real adapter, with everything but the gateway faked. */
  const handlerOverRealGateway = (logs: Record<string, unknown>[]) =>
    createHandler({
      readGovernance: async () => ({ template: template(), overrides: {} }),
      readSetupToken: async () => SETUP_TOKEN,
      createDirectory: async () => ({
        getUserId: async () => "user-1",
        listMemberUserIds: async () => ["user-1"],
      }),
      createGateway: (setupToken: string) =>
        createBifrostGateway({ baseUrl, setupToken }),
      log: (entry) => logs.push(entry),
    });

  /** A key as the create route answers it, hydrated from its model configs. */
  const createdKey = () => ({
    id: "vk-created",
    name: EMAIL,
    value: KEY_VALUE,
    is_active: true,
    description: "lambda-managed per-user key",
    calendar_aligned: true,
    budgets: [
      { id: "b1", max_limit: 250, reset_duration: "1M", current_usage: 12.5, last_reset: "2026-11-01T00:00:00Z" },
    ],
    provider_configs: [
      {
        id: 7,
        provider: "bedrock",
        allowed_models: ["m"],
        allow_all_keys: true,
        keys: [],
        budgets: [
          { id: "b2", max_limit: 1500, reset_duration: "1M", current_usage: 412.37, last_reset: "2026-11-01T00:00:00Z" },
        ],
      },
    ],
    rate_limit: { request_max_limit: 600, request_reset_duration: "5m", request_current_usage: 3 },
  });

  it("reports the key's and each provider entry's budgets on the create path", async () => {
    requests.length = 0;
    responses = [
      // The mint lists first and finds nothing, then creates.
      { status: 200, body: { virtual_keys: [], count: 0, total_count: 0 } },
      { status: 200, body: { message: "ok", virtual_key: createdKey() } },
    ];
    const logs: Record<string, unknown>[] = [];
    const response = await handlerOverRealGateway(logs)(functionUrlEvent(workbenchArn(EMAIL)));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(requests.map((request) => request.method), ["GET", "POST"]);
    assert.deepEqual(JSON.parse(response.body), {
      key: KEY_VALUE,
      email: EMAIL,
      usage: {
        calendar_aligned: true,
        budgets: [
          { scope: "key", max_limit: 250, current_usage: 12.5, reset_duration: "1M", last_reset: "2026-11-01T00:00:00Z" },
          { scope: "bedrock", max_limit: 1500, current_usage: 412.37, reset_duration: "1M", last_reset: "2026-11-01T00:00:00Z" },
        ],
      },
    });
    // Nothing new reaches the logs, and nothing about the governance does.
    assert.deepEqual(logs, [{ event: "vk-mint", outcome: "created", email: EMAIL }]);
    assert.ok(!JSON.stringify(logs).includes("412.37"), "the counters must not be logged");
  });

  it("reports an uncapped key as uncapped, with calendar_aligned still present", async () => {
    // gp-pi#147 reads an empty `budgets` with `calendar_aligned` present as
    // "genuinely uncapped" and calls the same empty list with the field absent
    // "could not read the usage". A key that really has no budgets has to keep
    // the field, or a correct answer is reported as a failure.
    requests.length = 0;
    responses = [
      { status: 200, body: { virtual_keys: [], count: 0, total_count: 0 } },
      {
        status: 200,
        body: {
          message: "ok",
          virtual_key: {
            id: "vk-uncapped",
            name: EMAIL,
            value: KEY_VALUE,
            is_active: true,
            calendar_aligned: true,
            budgets: [],
            provider_configs: [
              { id: 9, provider: "bedrock", allowed_models: ["m"], allow_all_keys: true, keys: [] },
            ],
          },
        },
      },
    ];
    const response = await handlerOverRealGateway([])(functionUrlEvent(workbenchArn(EMAIL)));

    assert.equal(response.statusCode, 200);
    const usage = JSON.parse(response.body).usage;
    assert.deepEqual(usage, { calendar_aligned: true, budgets: [] });
    assert.ok("calendar_aligned" in usage, "the field the consumer tells uncapped by");
  });
});

describe("the create carries the caller's governance (step 5)", () => {
  it("creates the key from the template and the caller's override, in the composed shape", async () => {
    const { handler, creates } = deps({
      overrides: {
        [EMAIL]: {
          budgets: [{ max_limit: 250, reset_duration: "1M" }],
          provider_configs: "inherit",
        },
      },
    });
    const response = await handler(functionUrlEvent(workbenchArn(EMAIL)));
    assert.equal(response.statusCode, 200);

    assert.equal(creates.length, 1);
    const body = creates[0];
    assert.equal(body.name, EMAIL);
    // The override's budget, in the shape the reconciler's body uses (no id).
    assert.deepEqual(body.budgets, [{ max_limit: 250, reset_duration: "1M" }]);
    // `inherit` resolved to the template's list rather than being sent as the
    // sentinel or as nothing: the field is a replacement set on the wire.
    assert.deepEqual(body.provider_configs, templateProviderConfigsWithBudgets());
    // Decision 11's fleet-wide default, and decision 12's absent rate limit.
    assert.equal(body.calendar_aligned, true);
    assert.ok(!("rate_limit" in body));
    // The template's own fields are untouched.
    assert.equal(body.description, template().description);
    assert.equal(body.is_active, true);
  });

  it("creates from the template alone for a caller with no entry in the overrides document", async () => {
    const { handler, creates } = deps({ overrides: {} });
    const response = await handler(functionUrlEvent(workbenchArn(EMAIL)));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(creates[0].budgets, []);
    assert.equal(creates[0].calendar_aligned, true);
    assert.deepEqual(creates[0].provider_configs, templateProviderConfigsWithBudgets());
  });

  it("sends a provider entry's own budget, and the empty set for one that has none", async () => {
    // Decision 18: a per-provider cap is the entry's own `budgets`, and the
    // entry the template leaves uncapped says so with `[]`. Both halves matter:
    // an entry that left the field out would keep whatever it already carried on
    // an update, so a cap git had dropped would never be removed.
    const capped = () => ({
      description: "lambda-managed per-user key",
      is_active: true,
      provider_configs: [
        {
          provider: "bedrock" as const,
          allowed_models: ["m"],
          key_ids: ["*"],
          budgets: [{ max_limit: 1500, reset_duration: "1M" }],
        },
        {
          provider: "fireworks" as const,
          allowed_models: ["f"],
          key_ids: ["*"],
        },
      ],
    });
    const { handler, creates } = deps({ overrides: {}, template: capped() });
    const response = await handler(functionUrlEvent(workbenchArn(EMAIL)));
    assert.equal(response.statusCode, 200);

    assert.deepEqual(creates[0].provider_configs, [
      {
        provider: "bedrock",
        allowed_models: ["m"],
        key_ids: ["*"],
        budgets: [{ max_limit: 1500, reset_duration: "1M" }],
      },
      {
        provider: "fireworks",
        allowed_models: ["f"],
        key_ids: ["*"],
        budgets: [],
      },
    ]);
  });

  it("refuses rather than creating from half the desired state when the overrides document cannot be read", async () => {
    // A key created with the template's governance while a person's override
    // exists is a key they then live with until the next tick rewrites it, and
    // the tick is a five-minute wait for the thing they just asked for. The read
    // is one dependency because the two documents are one desired state.
    const { handler, creates, logs } = deps({
      overridesError: new Error("AccessDenied on /bifrost/governance-overrides"),
    });
    const response = await handler(functionUrlEvent(workbenchArn(EMAIL)));
    assert.equal(response.statusCode, 500);
    assert.equal(creates.length, 0);
    assert.equal(logs[0].reason, "template-unavailable");
  });
});
