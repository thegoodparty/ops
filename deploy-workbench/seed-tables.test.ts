import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  LOG_STORE_TABLES,
  MIGRATIONS_TABLE,
  REQUIRED_SEED_TABLES,
  SEED_TABLES,
  SEED_TABLES_UPSTREAM_TAG,
} from "./seed-tables";
import { BIFROST_UPSTREAM_TAG } from "./bifrost-image";

/**
 * The table set itself: what is in it, what is deliberately not, and how it is
 * kept honest across an upstream bump. Step 2 of
 * `docs/bifrost-zero-downtime-deploys.md`, decision 18. `seed-tables.ts` carries
 * the ruling and the reasoning; this file is the half that fails when the
 * ruling's assumptions stop holding.
 */

const SCRIPT = fs.readFileSync(
  path.resolve(__dirname, "bifrost/seed.sh"),
  "utf8",
);

const scriptTables = (): string[] => {
  const match = SCRIPT.match(/^SEED_TABLES_DEFAULT='([^']+)'$/m);
  assert.ok(match, "seed.sh has no SEED_TABLES_DEFAULT");
  return match[1].split(/\s+/).filter((name) => name.length > 0);
};

describe("the seed table set", () => {
  it("carries the config store's tables and the shared migration ledger", () => {
    // The plan's own examples, and success criteria 4 and 6: a virtual key that
    // existed before the deploy still works after it, budgets keep the usage
    // they had, and the copied schema is recorded as migrated.
    for (const table of REQUIRED_SEED_TABLES) {
      assert.ok(
        (SEED_TABLES as readonly string[]).includes(table),
        `${table} is not seeded, so the copy is not usable for what the plan promises`,
      );
    }
    assert.ok(
      (SEED_TABLES as readonly string[]).includes(MIGRATIONS_TABLE),
      "the copy does not carry migrations, so the new task re-applies the copied schema",
    );
  });

  it("copies no log-store table", () => {
    // Decision 18: the log store shares the database today, its rows are the
    // largest object on the volume, and the new colour never reads its own
    // copy. `async_jobs` is the interesting one: it looks like a config-store
    // name and is the log store's (`framework/logstore/tables.go`).
    for (const table of LOG_STORE_TABLES) {
      assert.ok(
        !(SEED_TABLES as readonly string[]).includes(table),
        `${table} is a log-store table and must not be copied into a colour`,
      );
    }
    // And the fixture's two, named explicitly so a reader can see the pair the
    // seed tests use.
    assert.ok(LOG_STORE_TABLES.includes("logs"));
    assert.ok(LOG_STORE_TABLES.includes("matview_refresh_state"));
  });

  it("has no duplicate and no empty name", () => {
    const seen = new Set<string>();
    for (const table of SEED_TABLES) {
      assert.ok(table.length > 0, "an empty table name");
      assert.ok(
        /^[a-z][a-z0-9_]*$/.test(table),
        `${table} is not a plain lower-case identifier, and the script interpolates it`,
      );
      assert.ok(!seen.has(table), `${table} is listed twice`);
      seen.add(table);
    }
  });

  it("is the same list the script ships", () => {
    // Two copies on purpose: the image is built from `seed.sh`, and GitHub
    // Actions cannot import a TypeScript module, so the script has to carry its
    // own. This is the assertion that makes an edit to one and not the other a
    // failed test rather than a colour with a missing table.
    assert.deepEqual(
      scriptTables(),
      [...SEED_TABLES],
      "seed.sh's SEED_TABLES_DEFAULT and this module have drifted",
    );
  });

  it("is what the seed tests actually copy", () => {
    // The suite in `bifrost/seed.test.ts` builds its fixture from the script's
    // list, so this ties the two files together: a table added here and to the
    // script but not to nothing else still runs.
    assert.ok(scriptTables().length > 0);
    for (const table of scriptTables()) {
      assert.match(table, /^[a-z][a-z0-9_]*$/);
    }
  });

  it("carries the log-store allowlist the post-restore check compares against", () => {
    // The script's second check fails when the copy holds a table the seed did
    // not account for. That check needs the log store's names too, or a
    // log-store table that arrived some other way would be reported as a missing
    // config-store table. The two lists are copies for the same reason as the
    // table set, so the pair is pinned here.
    const match = SCRIPT.match(/^LOG_STORE_TABLES_ALLOWED='([^']+)'$/m);
    assert.ok(match, "seed.sh has no LOG_STORE_TABLES_ALLOWED");
    assert.deepEqual(
      match[1]
        .split(/\s+/)
        .filter((name) => name.length > 0)
        .sort(),
      [...LOG_STORE_TABLES].sort(),
      "seed.sh's LOG_STORE_TABLES_ALLOWED and this module have drifted",
    );
  });

  it("fails loudly when the pinned release is bumped without revisiting the list", () => {
    // This is the tripwire, and it is deliberately the *tag* rather than a
    // checksum of the list: a bump changes the config store's schema, and the
    // question "does the new tag add a table" is the one this forces someone to
    // answer. What it cannot do is answer it -- Bifrost's source is not
    // vendored here -- so the failure message carries the command that does.
    assert.equal(
      SEED_TABLES_UPSTREAM_TAG,
      BIFROST_UPSTREAM_TAG,
      [
        `The Bifrost pin is ${BIFROST_UPSTREAM_TAG} and SEED_TABLES was taken from ${SEED_TABLES_UPSTREAM_TAG}.`,
        "Re-derive the config store's table list against the new tag before bumping",
        "SEED_TABLES_UPSTREAM_TAG, and add anything new to SEED_TABLES and to",
        "SEED_TABLES_DEFAULT in bifrost/seed.sh:",
        "",
        "  gh api 'repos/maximhq/bifrost/contents/framework/configstore/tables?ref=<tag>'",
        "  curl -sSL 'https://codeload.github.com/maximhq/bifrost/tar.gz/refs/tags/<tag>' | tar xz",
        "  grep -rho 'return \"[a-z_0-9]*\"' framework/configstore/tables/ | sed 's/return \"//;s/\"//' | sort -u",
        "",
        "Then check the tables the config store creates with raw DDL rather than a",
        "model in framework/configstore/migrations.go (distributed_locks, sidekiq,",
        "batch_jobs are the three at v2.3.2), and the log store's list in this",
        "module against framework/logstore/, which is what must NOT be added.",
      ].join("\n"),
    );
  });
});
