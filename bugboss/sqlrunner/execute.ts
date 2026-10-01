// One approved query against the gp-api prod reader, on a fresh connection.
// No pool: queries are rare, each is approved by a person, and a connection
// that outlives its query is one more thing that can be left open.

import { Client, type ClientConfig, type QueryConfig } from "pg";

import { makeAlarm } from "../logging";
import { ROW_CAP, type QueryExecutor } from "./runner";

const alarm = makeAlarm("sqlrunner");

export interface ReadonlyDbConfig {
  host: string;
  database: string;
  user: string;
  password: string;
}

export interface PgLike {
  connect(): Promise<unknown>;
  query(config: string | QueryConfig): Promise<{
    fields?: { name: string }[];
    rows: Record<string, unknown>[];
  }>;
  end(): Promise<void>;
}

export const wrapQuery = (sql: string): string =>
  // Newlines, so a trailing `--` comment in the agent's SQL cannot comment
  // out the closing paren and the LIMIT.
  `SELECT * FROM (\n${sql}\n) AS bugboss_q LIMIT ${ROW_CAP + 1}`;

export const createPgExecutor = (
  db: ReadonlyDbConfig,
  makeClient: (config: ClientConfig) => PgLike = (config) => new Client(config),
): QueryExecutor => {
  return async (sql) => {
    const client = makeClient({
      host: db.host,
      port: 5432,
      database: db.database,
      user: db.user,
      password: db.password,
      connectionTimeoutMillis: 10_000,
      // Client-side backstop for a connection that stops answering, which
      // statement_timeout (server-side) cannot catch.
      query_timeout: 40_000,
      // Aurora requires TLS and the RDS CA is not in the Alpine trust store.
      ssl: { rejectUnauthorized: false },
    });
    try {
      await client.connect();
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '30s'");
      // The extended protocol parses exactly one statement, so Postgres
      // itself refuses anything that smuggles a second one past the ';'
      // check. `queryMode` is honoured by pg but missing from @types/pg.
      const query = { text: wrapQuery(sql), queryMode: "extended" } as QueryConfig;
      const res = await client.query(query);
      await client.query("ROLLBACK");
      return {
        columns: (res.fields ?? []).map((f) => f.name),
        rows: res.rows,
      };
    } finally {
      await client.end().catch((err: unknown) =>
        alarm("client_end_failed", { error: err instanceof Error ? err.message : String(err) }),
      );
    }
  };
};
