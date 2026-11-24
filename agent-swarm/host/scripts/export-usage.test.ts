import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  BUCKET,
  DAILY_WINDOW_DAYS,
  EXPORTS,
  MONTHLY_WINDOW_DAYS,
  REGION,
  SESSION_COST_COLUMNS,
  SESSION_COST_PREFIX,
  SESSION_COST_SQL,
  TASK_EDGE_COLUMNS,
  TASK_EDGE_PREFIX,
  TASK_EDGE_SQL,
  UNKNOWN_AGENT_NAME,
  compactStamp,
  exportedAtStamp,
  objectKey,
  runExport,
  toJsonLines,
  toLandingRow,
  windowDaysFor,
  windowStart,
  type ExporterDeps,
  type PutResult,
} from "../export-usage-core";
import { databasePathFrom, readSnapshotWith, type SqliteHandle } from "../export-usage-sqlite";
import { putObjectWithCli, volumeMountpoint } from "../export-usage-aws";

/**
 * The exporter's contract, against a real WAL-mode SQLite file.
 *
 * The fixture is built to the upstream v2.13.0 column set: the base table from
 * `001_initial.sql` plus the six migrations that changed `session_costs` (047,
 * 063, 128, 307, 320) and `275_task_dispatched_by.sql`. A test that started from
 * a hand-written three-column table would pass while the real `SELECT` failed on
 * a name, which is the failure this export most needs to catch.
 *
 * `node:sqlite` here and `bun:sqlite` on the host, both through
 * `readSnapshotWith`. The driver is the one difference; the SQL, the transaction
 * and the serialization are the code that ships.
 */

const openNodeSqlite = (file: string) =>
  new DatabaseSync(file, { readOnly: true }) as unknown as SqliteHandle;

const readSnapshot = readSnapshotWith(openNodeSqlite);

const UPSTREAM_SCHEMA = `
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  agentId TEXT,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  parentTaskId TEXT,
  dispatchedByTaskId TEXT,
  createdAt TEXT NOT NULL
);
CREATE TABLE session_costs (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  taskId TEXT,
  agentId TEXT NOT NULL,
  totalCostUsd REAL NOT NULL,
  inputTokens INTEGER NOT NULL DEFAULT 0,
  outputTokens INTEGER NOT NULL DEFAULT 0,
  cacheReadTokens INTEGER,
  cacheWriteTokens INTEGER DEFAULT 0,
  durationMs INTEGER NOT NULL,
  numTurns INTEGER,
  model TEXT NOT NULL,
  isError INTEGER NOT NULL DEFAULT 0,
  costSource TEXT NOT NULL DEFAULT 'harness',
  reasoningOutputTokens INTEGER NOT NULL DEFAULT 0,
  thinkingTokens INTEGER NOT NULL DEFAULT 0,
  harnessCostUsd REAL,
  cacheWrite5mTokens INTEGER,
  cacheWrite1hTokens INTEGER,
  modelBreakdown TEXT,
  credentialKeyType TEXT,
  credentialKeySuffix TEXT,
  harness TEXT,
  kind TEXT NOT NULL DEFAULT 'harness',
  createdAt TEXT NOT NULL
);
`;

/** `strftime('%Y-%m-%dT%H:%M:%fZ')`, the shape upstream writes. */
const stamp = (iso: string): string => iso;

const withFixture = (build: (db: DatabaseSync) => void, schema = UPSTREAM_SCHEMA): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-export-fixture-"));
  const file = path.join(dir, "agent-swarm-db.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(schema);
  build(db);
  db.close();
  return file;
};

const LEDGER = (db: DatabaseSync): void => {
  db.exec(`
    INSERT INTO agents (id, name, createdAt) VALUES
      ('agent-1', 'coder', '2026-10-01T00:00:00.000Z'),
      ('agent-2', 'reviewer', '2026-10-01T00:00:00.000Z');

    INSERT INTO agent_tasks (id, agentId, task, status, parentTaskId, dispatchedByTaskId, createdAt) VALUES
      ('task-root', 'agent-1', 'the root task text', 'completed', NULL, NULL, '2026-11-20T10:00:00.000Z'),
      ('task-child', 'agent-1', 'child task text', 'completed', 'task-root', 'task-root', '2026-11-21T10:00:00.000Z');

    -- One ordinary row, and one that is deliberately awkward everywhere it can
    -- be: no task, agent has no row, a null harness cost, null token columns.
    INSERT INTO session_costs (
      id, sessionId, taskId, agentId, totalCostUsd,
      inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
      durationMs, numTurns, model, isError, costSource,
      reasoningOutputTokens, thinkingTokens, harnessCostUsd,
      cacheWrite5mTokens, cacheWrite1hTokens, kind, createdAt
    ) VALUES (
      'cost-1', 'session-1', 'task-root', 'agent-1', 0.001234,
      1200, 340, 5000, 200,
      61000, 7, 'accounts/fireworks/routers/deepseek-v4p1-flash-1017-us', 0, 'priced',
      0, 0, 0.001234,
      NULL, NULL, 'harness', '2026-11-22T09:00:00.000Z'
    ), (
      'cost-2', 'session-2', NULL, 'agent-gone', 1.5,
      10, 20, NULL, NULL,
      1000, NULL, 'accounts/fireworks/routers/deepseek-v4p1-flash-1017-us', 1, 'unpriced',
      0, 0, NULL,
      NULL, NULL, 'system-one', '2026-11-22T10:00:00.000Z'
    );
  `);
};

const RUN_AT = new Date("2026-11-23T09:15:00.000Z");

type Put = { bucket: string; key: string; body: string };

const harness = (
  options: {
    databasePath: string;
    put?: (args: Put) => PutResult;
    readSnapshot?: ExporterDeps["readSnapshot"];
  } = { databasePath: "" },
) => {
  const puts: Put[] = [];
  const lines: string[] = [];
  const deps: ExporterDeps = {
    readSnapshot:
      options.readSnapshot ?? (readSnapshot(options.databasePath) as ExporterDeps["readSnapshot"]),
    putObject: (args) => {
      const result = options.put ? options.put(args) : ({ ok: true } as const);
      if (result.ok) puts.push(args);
      return result;
    },
    now: () => RUN_AT,
    log: (line) => lines.push(line),
  };
  return { deps, puts, lines };
};

const parse = (body: string): Record<string, unknown>[] =>
  body
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("export usage: the landed files", () => {
  it("writes one object per table, into the two sibling prefixes", () => {
    const databasePath = withFixture(LEDGER);
    const { deps, puts } = harness({ databasePath });
    const outcome = runExport(deps);

    assert.equal(outcome.exitCode, 0);
    assert.equal(puts.length, 2, "one object per table, and no rewrite of either");
    assert.equal(puts[0].bucket, BUCKET);
    assert.ok(puts[0].key.startsWith("delegate-swarm/session-cost/session-cost-"));
    assert.ok(puts[1].key.startsWith("delegate-swarm/task-edge/task-edge-"));
    // The key is the run's UTC start, to the second, and both files share it.
    assert.equal(puts[0].key, "delegate-swarm/session-cost/session-cost-20261123T091500Z.ndjson");
    assert.equal(puts[1].key, "delegate-swarm/task-edge/task-edge-20261123T091500Z.ndjson");
    // One prefix per table: `COPY INTO` reads a whole prefix, so a shared one
    // would make each load read the other table's file.
    assert.notEqual(SESSION_COST_PREFIX, TASK_EDGE_PREFIX);
  });

  it("lands every cost row with exactly the landing keys", () => {
    const databasePath = withFixture(LEDGER);
    const { deps, puts } = harness({ databasePath });
    runExport(deps);

    const rows = parse(puts[0].body);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row), [...SESSION_COST_COLUMNS]);
    }

    const [first, second] = rows;
    assert.equal(first.id, "cost-1");
    assert.equal(first.agent_name, "coder", "the agent label is joined in, not the uuid");
    assert.equal(first.task_id, "task-root");
    assert.equal(first.exported_at, "2026-11-23T09:15:00Z");
    assert.equal(first.created_at, "2026-11-22T09:00:00.000Z");

    // The awkward row, column by column, because each of these is a silent
    // wrong value rather than an error if it slips.
    assert.equal(second.task_id, null, "a deleted task's null must survive as null");
    assert.equal(second.agent_name, UNKNOWN_AGENT_NAME);
    assert.equal(second.num_turns, null);
    assert.equal(second.cache_read_tokens, null);
    assert.equal(second.harness_cost_usd, null, "printf would make a null cost a priced zero");
    assert.match(String(second.total_cost_usd), /^\d+\.\d{6}$/);
    assert.equal(second.is_error, 1);
    assert.equal(second.kind, "system-one");
  });

  it("crosses money as a six-decimal string, never as a float", () => {
    const databasePath = withFixture(LEDGER);
    const { deps, puts } = harness({ databasePath });
    runExport(deps);
    const rows = parse(puts[0].body);
    assert.equal(rows[0].total_cost_usd, "0.001234");
    assert.equal(rows[0].harness_cost_usd, "0.001234");
    assert.equal(rows[1].total_cost_usd, "1.500000");
    // The raw line, so a writer that "helpfully" emits 0.001234 as a JSON number
    // cannot pass this by way of a lenient parse above.
    assert.match(puts[0].body, /"total_cost_usd":"0\.001234"/);
  });

  it("lands the edge rows, six columns and nothing from the task text", () => {
    const databasePath = withFixture(LEDGER);
    const { deps, puts } = harness({ databasePath });
    runExport(deps);
    const rows = parse(puts[1].body);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row), [...TASK_EDGE_COLUMNS]);
    }
    assert.deepEqual(rows[0], {
      task_id: "task-root",
      parent_task_id: null,
      dispatched_by_task_id: null,
      status: "completed",
      created_at: "2026-11-20T10:00:00.000Z",
      exported_at: "2026-11-23T09:15:00Z",
    });
    // Both edges, because which one the rollup follows is a dbt decision.
    assert.equal(rows[1].parent_task_id, "task-root");
    assert.equal(rows[1].dispatched_by_task_id, "task-root");
    for (const row of rows) {
      assert.ok(!("task" in row), "no task text may cross");
      assert.ok(!puts[1].body.includes("task text"));
    }
  });

  it("is JSON Lines: one object per line, no indentation, no nesting", () => {
    const body = toJsonLines(
      [{ id: "a", n: null }],
      ["id", "n", "exported_at"],
      "2026-11-23T09:15:00Z",
    );
    assert.equal(body, '{"id":"a","n":null,"exported_at":"2026-11-23T09:15:00Z"}\n');
    assert.equal(body.split("\n").filter(Boolean).length, 1);
  });
});

describe("export usage: the window", () => {
  it("reads seven days daily and ninety on the first of the month", () => {
    assert.equal(windowDaysFor(new Date("2026-11-23T09:15:00Z")), DAILY_WINDOW_DAYS);
    assert.equal(windowDaysFor(new Date("2026-12-01T09:15:00Z")), MONTHLY_WINDOW_DAYS);
    assert.equal(DAILY_WINDOW_DAYS, 7);
    assert.equal(MONTHLY_WINDOW_DAYS, 90);
  });

  it("bounds the window from the run's own start", () => {
    assert.equal(
      windowStart(new Date("2026-11-23T09:15:00.000Z"), 7),
      "2026-11-16T09:15:00.000Z",
    );
  });

  it("leaves a row older than the window out of the file, and one inside it in", () => {
    const databasePath = withFixture((db) => {
      LEDGER(db);
      db.exec(`INSERT INTO session_costs (
        id, sessionId, taskId, agentId, totalCostUsd, durationMs, numTurns, model,
        isError, costSource, createdAt
      ) VALUES ('cost-old', 'session-old', NULL, 'agent-1', 0.5, 10, 1, 'm', 0, 'harness', '2026-10-01T00:00:00.000Z')`);
    });
    const { deps, puts } = harness({ databasePath });
    runExport(deps);
    const ids = parse(puts[0].body).map((row) => row.id);
    assert.deepEqual(ids, ["cost-1", "cost-2"]);
  });
});

describe("export usage: failure is loud", () => {
  it("exits non-zero and writes nothing when the database lacks a column", () => {
    // The upstream shape before migration 320, which added `kind`.
    const withoutKind = UPSTREAM_SCHEMA.replace(
      "  kind TEXT NOT NULL DEFAULT 'harness',\n",
      "",
    );
    assert.notEqual(withoutKind, UPSTREAM_SCHEMA);
    const databasePath = withFixture((db) => {
      db.exec(`
        INSERT INTO agents (id, name, createdAt) VALUES ('agent-1', 'coder', '2026-10-01T00:00:00.000Z');
        INSERT INTO session_costs (
          id, sessionId, taskId, agentId, totalCostUsd, durationMs, numTurns, model,
          isError, costSource, createdAt
        ) VALUES ('cost-1', 'session-1', NULL, 'agent-1', 0.5, 10, 1, 'm', 0, 'harness', '2026-11-22T09:00:00.000Z');
      `);
    }, withoutKind);
    const { deps, puts, lines } = harness({ databasePath });
    const outcome = runExport(deps);

    assert.equal(outcome.exitCode, 1);
    assert.equal(puts.length, 0, "a read error must not write either file");
    assert.deepEqual(
      outcome.reports.map((report) => report.outcome),
      ["not-attempted", "not-attempted"],
    );
    assert.match(lines.join("\n"), /read failed, no object written/);
    assert.match(outcome.reports[0].error ?? "", /no such column/);
  });

  it("exits non-zero and writes nothing when the first PUT is refused", () => {
    // A prefix the role cannot write produces an AccessDenied from the CLI, which
    // `putObjectWithCli` turns into this shape.
    const databasePath = withFixture(LEDGER);
    const { deps, puts, lines } = harness({
      databasePath,
      put: () => ({ ok: false, error: "An error occurred (AccessDenied)" }),
    });
    const outcome = runExport(deps);

    assert.equal(outcome.exitCode, 1);
    assert.equal(puts.length, 0);
    assert.equal(outcome.reports[0].outcome, "failed");
    // The second table is not attempted: two objects cannot be atomic, and half a
    // run is worse than none of one.
    assert.equal(outcome.reports[1].outcome, "not-attempted");
    assert.match(lines.join("\n"), /upload failed/);
  });

  it("reports a second-table denial as a failure, having written the first", () => {
    // Section 8's "cost uploads, edge upload denied" sequence. The cost file
    // lands, the edge file does not, that day's tasks are rooted at themselves
    // until the next run's window heals it, and the run is red so it is visible.
    const databasePath = withFixture(LEDGER);
    let call = 0;
    const { deps } = harness({
      databasePath,
      put: () => {
        call += 1;
        return call === 1 ? { ok: true } : { ok: false, error: "An error occurred (AccessDenied)" };
      },
    });
    const outcome = runExport(deps);
    assert.equal(outcome.exitCode, 1);
    assert.deepEqual(
      outcome.reports.map((report) => report.outcome),
      ["uploaded", "failed"],
    );
  });

  it("treats a 412 as this second's file already existing, and exits zero", () => {
    const databasePath = withFixture(LEDGER);
    const { deps, lines } = harness({
      databasePath,
      put: () => ({ ok: false, alreadyExists: true }),
    });
    const outcome = runExport(deps);
    assert.equal(outcome.exitCode, 0, "a rerun inside one second is not a failure");
    assert.deepEqual(
      outcome.reports.map((report) => report.outcome),
      ["already-exists", "already-exists"],
    );
    assert.match(lines.join("\n"), /already exists, leaving it alone/);
  });

  it("fails the run when a row will not serialize", () => {
    // A BigInt in a row is a column whose declared type changed under the export:
    // JSON has no representation for it, so the write throws rather than landing
    // a wrong value. The read's shape is faked here because the real one is
    // covered above and the point is what serialization does with it.
    const { deps, puts } = harness({
      databasePath: "",
      readSnapshot: (() => ({
        session_cost: [{ id: "a", total_cost_usd: 10n }],
        task_edge: [],
      })) as unknown as ExporterDeps["readSnapshot"],
    });
    const outcome = runExport(deps);
    assert.equal(outcome.exitCode, 1);
    assert.equal(puts.length, 0);
    assert.equal(outcome.reports[0].outcome, "failed");
    assert.equal(outcome.reports[1].outcome, "not-attempted");
  });
});

describe("export usage: one snapshot", () => {
  it("runs both statements in one read transaction and closes before upload", () => {
    const databasePath = withFixture(LEDGER);
    const seen: string[] = [];
    const { deps, puts } = harness({
      databasePath,
      readSnapshot: ((fn: (reader: unknown) => unknown) => {
        const db = new DatabaseSync(databasePath, { readOnly: true });
        try {
          db.exec("BEGIN");
          const result = fn({
            query: (sql: string, params: readonly unknown[] = []) => {
              seen.push(sql);
              return db.prepare(sql).all(...(params as never[]));
            },
          });
          db.exec("COMMIT");
          // The connection is closed before any PUT happens, which is what makes
          // the read short enough not to starve a WAL checkpoint.
          assert.equal(puts.length, 0, "nothing is uploaded while the reader is open");
          return result;
        } finally {
          db.close();
        }
      }) as unknown as ExporterDeps["readSnapshot"],
    });
    runExport(deps);
    assert.equal(seen.length, 2, "two statements, and both inside the one transaction");
    assert.equal(puts.length, 2);
  });

  it("reads a consistent snapshot while the swarm writes", () => {
    // The property section 8 asks for, on a real WAL file: a live writer is not
    // blocked by the reader, and the reader keeps the snapshot it started with,
    // so a task deleted mid-read cannot leave a cost row without its edge.
    const databasePath = withFixture(LEDGER);
    const writer = new DatabaseSync(databasePath);
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      reader.exec("BEGIN");
      const before = reader.prepare("SELECT count(*) AS c FROM session_costs").get() as { c: number };
      assert.equal(before.c, 2);

      // Mid-read, from another connection and while the reader's transaction is
      // open: a delete of a task and an insert of a cost row.
      writer.exec("DELETE FROM agent_tasks WHERE id = 'task-child'");
      writer.exec(`INSERT INTO session_costs (
        id, sessionId, agentId, totalCostUsd, durationMs, numTurns, model, isError, costSource, createdAt
      ) VALUES ('cost-3', 'session-3', 'agent-1', 2.5, 10, 1, 'm', 0, 'harness', '2026-11-22T11:00:00.000Z')`);

      const after = reader.prepare("SELECT count(*) AS c FROM session_costs").get() as { c: number };
      assert.equal(after.c, 2, "the reader keeps its snapshot, so the new row is invisible to it");
      const tasks = reader.prepare("SELECT count(*) AS c FROM agent_tasks").get() as { c: number };
      assert.equal(tasks.c, 2, "and the deleted task is still visible to it");
      reader.exec("COMMIT");

      // The writer's work is committed and not blocked: the next reader sees it.
      const fresh = reader.prepare("SELECT count(*) AS c FROM session_costs").get() as { c: number };
      assert.equal(fresh.c, 3);
    } finally {
      reader.close();
      writer.close();
    }
  });
});

describe("export usage: the checked-in column pin", () => {
  // The loader's `LANDING_COLUMNS` in `gp-data-platform` is the authority for
  // these lists, and this repo cannot read that file in CI. A pinned copy fails on
  // a local edit, which is the earliest signal available; the cross-repo drift is
  // a stated gap, and the PR that changes one side says so.
  it("pins the cost file's landing keys", () => {
    assert.deepEqual([...SESSION_COST_COLUMNS], [
      "id",
      "session_id",
      "task_id",
      "agent_id",
      "agent_name",
      "model",
      "cost_source",
      "kind",
      "total_cost_usd",
      "harness_cost_usd",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "cache_write_5m_tokens",
      "cache_write_1h_tokens",
      "reasoning_output_tokens",
      "thinking_tokens",
      "duration_ms",
      "num_turns",
      "is_error",
      "created_at",
      "exported_at",
    ]);
  });

  it("pins the edge file's landing keys", () => {
    assert.deepEqual([...TASK_EDGE_COLUMNS], [
      "task_id",
      "parent_task_id",
      "dispatched_by_task_id",
      "status",
      "created_at",
      "exported_at",
    ]);
  });

  it("selects every landing key but exported_at from the database", () => {
    // A serializer key with no matching select alias would land a column of
    // nulls, which no other test here would notice.
    for (const table of EXPORTS) {
      const aliases = [...table.sql.matchAll(/\bAS ([a-z_0-9]+)/g)].map((match) => match[1]);
      assert.deepEqual(
        aliases,
        table.columns.filter((column) => column !== "exported_at"),
        `${table.table}: the select's aliases must be the landing columns, in order`,
      );
    }
  });

  it("never selects the columns the contract keeps out", () => {
    for (const forbidden of [
      "credentialKeyType",
      "credentialKeySuffix",
      "modelBreakdown",
      "harness,",
    ]) {
      assert.ok(!SESSION_COST_SQL.includes(forbidden), `session_costs: ${forbidden} must not be exported`);
    }
    // The edge SELECT names only `agent_tasks` columns, and none of them is a free
    // text one. Checked on the column references rather than as a substring
    // search, which "output" would pass on a rename and fail on a comment.
    const selected = [...TASK_EDGE_SQL.matchAll(/t\.([A-Za-z]+)\s+AS/g)].map((match) => match[1]);
    assert.deepEqual(selected, ["id", "parentTaskId", "dispatchedByTaskId", "status", "createdAt"]);
  });
});

describe("export usage: stamps and keys", () => {
  it("names the object from the run's UTC start", () => {
    const at = new Date("2026-11-23T09:15:00.000Z");
    assert.equal(compactStamp(at), "20261123T091500Z");
    assert.equal(exportedAtStamp(at), "2026-11-23T09:15:00Z");
    assert.equal(
      objectKey(EXPORTS[1], at),
      "delegate-swarm/task-edge/task-edge-20261123T091500Z.ndjson",
    );
    // A row's stamp and its file name are the same instant.
    assert.equal(compactStamp(at).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"), exportedAtStamp(at));
  });

  it("puts the stamped value on every row, overriding any column of the same name", () => {
    const row = toLandingRow(["id", "exported_at"], { id: "a", exported_at: "stale" }, "2026-11-23T09:15:00Z");
    assert.deepEqual(row, { id: "a", exported_at: "2026-11-23T09:15:00Z" });
    // A missing column is null rather than absent, so every row has the same keys.
    assert.deepEqual(toLandingRow(["id", "n"], { id: "a" }, "s"), { id: "a", n: null });
  });

  it("pins the bucket and region the terraform and loader sides must match", () => {
    assert.equal(BUCKET, "goodparty-workbench-bifrost-usage");
    assert.equal(REGION, "us-west-2");
  });
});

describe("export usage: the aws cli half", () => {
  // The failure path section 8 asks for, "a prefix it cannot write to", without
  // asking AWS anything: a stub `aws` on PATH that exits the way the CLI does on
  // a refusal, and a stub `docker` that answers the volume question.
  const withStubs = (stubs: Record<string, string>, fn: (env: NodeJS.ProcessEnv) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-export-stubs-"));
    for (const [name, body] of Object.entries(stubs)) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, body, { mode: 0o755 });
    }
    const previous = process.env.PATH;
    process.env.PATH = `${dir}:${previous}`;
    try {
      fn({ ...process.env, PATH: process.env.PATH });
    } finally {
      process.env.PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("reads the mountpoint from docker and appends the database file", () => {
    withStubs(
      { docker: "#!/bin/sh\nprintf '/var/lib/docker/volumes/agent-swarm_swarm_api_data/_data\\n'\n" },
      () => {
        assert.equal(
          databasePathFrom(volumeMountpoint("agent-swarm_swarm_api_data")),
          "/var/lib/docker/volumes/agent-swarm_swarm_api_data/_data/agent-swarm-db.sqlite",
        );
      },
    );
  });

  it("passes the conditional PUT, and reads a 412 as the file already existing", () => {
    const argsSeen: string[][] = [];
    const run = ((cmd: string, args: string[]) => {
      argsSeen.push([cmd, ...args]);
      return "";
    }) as unknown as typeof execFileSync;
    const result = putObjectWithCli(
      { bucket: "b", key: "k", body: "{}\n", region: "us-west-2" },
      run,
    );
    assert.deepEqual(result, { ok: true });
    const [cmd, ...args] = argsSeen[0];
    assert.equal(cmd, "aws");
    assert.equal(args[0], "s3api");
    assert.equal(args[1], "put-object");
    assert.ok(args.includes("--if-none-match"));
    assert.equal(args[args.indexOf("--if-none-match") + 1], "*");
    assert.equal(args[args.indexOf("--bucket") + 1], "b");
    assert.equal(args[args.indexOf("--key") + 1], "k");
    // The body went to a file, which is gone by now.
    const bodyPath = args[args.indexOf("--body") + 1];
    assert.match(bodyPath, /swarm-export-.+\/body\.ndjson$/);
    assert.equal(fs.existsSync(bodyPath), false, "the temp copy of the ledger must not be left behind");
  });

  it("turns the cli's 412 into already-exists rather than a failure", () => {
    const fail412 = (() => {
      const error = new Error("Command failed") as Error & { stderr: string };
      error.stderr =
        "\nAn error occurred (PreconditionFailed) when calling the PutObject operation: At least one of the pre-conditions you specified did not hold\n";
      throw error;
    }) as unknown as typeof execFileSync;
    assert.deepEqual(
      putObjectWithCli({ bucket: "b", key: "k", body: "", region: "us-west-2" }, fail412),
      { ok: false, alreadyExists: true },
    );
  });

  it("turns an access denied into a failure with the cli's own words", () => {
    const denied = (() => {
      const error = new Error("Command failed") as Error & { stderr: string };
      error.stderr =
        "\nAn error occurred (AccessDenied) when calling the PutObject operation: Access Denied\n";
      throw error;
    }) as unknown as typeof execFileSync;
    const result = putObjectWithCli({ bucket: "b", key: "k", body: "", region: "us-west-2" }, denied);
    assert.equal(result.ok, false);
    assert.equal("alreadyExists" in result && result.alreadyExists, false);
    assert.match(result.ok === false && !result.alreadyExists ? result.error : "", /AccessDenied/);
  });

  it("exits the run non-zero when the prefix it cannot write to refuses the first put", () => {
    // The whole path, end to end, with a stub `aws` that refuses: a real fixture
    // database is read, the cost file's PUT is refused, nothing is reported as
    // written, and the run is red.
    const databasePath = withFixture(LEDGER);
    const { deps, puts, lines } = harness({
      databasePath,
      put: (args) => putObjectWithCli({ ...args, region: "us-west-2" }),
    });
    withStubs(
      {
        aws: "#!/bin/sh\necho 'An error occurred (AccessDenied) when calling the PutObject operation: Access Denied' >&2\nexit 254\n",
      },
      () => {
        const outcome = runExport(deps);
        assert.equal(outcome.exitCode, 1, "an unwritable prefix is a failed unit");
        assert.equal(puts.length, 0);
        assert.deepEqual(
          outcome.reports.map((report) => report.outcome),
          ["failed", "not-attempted"],
        );
        assert.match(lines.join("\n"), /AccessDenied/);
      },
    );
  });
});
