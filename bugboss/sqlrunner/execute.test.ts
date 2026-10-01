import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ClientConfig, QueryConfig } from "pg";

import { createPgExecutor, type PgLike } from "./execute";

const DB = { host: "reader.example", database: "gpdb", user: "readonly_user", password: "pw" };

const fakeClient = (fail?: Error) => {
  const queries: (string | QueryConfig)[] = [];
  let ended = 0;
  let config: ClientConfig | undefined;
  const make = (c: ClientConfig): PgLike => {
    config = c;
    return {
      connect: async () => undefined,
      query: async (q) => {
        queries.push(q);
        if (typeof q !== "string" && fail) throw fail;
        return typeof q === "string" ? { rows: [] } : { fields: [{ name: "n" }], rows: [{ n: 1 }] };
      },
      end: async () => {
        ended++;
      },
    };
  };
  return { make, queries, ended: () => ended, config: () => config };
};

describe("createPgExecutor", () => {
  it("runs the query read-only, timed out, capped at 201 rows, in extended mode, then rolls back", async () => {
    const fake = fakeClient();
    const result = await createPgExecutor(DB, fake.make)("select 1 as n -- trailing");
    assert.deepEqual(result, { columns: ["n"], rows: [{ n: 1 }] });
    assert.equal(fake.queries[0], "BEGIN READ ONLY");
    assert.equal(fake.queries[1], "SET LOCAL statement_timeout = '30s'");
    const main = fake.queries[2] as QueryConfig & { queryMode?: string };
    assert.equal(main.text, "SELECT * FROM (\nselect 1 as n -- trailing\n) AS bugboss_q LIMIT 201");
    assert.equal(main.queryMode, "extended");
    assert.equal(fake.queries[3], "ROLLBACK");
    assert.equal(fake.ended(), 1);
    assert.deepEqual(fake.config()?.ssl, { rejectUnauthorized: false });
    assert.equal(fake.config()?.connectionTimeoutMillis, 10_000);
  });

  it("ends the client when the query fails", async () => {
    const fake = fakeClient(Object.assign(new Error("boom"), { code: "42601" }));
    await assert.rejects(createPgExecutor(DB, fake.make)("select"), /boom/);
    assert.equal(fake.ended(), 1);
  });
});
