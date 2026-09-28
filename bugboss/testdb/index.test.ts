import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { describe, it } from "node:test";

import {
  TEST_DB_ENV_VAR,
  awaitTestDatabase,
  probeTestDatabase,
  resolveTestDatabase,
} from "./index";

const LOOPBACK = "postgresql://test_user:test_password@127.0.0.1:5432/postgres";

const listen = (): Promise<{ server: Server; port: number }> =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port });
    });
  });

describe("resolveTestDatabase", () => {
  it("is absent when nothing names a database", () => {
    assert.deepEqual(resolveTestDatabase({}), { state: "absent" });
    assert.deepEqual(resolveTestDatabase({ [TEST_DB_ENV_VAR]: "" }), {
      state: "absent",
    });
  });

  it("accepts a loopback Postgres on the maintenance database", () => {
    assert.deepEqual(resolveTestDatabase({ [TEST_DB_ENV_VAR]: LOOPBACK }), {
      state: "configured",
      url: LOOPBACK,
      host: "127.0.0.1",
      port: 5432,
    });
  });

  it("defaults the port when the URL omits it", () => {
    const result = resolveTestDatabase({
      [TEST_DB_ENV_VAR]: "postgresql://u:p@localhost/postgres",
    });
    assert.equal(result.state, "configured");
    if (result.state !== "configured") return;
    assert.equal(result.port, 5432);
  });

  it("refuses a host that is not loopback, whatever else is right about it", () => {
    const result = resolveTestDatabase({
      [TEST_DB_ENV_VAR]:
        "postgresql://gpuser:pw@gp-api-db-prod.cluster-x.us-west-2.rds.amazonaws.com:5432/postgres",
    });
    assert.equal(result.state, "refused");
    if (result.state !== "refused") return;
    assert.match(result.reason, /not loopback/);
    assert.match(result.reason, new RegExp(TEST_DB_ENV_VAR));
  });

  it("refuses a maintenance database omni's harness cannot derive from", () => {
    const result = resolveTestDatabase({
      [TEST_DB_ENV_VAR]: "postgresql://u:p@127.0.0.1:5432/gpdb",
    });
    assert.equal(result.state, "refused");
    if (result.state !== "refused") return;
    assert.match(result.reason, /\/postgres/);
  });

  it("refuses a scheme that is not Postgres", () => {
    const result = resolveTestDatabase({
      [TEST_DB_ENV_VAR]: "mysql://u:p@127.0.0.1:3306/postgres",
    });
    assert.equal(result.state, "refused");
  });

  it("refuses something that is not a URL at all", () => {
    const result = resolveTestDatabase({ [TEST_DB_ENV_VAR]: "localhost:5432" });
    assert.equal(result.state, "refused");
    if (result.state !== "refused") return;
    assert.match(result.reason, new RegExp(TEST_DB_ENV_VAR));
  });

  it("accepts the postgres: spelling of the scheme", () => {
    const result = resolveTestDatabase({
      [TEST_DB_ENV_VAR]: "postgres://u:p@localhost:5432/postgres",
    });
    assert.equal(result.state, "configured");
  });
});

describe("probeTestDatabase", () => {
  it("reports a listener as reachable", async () => {
    const { server, port } = await listen();
    try {
      assert.deepEqual(await probeTestDatabase({ host: "127.0.0.1", port }), {
        reachable: true,
      });
    } finally {
      server.close();
    }
  });

  it("reports a closed port as unreachable, with the reason", async () => {
    const { server, port } = await listen();
    await new Promise((done) => server.close(done));

    const result = await probeTestDatabase({ host: "127.0.0.1", port });
    assert.equal(result.reachable, false);
    assert.ok(result.error);
  });

  it("gives up rather than hanging when nothing answers", async () => {
    // A routable address that drops SYN, so connect neither completes nor is
    // refused: the case a bare connect() would wait on until the OS gave up.
    const result = await probeTestDatabase({ host: "192.0.2.1", port: 5432 }, 200);
    assert.equal(result.reachable, false);
    assert.match(result.error ?? "", /200ms/);
  });
});

describe("awaitTestDatabase", () => {
  it("waits out a sidecar that is still running initdb", async () => {
    // The case that matters: both containers start together and Postgres binds
    // TCP last, so at the Boss's boot the port is normally closed. A single
    // probe here alarms on every cold deploy.
    const { server, port } = await listen();
    await new Promise((done) => server.close(done));

    let late: Server | undefined;
    const opensLate = setTimeout(() => {
      late = createServer();
      late.listen(port, "127.0.0.1");
    }, 2_500);

    try {
      const result = await awaitTestDatabase({ host: "127.0.0.1", port }, 30_000);
      assert.equal(result.reachable, true);
      assert.ok(result.waitedMs >= 2_000, `waited ${result.waitedMs}ms`);
    } finally {
      clearTimeout(opensLate);
      late?.close();
    }
  });

  it("gives up at the deadline and says how long it waited", async () => {
    const { server, port } = await listen();
    await new Promise((done) => server.close(done));

    const result = await awaitTestDatabase({ host: "127.0.0.1", port }, 3_000);
    assert.equal(result.reachable, false);
    assert.ok(result.error);
    assert.ok(result.waitedMs < 10_000, `waited ${result.waitedMs}ms`);
  });

  it("answers immediately when the database is already up", async () => {
    const { server, port } = await listen();
    try {
      const result = await awaitTestDatabase({ host: "127.0.0.1", port }, 30_000);
      assert.equal(result.reachable, true);
      assert.ok(result.waitedMs < 1_000);
    } finally {
      server.close();
    }
  });
});
