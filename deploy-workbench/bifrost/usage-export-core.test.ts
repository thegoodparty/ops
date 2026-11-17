import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parquetReadObjects, parquetMetadata } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";

import {
  EXPORTED_COLUMNS,
  GRANTED_COLUMNS,
  EXPORT_QUERY,
} from "./usage-export-contract";
import {
  decimalStringToUnscaledBigInt,
  exportWindow,
  parquetSchema,
  timestamptzToMicros,
  toColumnData,
  usageExportObjectKey,
} from "./usage-export-core";

/**
 * The pure half of the export, with no database and no bucket.
 *
 * These are the assertions a silent data error would otherwise get past: a column
 * offset, a currency rounded through a float, a timestamp truncated to the
 * millisecond, an object key the loader rejects. None of those raise anything —
 * they produce a file that lands and is wrong — so each one is pinned here.
 */

/**
 * The loader's `_EXPORT_PATH_RE`, copied from
 * `airflow/astro/include/custom_functions/bifrost_export.py` in
 * `thegoodparty/gp-data-platform`.
 *
 * A copy, not a read of that file: this repo's CI does not check out the other
 * one, so a test that read it by path would skip every run and read as passing.
 * The copy is the guard against a local edit; the cross-repo drift is a stated
 * gap, and §10 of the plan says so.
 */
const EXPORT_PATH_RE = /^s3:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+(?<![/])$/;

/** The loader's `LANDING_COLUMNS` order, minus `loaded_at`, as a literal. */
const LOADER_COLUMN_ORDER = [
  "id",
  "timestamp",
  "created_at",
  "exported_at",
  "provider",
  "model",
  "canonical_model_name",
  "alias",
  "object_type",
  "status",
  "is_passthrough",
  "fallback_index",
  "parent_request_id",
  "app",
  "user_agent",
  "virtual_key_id",
  "virtual_key_name",
  "team_id",
  "team_name",
  "user_id",
  "user_name",
  "cost",
  "input_cost",
  "output_cost",
  "additional_cost",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "cached_read_tokens",
  "latency",
];

/** One row shaped like the handler's output, with the awkward values included. */
const sampleRows = () => [
  {
    id: "req-1",
    timestamp: "2026-11-13 09:00:00.123456+00",
    created_at: "2026-11-13 09:00:00.223456+00",
    exported_at: 1794560400123456n,
    provider: "bedrock",
    model: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    canonical_model_name: "claude-sonnet-4.5",
    alias: null,
    object_type: "chat.completion",
    status: "success",
    is_passthrough: false,
    fallback_index: 0,
    parent_request_id: null,
    app: "gp-pi",
    user_agent: "pi/1.2.3",
    virtual_key_id: "vk-1",
    virtual_key_name: "someone@example.org",
    team_id: null,
    team_name: null,
    user_id: "u-1",
    user_name: "someone@example.org",
    cost: "1.234567",
    input_cost: "0.004567",
    output_cost: "1.230000",
    additional_cost: "0.000000",
    prompt_tokens: 1000n,
    completion_tokens: 500n,
    total_tokens: 1500n,
    cached_read_tokens: 0n,
    latency: 1234.5,
  },
  {
    id: "req-2",
    timestamp: "2026-11-13 09:05:00+00",
    created_at: "2026-11-13 09:05:00+00",
    exported_at: 1794560400123456n,
    provider: "bedrock",
    model: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    canonical_model_name: null,
    alias: "sonnet",
    object_type: "chat.completion",
    status: "error",
    is_passthrough: true,
    fallback_index: 2,
    parent_request_id: "req-1",
    app: "gp-pi",
    user_agent: "pi/1.2.3",
    virtual_key_id: "vk-1",
    virtual_key_name: "someone@example.org",
    team_id: null,
    team_name: null,
    user_id: "u-1",
    user_name: "someone@example.org",
    // A negative cost: Bifrost can carry one on an adjustment row, and a float
    // round trip would lose the sign's exactness.
    cost: "-0.002500",
    input_cost: "0.000000",
    output_cost: "0.000000",
    additional_cost: "-0.002500",
    prompt_tokens: 3000n,
    completion_tokens: 0n,
    total_tokens: 3000n,
    cached_read_tokens: 0n,
    latency: null,
  },
];

describe("usage export core", () => {
  it("writes the loader's 30 columns, in the loader's order", () => {
    assert.deepEqual(
      EXPORTED_COLUMNS.map((column) => column.name),
      LOADER_COLUMN_ORDER,
      "the exported columns must match the loader's LANDING_COLUMNS minus loaded_at, in order",
    );
  });

  it("grants SELECT on the 29 columns that exist, never exported_at", () => {
    assert.equal(GRANTED_COLUMNS.length, 29);
    assert.ok(
      !GRANTED_COLUMNS.includes("exported_at"),
      "exported_at is not a column of the gateway's logs table, so a GRANT naming it is rejected",
    );
    assert.ok(
      !GRANTED_COLUMNS.includes("loaded_at"),
      "loaded_at is stamped by the loader and does not exist at the source either",
    );
  });

  it("selects the 29 columns and never a star", () => {
    assert.ok(!/\*/.test(EXPORT_QUERY), "the export must never select *");
    assert.ok(
      EXPORT_QUERY.includes('"timestamp" >= $1') && EXPORT_QUERY.includes('"timestamp" < $2'),
      "the predicate must be on timestamp so the planner can use idx_logs_timestamp",
    );
    // The two reserved words are quoted, and both appear quoted rather than bare.
    assert.ok(EXPORT_QUERY.includes('"timestamp"') && EXPORT_QUERY.includes('"alias"'));
    for (const name of GRANTED_COLUMNS) {
      assert.ok(EXPORT_QUERY.includes(name), `the query must select ${name}`);
    }
  });

  it("produces an object key the loader's path check accepts", () => {
    const key = usageExportObjectKey(new Date("2026-11-13T09:00:00.000Z"));
    assert.equal(key, "bifrost/logs/bifrost-requests-20261113T090000Z.parquet");
    assert.ok(
      EXPORT_PATH_RE.test(`s3://some-bucket/${key}`),
      "the produced key must satisfy the loader's export path pattern",
    );
    // The specific thing that would break it, and it would break a day later.
    assert.ok(!key.includes(":"), "the key must contain no colon");
    assert.ok(
      !EXPORT_PATH_RE.test("s3://some-bucket/bifrost/logs/bifrost-requests-2026-11-13T09:00:00Z.parquet"),
      "a colon-bearing key is rejected by the loader, which is why the format is compact",
    );
  });

  it("writes a file whose types and values read back exactly", async () => {
    const rows = sampleRows();
    const file = parquetWriteBuffer({
      schema: parquetSchema() as never,
      columnData: toColumnData(rows) as never,
    });
    assert.ok(file.byteLength > 0);

    const schema = parquetMetadata(file).schema.filter((element) => element.name !== "root");
    assert.deepEqual(
      schema.map((element) => element.name),
      LOADER_COLUMN_ORDER,
      "the file's own schema must carry the columns in order",
    );
    for (const element of schema) {
      assert.equal(
        element.repetition_type,
        "OPTIONAL",
        `${element.name} must be optional: every source column is nullable`,
      );
    }
    const cost = schema.find((element) => element.name === "cost");
    assert.equal(cost?.type, "FIXED_LEN_BYTE_ARRAY");
    assert.equal(cost?.converted_type, "DECIMAL");
    assert.equal(cost?.scale, 6);
    assert.equal(cost?.precision, 20);
    const timestamp = schema.find((element) => element.name === "timestamp");
    assert.equal(timestamp?.converted_type, "TIMESTAMP_MICROS");

    const back = await parquetReadObjects({ file });
    assert.equal(back.length, 2);
    // The writer converts DECIMAL back to a number for a reader; the exactness
    // that matters is that 1.234567 and -0.0025 survive, which a float path
    // would not round-trip through the scaled bigint reliably.
    assert.equal(Number(back[0].cost), 1.234567);
    assert.equal(Number(back[1].cost), -0.0025);
    assert.equal(back[0].id, "req-1");
    assert.equal(back[0].alias, null);
    assert.equal(back[0].is_passthrough, false);
    assert.equal(back[1].is_passthrough, true);
    assert.equal(Number(back[0].prompt_tokens), 1000);
    assert.equal(back[1].latency, null);
    // Microseconds, not milliseconds: the whole point of the raw-string parser.
    assert.equal(new Date(Number(back[0].timestamp)).toISOString(), "2026-11-13T09:00:00.123Z");
  });

  it("writes a valid empty file for a window with no rows", async () => {
    // "No traffic that day" must not look like "the job failed", and the loader
    // has to be able to read the file either way.
    const file = parquetWriteBuffer({
      schema: parquetSchema() as never,
      columnData: toColumnData([]) as never,
    });
    const back = await parquetReadObjects({ file });
    assert.equal(back.length, 0);
    assert.deepEqual(
      parquetMetadata(file)
        .schema.filter((element) => element.name !== "root")
        .map((element) => element.name),
      LOADER_COLUMN_ORDER,
    );
  });

  it("converts a decimal string to its unscaled bigint with no float in the path", () => {
    assert.equal(decimalStringToUnscaledBigInt("1.234567"), 1234567n);
    assert.equal(decimalStringToUnscaledBigInt("0"), 0n);
    assert.equal(decimalStringToUnscaledBigInt("0.000000"), 0n);
    assert.equal(decimalStringToUnscaledBigInt("-0.0025"), -2500n);
    assert.equal(decimalStringToUnscaledBigInt("99.000000"), 99000000n);
    // A null and an empty string are different facts from zero.
    assert.equal(decimalStringToUnscaledBigInt(""), null);
    assert.equal(decimalStringToUnscaledBigInt("   "), null);
    assert.throws(() => decimalStringToUnscaledBigInt("not-a-number"), /not a decimal/);
  });

  it("rounds past the sixth decimal half to even, in both directions", () => {
    // The half cases. Half-to-even needs the *magnitude's* last kept digit to
    // decide, so a half on an even magnitude stays and a half on an odd one goes
    // up. Truncation — the first version — would have pushed both of these down.
    assert.equal(decimalStringToUnscaledBigInt("1.2345685"), 1234568n, "even magnitude, tie: stays");
    assert.equal(decimalStringToUnscaledBigInt("1.2345675"), 1234568n, "odd magnitude, tie: rounds up");
    // Not a tie: strictly above or below half rounds the obvious way.
    assert.equal(decimalStringToUnscaledBigInt("1.2345676"), 1234568n);
    assert.equal(decimalStringToUnscaledBigInt("1.2345674"), 1234567n);
    // A tie followed by anything non-zero is no longer a tie.
    assert.equal(decimalStringToUnscaledBigInt("1.2345685000001"), 1234569n);
    assert.equal(decimalStringToUnscaledBigInt("1.2345685000000"), 1234568n, "trailing zeros are still a tie");
  });

  it("rounds a negative half by the same rule, not away from zero", () => {
    // Half-to-even is symmetric about zero, so the same magnitudes decide it.
    assert.equal(decimalStringToUnscaledBigInt("-1.2345685"), -1234568n, "even: stays");
    assert.equal(decimalStringToUnscaledBigInt("-1.2345675"), -1234568n, "odd: rounds up in magnitude");
    assert.equal(decimalStringToUnscaledBigInt("-1.2345674"), -1234567n);
    assert.equal(decimalStringToUnscaledBigInt("-1.2345676"), -1234568n);
  });

  it("refuses a value wider than the column can hold", () => {
    // DECIMAL(20,6) holds 20 digits, so the unscaled magnitude must be under
    // 10^20. A wider value would fail inside the 9-byte writer field with an
    // opaque message; this names it.
    assert.equal(decimalStringToUnscaledBigInt("99999999999999.999999"), 99999999999999999999n);
    assert.throws(
      () => decimalStringToUnscaledBigInt("100000000000000"),
      /exceeds DECIMAL\(20,6\)/,
      "a 15-digit whole part overflows the column and must be reported, not written",
    );
    assert.throws(() => decimalStringToUnscaledBigInt("-100000000000000"), /exceeds DECIMAL\(20,6\)/);
  });

  it("rounds a value with many decimals correctly", () => {
    // Nothing past the seventh digit can change the decision, but it must not
    // confuse it either.
    assert.equal(decimalStringToUnscaledBigInt("0.1234564999999999999"), 123456n);
    assert.equal(decimalStringToUnscaledBigInt("0.1234565000000000001"), 123457n);
    assert.equal(decimalStringToUnscaledBigInt("1.9999999"), 2000000n, "carries into the whole part");
    assert.equal(decimalStringToUnscaledBigInt("-1.9999999"), -2000000n);
    assert.equal(decimalStringToUnscaledBigInt("99999999.9999995"), 100000000000000n);
  });

  it("converts timestamptz to microseconds without losing them", () => {
    assert.equal(timestamptzToMicros("2026-11-13 09:00:00.123456+00"), 1794560400123456n);
    assert.equal(timestamptzToMicros("2026-11-13 09:00:00+00"), 1794560400000000n);
    assert.equal(timestamptzToMicros("2026-11-13 09:00:00.5+00"), 1794560400500000n);
    // An explicit offset is honoured rather than read as UTC.
    assert.equal(
      timestamptzToMicros("2026-11-13 10:00:00+01"),
      timestamptzToMicros("2026-11-13 09:00:00+00"),
    );
    assert.equal(timestamptzToMicros("2026-11-13T09:00:00.123456Z"), 1794560400123456n);
    assert.equal(timestamptzToMicros(""), null);
    assert.throws(() => timestamptzToMicros("yesterday"), /not a timestamptz/);
    // The trap this exists for: the default driver parser is millisecond-only.
    assert.notEqual(
      timestamptzToMicros("2026-11-13 09:00:00.123456+00"),
      BigInt(Date.parse("2026-11-13T09:00:00.123Z")) * 1000n,
    );
  });

  it("computes the window as a whole number of days ending at the run instant", () => {
    const runAt = new Date("2026-11-13T09:00:00.000Z");
    const weekly = exportWindow(runAt, 7);
    assert.equal(weekly.end.toISOString(), "2026-11-13T09:00:00.000Z");
    assert.equal(weekly.start.toISOString(), "2026-11-06T09:00:00.000Z");
    const monthly = exportWindow(runAt, 90);
    assert.equal(monthly.start.toISOString(), "2026-08-15T09:00:00.000Z");
    assert.throws(() => exportWindow(runAt, 0), /positive number of days/);
    assert.throws(() => exportWindow(runAt, -1), /positive number of days/);
  });
});
