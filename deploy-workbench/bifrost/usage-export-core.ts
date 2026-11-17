import { EXPORTED_COLUMNS, type ExportColumn } from "./usage-export-contract";

/**
 * The pure half of the export: the Parquet schema, the value conversions, the
 * object key and the window arithmetic.
 *
 * Everything here is wrong-able in a way a unit test catches and nothing here
 * touches a database or a bucket, which is the split `bifrost/vk-janitor-core.ts`
 * / `vk-janitor-handler.ts` already uses in this repo. The reason it matters
 * more here than usual: the schema and the conversions are where a silent data
 * error would live — a column-offset, a currency rounded through a float, a
 * timestamp truncated to the millisecond — and none of those raise anything. They
 * produce a file that loads and is wrong.
 *
 * ## The two conversions that are not obvious
 *
 * **Money.** Postgres returns `numeric` to node-postgres as a **string**, not a
 * number (OID 1700 has no default parser). `decimalStringToUnscaledBigInt` turns
 * that string into the unscaled integer the `DECIMAL(20,6)` writer wants, by
 * string manipulation only, so no value ever passes through a JS `number` and
 * back. Passing the float would reintroduce exactly the error the column type is
 * there to avoid.
 *
 * **Timestamps.** node-postgres parses `timestamptz` with `Date`, which keeps
 * milliseconds and discards microseconds. Bifrost writes `time.Time` at
 * microsecond precision, so the default would truncate every timestamp in the
 * export and make `exported_at` differ from the object key by up to 999µs. The
 * handler registers a parser that returns the raw string and this module converts
 * it; see `usage-export-handler.ts`.
 */

/** The scale every money column uses. Declared once so the writer and the tests agree. */
export const MONEY_SCALE = 6;

/**
 * The Parquet `SchemaElement[]` the writer takes, in `EXPORTED_COLUMNS` order.
 *
 * Built rather than written out, so the column list has one source. Every element
 * is `OPTIONAL`: the source columns are nullable and a `REQUIRED` column carrying
 * a null is a writer error or a silent zero.
 *
 * The `root` element's `num_children` is derived, because a hand-counted 30 that
 * disagreed with the list would be a corrupt file rather than an error.
 */
export const parquetSchema = (): Record<string, unknown>[] => [
  { name: "root", num_children: EXPORTED_COLUMNS.length },
  ...EXPORTED_COLUMNS.map((column) => {
    const element: Record<string, unknown> = {
      name: column.name,
      type: column.type,
      repetition_type: "OPTIONAL",
    };
    if (column.convertedType) element.converted_type = column.convertedType;
    if (column.precision !== undefined) element.precision = column.precision;
    if (column.scale !== undefined) element.scale = column.scale;
    if (column.typeLength !== undefined) element.type_length = column.typeLength;
    return element;
  }),
];

/**
 * One page of rows, as the writer's `columnData`.
 *
 * The handler pages the cursor and calls this per page, so the whole window is
 * never materialised twice. A page with no rows is legal and produces empty
 * columns, which the writer turns into a valid empty file: "no traffic that day"
 * must not look like "the job failed".
 */
export const toColumnData = (
  rows: readonly Record<string, unknown>[],
): { name: string; data: unknown[] }[] =>
  EXPORTED_COLUMNS.map((column) => ({
    name: column.name,
    data: rows.map((row) => convertValue(column, row[column.name])),
  }));

/** Dispatch on the column's declared kind, never on the value's runtime type. */
const convertValue = (column: ExportColumn, value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  switch (column.kind) {
    case "string":
      return String(value);
    case "timestamp":
      return timestamptzToMicros(String(value));
    case "micros":
      // Already epoch microseconds, stamped by the handler. Not parsed, not a
      // Date: the whole point is that no conversion can lose them.
      return BigInt(value as bigint | number | string);
    case "decimal":
      return decimalStringToUnscaledBigInt(String(value), column.scale ?? MONEY_SCALE);
    case "int":
      return BigInt(value as bigint | number | string);
    case "int32":
      return Number(value);
    case "bool":
      return Boolean(value);
    case "double":
      return Number(value);
  }
};

/**
 * A decimal string to its unscaled `bigint`, with no float in the path.
 *
 * `"1.234567"` at scale 6 is `1234567n`. A value with more precision than the
 * column holds is **rounded half to even** at the scale, not truncated.
 *
 * Truncation was the first version and it was wrong: it drops every digit past
 * the sixth, which biases every cost downward, and a finance number that is
 * systematically low in one direction is worse than one that is occasionally off
 * by a unit in the last place. Half-to-even is also what the warehouse does when
 * it casts a wider decimal down to `DECIMAL(20,6)` — a `cast` in Databricks
 * rounds half away from zero, but the loader's own cast is applied to a value
 * this function has already rounded, so the two cannot disagree — and being the
 * same rule in both places is the point. It also cannot drift the way
 * accumulate-and-round-at-the-end does, because each value is rounded once, from
 * the exact decimal string, with no float involved.
 *
 * Banker's rounding rather than half-up because half-up is biased upward on
 * every exact tie, which is the same class of error as truncating downward,
 * just smaller. Ties are exact and rare: a tie needs the source to have written
 * a digit exactly 5 at the seventh place and nothing after it.
 *
 * An empty string becomes `null` rather than `0n`, because a null cost and a zero
 * cost are different facts and the mart counts requests that had no cost yet.
 */
export const decimalStringToUnscaledBigInt = (
  value: string,
  scale: number = MONEY_SCALE,
): bigint | null => {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) throw new Error(`not a decimal: ${JSON.stringify(value)}`);
  const [, sign, whole, fraction = ""] = match;
  if (whole === "" && fraction === "") throw new Error(`not a decimal: ${JSON.stringify(value)}`);

  const kept = fraction.slice(0, scale).padEnd(scale, "0");
  const digits = BigInt(`${whole || "0"}${kept}`);
  // Everything past the scale, as a digit string. Any non-zero digit beyond the
  // first does not change the decision — once the remainder is greater than half,
  // it stays greater — so only the first kept-or-dropped digit and whether
  // anything nonzero follows it matter.
  const dropped = fraction.slice(scale);
  const roundsUp = decideRoundUp(dropped, digits);
  const magnitude = roundsUp ? digits + 1n : digits;
  // `DECIMAL(20,6)` holds 20 digits in total, so the unscaled value must be below
  // 10^20. The writer takes a 9-byte FIXED_LEN_BYTE_ARRAY, and a wider value
  // would either fail there with an opaque message or wrap. A per-request cost
  // cannot reach this, which is exactly why it should be a named error rather
  // than a corrupt number if it ever does.
  if (magnitude >= 10n ** 20n) {
    throw new Error(`value exceeds DECIMAL(20,${scale}): ${JSON.stringify(value)}`);
  }
  // The sign applies to the magnitude, and half-to-even is symmetric about zero,
  // so a negative value rounds by the same rule rather than away from zero.
  return sign === "-" ? -magnitude : magnitude;
};

/**
 * Whether the dropped digits round the magnitude up, half to even.
 *
 * Three cases, and each one is a distinct tie rule:
 * - the first dropped digit is below 5: never up;
 * - above 5, or exactly 5 with anything non-zero after it: always up (the
 *   remainder is strictly greater than half);
 * - exactly 5 with nothing after it: an exact tie, so round to the even
 *   magnitude — which is `digits % 2n === 1n`, because adding one makes an odd
 *   magnitude even.
 */
const decideRoundUp = (dropped: string, digits: bigint): boolean => {
  if (dropped === "") return false;
  const first = dropped.charCodeAt(0) - 48;
  if (first > 5) return true;
  if (first < 5) return false;
  const restHasNonZero = /[1-9]/.test(dropped.slice(1));
  if (restHasNonZero) return true;
  return digits % 2n === 1n;
};

/**
 * A `timestamptz` string to epoch microseconds, without going through `Date`.
 *
 * Postgres renders it as `2026-11-13 09:00:00.123456+00`, and the offset is
 * applied arithmetically rather than by handing the string to `Date.parse`,
 * which would accept a different set of forms and silently read an unparseable
 * one as `NaN`. `Date.UTC` is used only for the whole-second part, where
 * milliseconds are exact.
 *
 * A null (a `processing` row has no `created_at` in some paths) returns null.
 */
export const timestamptzToMicros = (value: string): bigint | null => {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      trimmed,
    );
  if (!match) throw new Error(`not a timestamptz: ${JSON.stringify(value)}`);
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  const wholeMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const micros = BigInt(wholeMs) * 1000n + BigInt((fraction ?? "").padEnd(6, "0") || "0");
  return micros - offsetMicros(offset);
};

/**
 * The offset part of a `timestamptz`, in microseconds to subtract.
 *
 * Postgres normally renders in UTC (`+00`) for a server configured that way, but
 * an explicit offset is legal and reading it as UTC would be hours wrong, so it
 * is parsed rather than assumed away. `Z` and no offset are both UTC.
 */
const offsetMicros = (offset: string | undefined): bigint => {
  if (!offset || offset === "Z") return 0n;
  const sign = offset.startsWith("-") ? -1n : 1n;
  const digits = offset.slice(1).replace(":", "");
  const hours = BigInt(digits.slice(0, 2) || "0");
  const minutes = BigInt(digits.slice(2, 4) || "0");
  return sign * (hours * 3600n + minutes * 60n) * 1_000_000n;
};

/**
 * The object key for one run: `bifrost/logs/bifrost-requests-<YYYYMMDD>T<HHMMSS>Z.parquet`.
 *
 * **No colons, and this is the whole reason the format is pinned here.** The
 * loader validates the entire path against `_EXPORT_PATH_RE` before it
 * interpolates it into `COPY INTO`, and that character class excludes `:`. A key
 * with a colon in the time fails at the loader, a day later, as a failed
 * Databricks task. `usage-export-core.test.ts` asserts the produced key against a
 * copy of that regex, so a future edit that reintroduces one fails in `npm test`
 * rather than in the warehouse.
 *
 * One place produces this string; the handler does not format a date.
 */
export const usageExportObjectKey = (runStartedAt: Date, prefix = "bifrost/logs"): string => {
  const iso = runStartedAt.toISOString();
  const date = iso.slice(0, 10).replace(/-/g, "");
  const time = iso.slice(11, 19).replace(/:/g, "");
  return `${prefix.replace(/\/+$/, "")}/bifrost-requests-${date}T${time}Z.parquet`;
};

/**
 * The window a run reads: `[start, end)` in UTC, `end` being when the run began.
 *
 * `exported_at` and the object key both use `end`, so a row's stamp and its file
 * name agree. The start is `end` minus the window, which is a whole number of
 * days: the loader's staging model orders observations by `exported_at`, and a
 * fixed window keeps two consecutive runs' overlap predictable.
 */
export const exportWindow = (
  runStartedAt: Date,
  windowDays: number,
): { start: Date; end: Date } => {
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new Error(`window must be a positive number of days, got ${windowDays}`);
  }
  const end = new Date(runStartedAt.getTime());
  const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return { start, end };
};
