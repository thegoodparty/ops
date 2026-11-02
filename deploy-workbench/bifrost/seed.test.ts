import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The seed script, run against a real Postgres.
 *
 * Step 2 of `docs/bifrost-zero-downtime-deploys.md`, decisions 3 and 18-19. The
 * script is shell, so this exercises it the way the task does: a real process,
 * a real `pg_dump`, a real `psql`, and two real databases. Nothing is stubbed,
 * because the properties that matter are all properties of the server rather
 * than of the script's text:
 *
 * - `CREATE DATABASE` cannot run inside a transaction (decision 19), so the
 *   create has to be its own statement and the restore has to be the
 *   transaction;
 * - a dump taken over the config store's tables in one repeatable-read
 *   transaction is a consistent snapshot while a writer is still writing, and
 *   that is the only reason the server-side `TEMPLATE` copy is not used
 *   (decision 3);
 * - the copy carries the `migrations` table, which is what stops the new task's
 *   startup from re-applying the copied schema (decision 18);
 * - the log store's rows are **not** copied, because the new colour never
 *   reads its own copy of them and they are the largest thing on the volume.
 *
 * The refusal cases are the ones that matter most, and each has its own test:
 * a target with content in it is refused rather than overwritten, and a target
 * that is already seeded is a no-op rather than a second restore. A
 * half-restored database left by a failed deploy is the case the retry has to
 * handle, so "empty but with leftovers" is tested as a reset rather than as a
 * refusal.
 *
 * Postgres is needed, and the suite is loud rather than silent when it is
 * absent. `SEED_TEST_PG_*` point the tests at a server; the defaults are a
 * throwaway cluster the test creates itself if `initdb` is on `PATH`. The
 * production path is PostgreSQL 16 (the RDS instance's major version), so the
 * tests prefer a `pg_dump` of that major: a newer client's `SET
 * transaction_timeout` is not understood by a 16 server, and a test that
 * passed on 17 while the task ran 16 would be a test of the wrong thing.
 */

const SCRIPT = path.resolve(__dirname, "seed.sh");

/** The environment the script reads. Every name is pinned by a test below. */
const ENV = {
  PGHOST: "PGHOST",
  PGPORT: "PGPORT",
  PGUSER: "PGUSER",
  PGPASSWORD: "PGPASSWORD",
  SOURCE: "SEED_SOURCE_DATABASE",
  TARGET: "SEED_TARGET_DATABASE",
  TABLES: "SEED_TABLES",
} as const;

const SOURCE_DB = "bifrost";

/**
 * The tables this deployment's config store owns, as the script ships them.
 *
 * Read from the script rather than duplicated here so that the test fails when
 * the script's list is edited without thought, which is the only drift this
 * half can catch: Bifrost's source is not vendored in this repo.
 * `seed-tables.ts` is the other half and the drift test that does the real
 * work.
 */
const scriptTables = (): string[] => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  const match = source.match(/^SEED_TABLES_DEFAULT='([^']+)'$/m);
  assert.ok(match, "seed.sh has no SEED_TABLES_DEFAULT");
  return match[1].split(/\s+/).filter((name) => name.length > 0);
};

type Pg = {
  host: string;
  port: string;
  user: string;
  password?: string;
};

/**
 * The Postgres client tools the seed uses, from the RDS instance's major
 * version wherever the machine keeps them.
 *
 * The production path is PostgreSQL 16 (`DATABASE_ENGINE_VERSION` in `rds.ts`).
 * The major matters: a newer `pg_dump` against a 16 server emits `SET
 * transaction_timeout`, which 16 rejects, so a suite that silently used 17
 * would be testing a toolchain the task does not run and would miss exactly that
 * class of failure. `/usr/lib/postgresql/16/bin` is where Debian puts it without
 * a `PATH` entry, so it is checked explicitly alongside `PATH`.
 *
 * Empty string when there is none, which is what makes the suite skip rather
 * than fail: the suite is about behaviour against a real server, and there is no
 * honest version of it without one.
 */
const PG_MAJOR = "16";
const PG_BIN_PREFIX = [
  "",
  `/usr/lib/postgresql/${PG_MAJOR}/bin/`,
  `/usr/pgsql-${PG_MAJOR}/bin/`,
].find(
  (prefix) =>
    spawnSync(`${prefix}initdb`, ["--version"], { encoding: "utf8" }).status ===
    0,
);
const PG_BIN = PG_BIN_PREFIX === undefined ? "" : PG_BIN_PREFIX;
const PG_AVAILABLE = PG_BIN_PREFIX !== undefined;
const pgBin = (name: string): string => `${PG_BIN}${name}`;

/**
 * The environment the seeded script runs with.
 *
 * `PATH` is prefixed with the resolved Postgres bin directory so the script's own
 * `psql` and `pg_dump` are the same major version as the server the tests
 * start. Without it a machine with a 15 client ahead of the 16 one in `PATH`
 * makes the script's restore fail on the 16 server's own dump -- which is the
 * "client no newer than the server" property asserted in
 * `bifrost-seed-image.test.ts`, arriving here as a confusing test failure.
 */
const pgEnv = (pg: Pg): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: PG_BIN ? `${PG_BIN}${path.delimiter}${process.env.PATH ?? ""}` : process.env.PATH,
  PGHOST: pg.host,
  PGPORT: pg.port,
  PGUSER: pg.user,
  ...(pg.password ? { PGPASSWORD: pg.password } : {}),
});

/** Run one `psql` and return trimmed stdout, failing the test on error. */
const psql = (pg: Pg, database: string, sql: string): string => {
  const result = spawnSync(
    pgBin("psql"),
    ["-v", "ON_ERROR_STOP=1", "-qtAX", "-d", database, "-c", sql],
    { env: pgEnv(pg), encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `psql failed for ${database}: ${result.stderr?.trim()}`,
  );
  return (result.stdout ?? "").trim();
};

const databaseExists = (pg: Pg, name: string): boolean =>
  psql(
    pg,
    "postgres",
    `SELECT 1 FROM pg_database WHERE datname = '${name}'`,
  ) === "1";

const rowCount = (pg: Pg, database: string, table: string): number => {
  const raw = psql(pg, database, `SELECT count(*) FROM ${table}`);
  return Number(raw);
};

type SeedResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const runSeed = (
  pg: Pg,
  options: { source?: string; target?: string; tables?: string[] } = {},
): SeedResult => {
  const result = spawnSync("/bin/sh", [SCRIPT], {
    env: {
      ...pgEnv(pg),
      [ENV.SOURCE]: options.source ?? SOURCE_DB,
      [ENV.TARGET]: options.target ?? "bifrost_seed_test",
      [ENV.TABLES]: (options.tables ?? scriptTables()).join(" "),
    },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

/**
 * A cluster of the test's own, or nothing.
 *
 * `before` skips the whole suite when there is no server and no `initdb`,
 * loudly: a silent skip in a long run reads as a pass, and this suite is the
 * only place the refusal behaviour is exercised.
 */
type Cluster = {
  pg: Pg;
  stop: () => void;
};

const SSI_REASON =
  "no Postgres for the seed tests: set SEED_TEST_PG_HOST/PORT/USER to a scratch server, or put initdb on PATH so this suite can create its own";

const startCluster = (): Cluster | null => {
  if (process.env.SEED_TEST_PG_HOST && process.env.SEED_TEST_PG_PORT) {
    return {
      pg: {
        host: process.env.SEED_TEST_PG_HOST,
        port: process.env.SEED_TEST_PG_PORT,
        user: process.env.SEED_TEST_PG_USER ?? "postgres",
        password: process.env.SEED_TEST_PG_PASSWORD,
      },
      stop: () => {},
    };
  }

  if (!PG_AVAILABLE) return null;

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "seed-test-pg-"));
  const data = path.join(directory, "data");
  const socket = path.join(directory, "socket");
  fs.mkdirSync(socket);

  const created = spawnSync(
    pgBin("initdb"),
    ["-D", data, "-U", "seed", "--auth=trust"],
    { encoding: "utf8" },
  );
  assert.equal(created.status, 0, created.stderr);

  // A port nothing else uses; the cluster is only reachable over loopback.
  const port = String(54000 + (process.pid % 1000));
  const started = spawnSync(
    pgBin("pg_ctl"),
    [
      "-D",
      data,
      "-o",
      `-p ${port} -k ${socket} -c listen_addresses=127.0.0.1`,
      "-l",
      path.join(directory, "log"),
      "-w",
      "start",
    ],
    { encoding: "utf8" },
  );
  assert.equal(started.status, 0, started.stderr ?? started.stdout);

  const leftOver = process.env.SEED_TEST_KEEP_CLUSTER === "1";
  const stop = (): void => {
    if (leftOver) {
      // The suite logs the directory itself rather than swallowing it.
      process.stderr.write(`seed tests: cluster kept at ${directory}\n`);
      return;
    }
    spawnSync(pgBin("pg_ctl"), ["-D", data, "-m", "immediate", "stop"], {
      encoding: "utf8",
    });
    fs.rmSync(directory, { recursive: true, force: true });
  };

  return { pg: { host: "127.0.0.1", port, user: "seed" }, stop };
};

/**
 * The live-Postgres suites, skipped rather than silently passed when there is no
 * server.
 *
 * `{ skip: reason }` is the repo's idiom for this
 * (`deploy-infrastructure/group-sync-integration.test.ts`): a per-test early
 * return that asserts nothing reads as a pass in a long `npm test` run, which is
 * the failure it would be hiding. `describe` reports the skip count and the
 * reason, and the `console.error` makes it visible in the log too.
 */
const cluster = startCluster();
const pg: Pg = cluster?.pg ?? { host: "", port: "", user: "" };
const LIVE = { skip: cluster ? false : SSI_REASON };

if (!cluster) {
  console.error(`[seed tests] SKIPPED: ${SSI_REASON}`);
}

describe("seed.sh", () => {
  before(() => {
    if (!cluster) return;
    psql(pg, "postgres", `CREATE DATABASE ${SOURCE_DB}`);
    // The config store's own tables, plus two the log store owns. The split is
    // the point: a whole-database dump would carry the `logs` rows too.
    //
    // Every table `seed.sh` lists is created and does not have to have the
    // source's real columns: what these tests are about is which tables travel
    // and whether the copy is faithful, not the shape of a table Bifrost owns.
    // `seed-tables.test.ts` is where the list's provenance is pinned.
    const tables = scriptTables();
    const statements = [
      `CREATE TABLE migrations (id varchar(255) PRIMARY KEY, seq int, applied_at timestamptz, status varchar(50))`,
      `INSERT INTO migrations VALUES ('cs-0001', 1, now(), 'applied'), ('ls-0001', 2, now(), 'applied')`,
      `CREATE TABLE governance_budgets (id varchar(255) PRIMARY KEY, current_usage float8 DEFAULT 0, last_reset timestamptz)`,
      `INSERT INTO governance_budgets VALUES ('budget-a', 12.5, now()), ('budget-b', 41.25, now())`,
      `CREATE TABLE governance_virtual_keys (id varchar(255) PRIMARY KEY, name text, budget_id varchar(255))`,
      `INSERT INTO governance_virtual_keys VALUES ('vk-a', 'one', 'budget-a'), ('vk-b', 'two', 'budget-b')`,
      // A serial primary key: `pg_dump -t` has to carry the sequence and its
      // value, or the copy hands out an id the source already used.
      `CREATE TABLE config_keys (id serial PRIMARY KEY, name text)`,
      `INSERT INTO config_keys (name) VALUES ('k1'), ('k2')`,
      // The log store's tables, which share this database today and must not
      // travel.
      `CREATE TABLE logs (id varchar(255) PRIMARY KEY, ts timestamptz)`,
      `INSERT INTO logs SELECT 'log-' || g, now() FROM generate_series(1, 500) g`,
      `CREATE TABLE matview_refresh_state (id varchar(255) PRIMARY KEY)`,
      `INSERT INTO matview_refresh_state VALUES ('mv1')`,
    ];
    for (const statement of statements) psql(pg, SOURCE_DB, statement);

    // Every other name the script ships gets a table with one row, so a table
    // the script lists and the fixture forgot is a failure rather than a
    // silently empty comparison.
    for (const table of tables) {
      if (["migrations", "governance_budgets", "governance_virtual_keys", "config_keys"].includes(table)) continue;
      psql(pg, SOURCE_DB, `CREATE TABLE ${table} (id varchar(255) PRIMARY KEY)`);
      psql(pg, SOURCE_DB, `INSERT INTO ${table} VALUES ('only-row')`);
    }
  });

  after(() => {
    cluster?.stop();
  });

  describe("the table set", LIVE, () => {
    it("copies every config-store table it lists, and no log-store table", () => {
      const tables = scriptTables();
      // The two log-store tables the fixture has. They share the database with
      // the config store today, and copying them doubles the largest object on
      // a 20 GiB volume for rows the new colour never reads.
      for (const logTable of ["logs", "matview_refresh_state"]) {
        assert.ok(
          !tables.includes(logTable),
          `seed.sh copies the log-store table ${logTable}`,
        );
      }
      // `migrations` is the one shared table and it has to be copied: it is
      // what records the copied schema as already migrated (decision 18).
      assert.ok(
        tables.includes("migrations"),
        "seed.sh does not copy migrations, so the new task re-applies the copied schema",
      );
      const result = runSeed(pg, { target: "bifrost_seed_tables" });
      assert.equal(result.status, 0, result.stderr);
      for (const table of tables) {
        assert.equal(
          rowCount(pg, "bifrost_seed_tables", table),
          rowCount(pg, SOURCE_DB, table),
          `${table} did not arrive with the source's rows`,
        );
      }
      for (const logTable of ["logs", "matview_refresh_state"]) {
        assert.equal(
          Number(
            psql(
              pg,
              "bifrost_seed_tables",
              `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '${logTable}'`,
            ),
          ),
          0,
          `${logTable} was copied into the colour`,
        );
      }
      psql(pg, "postgres", "DROP DATABASE bifrost_seed_tables");
    });

    it("carries governance_budgets.current_usage across unchanged", () => {
      const result = runSeed(pg, { target: "bifrost_seed_usage" });
      assert.equal(result.status, 0, result.stderr);
      // The number the plan's success criterion 4 is about: a key's recorded
      // usage is the usage it had before the deploy.
      assert.equal(
        psql(
          pg,
          "bifrost_seed_usage",
          "SELECT current_usage FROM governance_budgets WHERE id = 'budget-a'",
        ),
        "12.5",
      );
      assert.equal(
        psql(
          pg,
          "bifrost_seed_usage",
          "SELECT round(sum(current_usage)::numeric, 2) FROM governance_budgets",
        ),
        "53.75",
      );
      psql(pg, "postgres", "DROP DATABASE bifrost_seed_usage");
    });

    it("carries the sequence a serial column depends on", () => {
      const result = runSeed(pg, { target: "bifrost_seed_seq" });
      assert.equal(result.status, 0, result.stderr);
      // Two rows in the source, so the next id must be 3. A copy that lost the
      // sequence would hand out 1 again and collide with a real row the first
      // time the new colour inserted a key.
      assert.equal(
        psql(
          pg,
          "bifrost_seed_seq",
          "INSERT INTO config_keys (name) VALUES ('k3') RETURNING id",
        ),
        "3",
      );
      psql(pg, "postgres", "DROP DATABASE bifrost_seed_seq");
    });

    it("creates the target database when it does not exist", () => {
      assert.equal(databaseExists(pg, "bifrost_seed_create"), false);
      const result = runSeed(pg, { target: "bifrost_seed_create" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(databaseExists(pg, "bifrost_seed_create"), true);
      psql(pg, "postgres", "DROP DATABASE bifrost_seed_create");
    });
  });

  describe("the refusal cases", LIVE, () => {
    it("refuses to overwrite a target that already has content", () => {
      const target = "bifrost_seed_refuse";
      psql(pg, "postgres", `CREATE DATABASE ${target}`);
      // A colour with records in it is a colour something is serving from, or
      // a colour a human seeded on purpose. Either way it is not ours to
      // overwrite: a re-run that restored over it would drop the rows the new
      // task has written since the first seed.
      psql(
        pg,
        target,
        "CREATE TABLE governance_virtual_keys (id varchar(255) PRIMARY KEY)",
      );
      psql(
        pg,
        target,
        "INSERT INTO governance_virtual_keys VALUES ('minted-since-the-seed')",
      );

      const result = runSeed(pg, { target });
      assert.notEqual(result.status, 0, "the seed overwrote a non-empty target");
      assert.match(
        result.stderr,
        /already has content|refus/i,
        `the refusal did not explain itself: ${result.stderr}`,
      );
      // Refused, not truncated: the row that was there is still there.
      assert.equal(rowCount(pg, target, "governance_virtual_keys"), 1);
      psql(pg, "postgres", `DROP DATABASE ${target}`);
    });

    it("refuses a target with content across several tables", () => {
      // The case the single-table fixture above cannot see, and it is the one
      // that ships. The emptiness probe is built per table and joined by the
      // server; the first version joined the arms with `UNION ALL` around a
      // `LIMIT`, which PostgreSQL rejects -- so it worked on one table and was a
      // syntax error on two. Every real colour has dozens.
      //
      // Worse, the failure was silent in the direction that matters: a failed
      // probe returned nothing, which reads exactly like an empty database, and
      // an *empty* target takes the reset path and is dropped. So the bug's real
      // shape was "a target with rows in one of several tables gets dropped and
      // re-seeded". This test puts the rows in the table that is NOT first, so a
      // probe that only inspected one table fails it too.
      const target = "bifrost_seed_refuse_multi";
      psql(pg, "postgres", `CREATE DATABASE ${target}`);
      // `aaa_empty` sorts before `zzz_populated`, so the probe sees an empty
      // table first.
      psql(pg, target, "CREATE TABLE aaa_empty (id varchar(255) PRIMARY KEY)");
      psql(pg, target, "CREATE TABLE zzz_populated (id varchar(255) PRIMARY KEY)");
      psql(pg, target, "INSERT INTO zzz_populated VALUES ('a-row') ");

      const result = runSeed(pg, { target });
      assert.notEqual(
        result.status,
        0,
        "the seed dropped a target that had rows in one of several tables",
      );
      // The *right* refusal, not just any failure. A probe that does not run
      // also exits non-zero, and that is the state the first version of this
      // probe produced: the script's `|| fail` caught the syntax error, so the
      // run failed for the wrong reason and the test above could not tell. The
      // message is the difference between "this colour has content" and "I could
      // not tell whether it has content".
      assert.match(
        result.stderr,
        /already has content/,
        `expected the content refusal, got: ${result.stderr}`,
      );
      assert.doesNotMatch(
        result.stderr,
        /did not run|could not build/,
        `the emptiness probe failed rather than answering: ${result.stderr}`,
      );
      // The rows survived, which is the property: refused, not truncated.
      assert.equal(rowCount(pg, target, "zzz_populated"), 1);
      psql(pg, "postgres", `DROP DATABASE ${target}`);
    });

    it("restores inside one transaction, so a failure leaves nothing", () => {
      // Decision 19's promise, in two halves, because the end-to-end failure
      // cannot be contrived from a valid dump: the reset drops the target, so
      // the restore always starts from zero tables and a `pg_dump` of a healthy
      // store produces SQL that loads. Every failure that matters in practice --
      // a dropped connection, a disk full, a statement the target rejects -- is
      // one nothing in the dump predicts.
      //
      // So: the semantics, measured on this server; and the flag, pinned where
      // the script uses it. Together they cover the property, and neither is a
      // simulation of the other.
      //
      // This matters because plain `pg_dump` output carries no BEGIN/COMMIT
      // (measured: none in a dump of two tables), and data is loaded before the
      // post-data section. Without the flag a failure after the first `COPY`
      // commits those rows, the next run's probe correctly sees content, and the
      // retry decision 19 promises needs a human with `DROP DATABASE`.
      const statement = [
        "CREATE TABLE landed (id int);",
        "INSERT INTO landed VALUES (1);",
        "SELECT 1 / 0;",
      ].join("\n");
      const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "seed-rollback-")),
        "fail.sql",
      );
      fs.writeFileSync(file, statement);

      const restore = (target: string, flags: string[]): void => {
        psql(pg, "postgres", `CREATE DATABASE ${target}`);
        const result = spawnSync(
          pgBin("psql"),
          [
            "-q",
            "-v",
            "ON_ERROR_STOP=1",
            "-o",
            "/dev/null",
            ...flags,
            "-d",
            target,
            "-f",
            file,
          ],
          { env: pgEnv(pg), encoding: "utf8" },
        );
        assert.notEqual(result.status, 0, "the failing statement did not fail");
      };

      // Without the flag: the rows the earlier statements wrote are still there.
      // This is the state that makes the next run refuse.
      restore("bifrost_seed_no_txn", []);
      assert.equal(
        psql(
          pg,
          "bifrost_seed_no_txn",
          "SELECT to_regclass('public.landed') IS NOT NULL",
        ),
        "t",
        "expected the unwrapped statements to commit; if they did not, this test proves nothing",
      );

      // With it: nothing the failed run did survives.
      restore("bifrost_seed_one_txn", ["--single-transaction"]);
      assert.equal(
        psql(
          pg,
          "bifrost_seed_one_txn",
          "SELECT to_regclass('public.landed') IS NOT NULL",
        ),
        "f",
        "--single-transaction did not roll the failed restore back, so the convergent retry is broken",
      );

      // And the script's own restore carries the flag, which is what puts the
      // measured semantics in the task rather than in this test.
      const restoreLine = fs
        .readFileSync(SCRIPT, "utf8")
        .split("\n")
        .find((line) => /^\s*psql\b.*-f "\$dump_file"/.test(line));
      assert.ok(restoreLine, "the seed has no restore invocation");
      assert.match(
        restoreLine,
        /--single-transaction/,
        "the restore does not run in one transaction, so a failed deploy leaves rows behind and the next seed refuses instead of resetting",
      );
      assert.match(restoreLine, /ON_ERROR_STOP/);

      psql(pg, "postgres", "DROP DATABASE bifrost_seed_no_txn");
      psql(pg, "postgres", "DROP DATABASE bifrost_seed_one_txn");
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    });

    it("refuses a target that is the source, so a colour cannot seed itself", () => {
      // A colour that seeds itself drops and restores the database the running
      // task has open. It is one edit away from a typo, so it is refused by
      // name rather than left to the dump failing.
      const result = runSeed(pg, { source: SOURCE_DB, target: SOURCE_DB });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /same|itself/i, result.stderr);
      assert.equal(rowCount(pg, SOURCE_DB, "governance_budgets"), 2);
    });

    it("refuses a target name that is not a plain identifier", () => {
      // Every statement in the script that names the target is interpolated,
      // because `psql -c` cannot parameterize an identifier. The allowlist is
      // therefore the guard, and it has to be checked before anything runs.
      for (const target of [
        "bifrost; DROP DATABASE bifrost",
        "bifrost_blue'",
        "bifrost-green",
        "bifrost_ blue",
      ]) {
        const result = runSeed(pg, { target });
        assert.notEqual(result.status, 0, `accepted ${target}`);
        assert.match(result.stderr, /identifier|refus/i, result.stderr);
      }
      assert.equal(databaseExists(pg, SOURCE_DB), true);
    });
  });

  describe("the snapshot", LIVE, () => {
    it("proves the server-side copy is refused while the source is in use", () => {
      // The plan's step 2 proof, run rather than quoted: "the server-side
      // alternative does not work while the source serves". `TEMPLATE` refuses
      // the copy while any session is connected to the template, and the
      // serving task always has a pool open, so decision 3's cheap copy is not
      // available even in principle. This is the test that keeps that claim
      // honest if a future reader proposes it again.
      const holder = spawn(
        pgBin("psql"),
        ["-qtAX", "-d", SOURCE_DB, "-c", "SELECT pg_sleep(6)"],
        { env: pgEnv(pg), stdio: "ignore" },
      );
      try {
        // Wait for the holder's own session to appear rather than sleeping a
        // fixed guess. It is the only session on the source while it runs, so
        // `> 0` is the condition; the seed has not connected to it.
        const deadline = Date.now() + 5000;
        let connected = false;
        while (!connected && Date.now() < deadline) {
          connected =
            Number(
              psql(
                pg,
                "postgres",
                `SELECT count(*) FROM pg_stat_activity WHERE datname = '${SOURCE_DB}'`,
              ),
            ) > 0;
        }
        assert.ok(connected, "the holder session never connected");

        const copy = spawnSync(
          pgBin("psql"),
          [
            "-qtAX",
            "-d",
            "postgres",
            "-c",
            `CREATE DATABASE bifrost_template_probe TEMPLATE ${SOURCE_DB}`,
          ],
          { env: pgEnv(pg), encoding: "utf8" },
        );
        assert.notEqual(
          copy.status,
          0,
          "TEMPLATE succeeded against a database with a session on it, which contradicts decision 3",
        );
        assert.match(
          copy.stderr,
          /being accessed by other users/,
          `expected Postgres to refuse the template copy, got: ${copy.stderr}`,
        );
      } finally {
        holder.kill();
      }
      assert.equal(databaseExists(pg, "bifrost_template_probe"), false);
    });

    it("fails loudly when a listed table does not exist in the source", () => {
      // The property the ruling in `seed-tables.ts` rests on, and it had to be
      // built rather than assumed: `pg_dump -t` is **not** an error when one of
      // several `-t` patterns matches nothing. Measured against PostgreSQL 16,
      // `pg_dump -t governance_budgets -t no_such_table` exits 0 with a valid
      // dump of the one table -- so a drifted table list would produce a colour
      // with a table quietly missing, which is the failure the ruling forbids.
      // The script's own existence check per table is what turns it into a
      // failed run, and this is the test that keeps that check.
      const result = runSeed(pg, {
        target: "bifrost_seed_missing",
        tables: ["governance_budgets", "no_such_table_in_this_store"],
      });
      assert.notEqual(result.status, 0, "a missing table did not fail the seed");
      assert.match(result.stderr, /has no table 'no_such_table_in_this_store'/);
      // The check runs before the dump, so the target is not even created.
      assert.equal(
        databaseExists(pg, "bifrost_seed_missing"),
        false,
        "the seed created a database after the table check failed",
      );
    });

    it("refuses a copy whose source has a table the seed does not account for", () => {
      // The failure mode a Bifrost bump creates, caught on the path it actually
      // takes. The check is on the **source**, not the copy: the copy is created
      // by this script, so a comparison against it can only see what the restore
      // put there, while the source carries the release's real schema. This is
      // the assertion that keeps the check on the right side, and it is why the
      // seed refuses before it writes anything.
      psql(
        pg,
        SOURCE_DB,
        "CREATE TABLE a_table_a_newer_release_added (id int)",
      );
      try {
        const result = runSeed(pg, { target: "bifrost_seed_unaccounted" });
        assert.notEqual(
          result.status,
          0,
          "the seed copied a store that had a table it does not know about",
        );
        assert.match(result.stderr, /does not account for/);
        assert.match(result.stderr, /a_table_a_newer_release_added/);
        // Refused before any write: the target was not even created.
        assert.equal(databaseExists(pg, "bifrost_seed_unaccounted"), false);
      } finally {
        psql(pg, SOURCE_DB, "DROP TABLE a_table_a_newer_release_added");
      }
    });

    it("lets an operator accept the uncopied tables after looking", () => {
      // The escape hatch has to exist, or a legitimate new table would block
      // every deploy between the bump and the list being updated. It is a
      // one-run environment value, not a default.
      psql(
        pg,
        SOURCE_DB,
        "CREATE TABLE a_table_a_newer_release_added (id int)",
      );
      try {
        const result = spawnSync("/bin/sh", [SCRIPT], {
          env: {
            ...pgEnv(pg),
            [ENV.SOURCE]: SOURCE_DB,
            [ENV.TARGET]: "bifrost_seed_allowed",
            [ENV.TABLES]: scriptTables().join(" "),
            SEED_ALLOW_UNCOPIED_TABLES: "1",
          },
          encoding: "utf8",
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /SEED_ALLOW_UNCOPIED_TABLES=1/);
        psql(pg, "postgres", "DROP DATABASE bifrost_seed_allowed");
      } finally {
        psql(pg, SOURCE_DB, "DROP TABLE a_table_a_newer_release_added");
      }
    });

    it("dumps inside one repeatable-read transaction", () => {
      // The reason `CREATE DATABASE ... TEMPLATE` is not used (decision 3):
      // the template is the database the serving task has open, and Postgres
      // refuses the copy while any session is connected to it. A logical dump
      // in one repeatable-read transaction is a consistent snapshot of a
      // database in use -- and it is `pg_dump`'s own default, which is a
      // property worth pinning because a flag that changed it would silently
      // drop that guarantee.
      const source = fs.readFileSync(SCRIPT, "utf8");
      // Comments explain the alternatives that were rejected, including the
      // `TEMPLATE` copy this file deliberately does not use, so the assertions
      // below read the code only.
      const code = source
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      assert.ok(
        !/--serializable-deferrable/.test(code),
        "the seed enables serializable-deferrable, which is a stronger lock than the seed needs",
      );
      // `--single-transaction` is the *restore's* flag and must be there: it is
      // what makes a failed restore roll back to a shape the next run resets
      // (see the rollback test). It is not the dump's: `pg_dump` already wraps
      // its own dump in one transaction, and the flag on that side would be a
      // different guarantee wearing the same name.
      const dumpLine = code
        .split("\n")
        .find((line) => /^\s*pg_dump\b/.test(line));
      assert.ok(dumpLine, "the seed has no pg_dump call");
      assert.doesNotMatch(
        dumpLine,
        /--single-transaction|(^|\s)-1(\s|$)/,
        "the dump passes --single-transaction; pg_dump's own dump is already one transaction, and the flag belongs on the restore",
      );
      assert.ok(
        !/--exclude-table-data/.test(code),
        "the seed excludes table data rather than listing tables; a list of what to copy fails loudly, a list of what to exclude fails silently",
      );
      assert.ok(
        !/CREATE DATABASE[^\n]*TEMPLATE/i.test(code),
        "the seed uses CREATE DATABASE ... TEMPLATE, which Postgres refuses while the serving task holds the source database open",
      );

      // The two that matter, and each is the whole reason a flag would be
      // wrong here: a snapshot has to come from `pg_dump`'s own one-transaction
      // dump, and a list of what to *copy* fails loudly when it is missing
      // something while a list of what to *exclude* fails silently.
      const dump = spawnSync(
        pgBin("pg_dump"),
        [
          "-d",
          SOURCE_DB,
          "--table=migrations",
          "--table=governance_budgets",
        ],
        { env: pgEnv(pg), encoding: "utf8" },
      );
      assert.equal(dump.status, 0, dump.stderr);
      assert.equal(
        (dump.stdout.match(/^COPY public\./gm) ?? []).length,
        2,
        "one COPY per table -- the dump is a single pass rather than a query per row",
      );
      assert.match(
        dump.stdout,
        /COPY public\.governance_budgets/,
        "the dump has no data for a table the seed is about",
      );
    });
  });

  describe("the credentials the task definition injects", LIVE, () => {
    // The bug this suite missed on its first pass, and the one an ECS run would
    // have hit immediately: the task injects `PG_HOST`/`PG_PORT`/`PG_USER`/
    // `PG_PASSWORD` (Bifrost's names, from `config.json`), while libpq reads
    // `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`. The tests set the libpq names
    // directly and the task-definition test checked the `PG_*` names, so neither
    // saw that nothing converted one to the other. Only the union fails.
    const TASK_NAMES: Array<[string, string]> = [
      ["PG_HOST", "PGHOST"],
      ["PG_PORT", "PGPORT"],
      ["PG_USER", "PGUSER"],
      ["PG_PASSWORD", "PGPASSWORD"],
    ];

    it("maps every task-definition name onto the libpq name it stands for", () => {
      const source = fs.readFileSync(SCRIPT, "utf8");
      for (const [taskName, libpqName] of TASK_NAMES) {
        // The mapping has to be an assignment from the task's name, not a
        // mention in a comment: a `grep` for `PGHOST` passes on a script that
        // mentions it and never sets it, which is what the first version did.
        assert.match(
          source,
          new RegExp(`export ${libpqName}="\\$${taskName}"`),
          `seed.sh does not map ${taskName} onto ${libpqName}, so libpq falls back to a local socket the container does not have`,
        );
      }
    });

    it("connects when given only the task definition's names", () => {
      // The behavioural half, which is what makes the textual check above more
      // than a spelling test: the environment has the task's names and none of
      // libpq's, exactly as ECS would build it.
      const result = spawnSync("/bin/sh", [SCRIPT], {
        env: {
          PATH: PG_BIN
            ? `${PG_BIN}${path.delimiter}${process.env.PATH ?? ""}`
            : process.env.PATH,
          PG_HOST: pg.host,
          PG_PORT: pg.port,
          PG_USER: pg.user,
          ...(pg.password ? { PG_PASSWORD: pg.password } : {}),
          [ENV.SOURCE]: SOURCE_DB,
          [ENV.TARGET]: "bifrost_seed_tasknames",
          // The full list, so the source-coverage check does not answer first:
          // this test is about the connection, not the table set.
          [ENV.TABLES]: scriptTables().join(" "),
        },
        encoding: "utf8",
      });
      assert.equal(
        result.status,
        0,
        `the seed could not connect when given only the task definition's PG_* names: ${result.stderr}`,
      );
      assert.equal(
        rowCount(pg, "bifrost_seed_tasknames", "governance_budgets"),
        2,
      );
      psql(pg, "postgres", "DROP DATABASE bifrost_seed_tasknames");
    });

    it("does not overwrite libpq's own variables with an empty string", () => {
      // The mapping is conditional, which is what lets the script run from a
      // shell that already has libpq's variables exported.
      const source = fs.readFileSync(SCRIPT, "utf8");
      for (const taskName of ["PG_HOST", "PG_PORT", "PG_USER", "PG_PASSWORD"]) {
        assert.ok(
          source.includes(`if [ -n "\${${taskName}:-}" ]`),
          `the mapping for ${taskName} is unconditional, so an unset value would clobber a real libpq variable`,
        );
      }
    });
  });

  describe("credentials", LIVE, () => {
    it("names no password on any command line", () => {
      // The connection mechanism itself is pinned by the `the credentials the task
      // definition injects` suite above. This is the separate property that the
      // password never reaches an argument list -- `ps` on a task is not
      // private -- so there is no URL and no `password=...` flag, only libpq's
      // own environment variable.
      const code = fs
        .readFileSync(SCRIPT, "utf8")
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      assert.ok(
        !/password=['\"]/.test(code),
        "seed.sh puts a password on a command line, where `ps` can read it",
      );
      assert.ok(
        !/postgres:\/\//.test(code),
        "seed.sh builds a connection URL, which would put the password in its arguments",
      );
      // It is read from the environment and exported, never echoed.
      assert.ok(!/echo[^\n]*\$PGPASSWORD|printf[^\n]*\$PGPASSWORD/.test(code));
    });

    it("never prints the password", () => {
      const password = "seed-test-password-do-not-print";
      const result = spawnSync("/bin/sh", [SCRIPT], {
        env: {
          ...pgEnv(pg),
          PGPASSWORD: password,
          [ENV.SOURCE]: SOURCE_DB,
          [ENV.TARGET]: "bifrost_seed_secret",
          [ENV.TABLES]: scriptTables().join(" "),
        },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        !result.stdout.includes(password) && !result.stderr.includes(password),
        "the seed printed the database password",
      );
      psql(pg, "postgres", "DROP DATABASE bifrost_seed_secret");
    });
  });

  describe("the wall clock", LIVE, () => {
    it("prints the dump duration, because the plan's overlap estimate needs it", () => {
      const result = runSeed(pg, { target: "bifrost_seed_clock" });
      assert.equal(result.status, 0, result.stderr);
      // The number the plan's "Consequences" section is missing. It is a
      // deliverable rather than a nicety: the overlap window starts when the
      // dump starts, so a dump that takes a minute is a minute of lost writes.
      assert.match(
        result.stdout,
        /dump took \d+\.\d+s/,
        `the seed did not report its dump duration: ${result.stdout}`,
      );
      assert.match(result.stdout, /restore took \d+\.\d+s/);
      psql(pg, "postgres", "DROP DATABASE bifrost_seed_clock");
    });
  });

  describe("the image's userland, which is not this machine's", () => {
    // The pinned Bifrost image is Alpine, so the shell is busybox ash and the
    // core utilities are busybox's. Both differ from a GNU userland in ways that
    // only appear in the running task, and each of these bit this script once:
    //
    //   - `date +%s%N` prints a literal `%N` rather than nanoseconds, so a
    //     timer built on it reports zero seconds;
    //   - `$SECONDS` is unset in busybox ash;
    //   - `mktemp` refuses a template that does not end in exactly `XXXXXX`, so
    //     `mktemp /tmp/x-XXXXXX.sql` exits 1.
    //
    // Each is asserted against the script's text, because a test that ran under
    // the local /bin/sh would pass on all three.
    it("does not time anything with date +%N or $SECONDS", () => {
      const source = fs.readFileSync(SCRIPT, "utf8");
      const code = source
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      assert.ok(
        !/%N/.test(code),
        "the seed times something with `date +%N`, which busybox prints literally",
      );
      assert.ok(
        !/\$SECONDS|\$\{SECONDS\}/.test(code),
        "the seed times something with $SECONDS, which busybox ash leaves unset",
      );
      // What it uses instead, and the reason: seconds since boot, which every
      // kernel has and no userland can get wrong.
      assert.match(code, /\/proc\/uptime/);
    });

    it("creates its temporary dump with a template busybox mktemp accepts", () => {
      const source = fs.readFileSync(SCRIPT, "utf8");
      // The assignment, not the mention in the comment or in the trap: the
      // comment above it quotes the broken form on purpose.
      const match = source.match(/^dump_file="\$\(mktemp (\S+)\)"$/m);
      assert.ok(match, "the seed does not assign its temporary file from mktemp");
      assert.match(
        match[1],
        /XXXXXX$/,
        `mktemp template ${match[1]} does not end in XXXXXX; busybox refuses any other shape with "Invalid argument"`,
      );
    });
  });
});
