import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { types as pgTypes } from "pg";

import { USAGE_EXPORT_STATEMENT_TIMEOUT_MS } from "./usage-export-contract";
// Imported for its side effect as well as its exports: importing the handler is
// what registers the raw timestamptz parsers the test below inspects.
import { connectionConfig, summarise, type ExportResult } from "./usage-export-handler";

/**
 * The handler's two properties that a full integration run is not needed for and
 * that a reviewer would otherwise have to take on trust.
 *
 * There is no database and no bucket here, so this does not exercise the query or
 * the PUT. What it does exercise is (a) the connection config, where the TLS CA
 * and `statement_timeout` are the two things whose absence fails silently at
 * deploy time and cannot be seen in a unit test of anything else, and (b) the log
 * whitelist, because the rows carry personal identifiers and a log line is public
 * within the account for thirty days.
 */

const SOURCE = fs.readFileSync(path.resolve(__dirname, "usage-export-handler.ts"), "utf8");

describe("usage export handler", () => {
  it("configures verified TLS and a statement timeout", () => {
    const config = connectionConfig({
      environment: {
        bucket: "b",
        prefix: "p",
        secretName: "s",
        pgHost: "db.example",
        pgPort: 5432,
        pgDatabase: "bifrost",
        pgUser: "bifrost_usage_export",
      },
      password: "not-a-real-password",
      ca: "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
    });

    // RDS for PostgreSQL 15+ defaults rds.force_ssl to 1 and node-postgres
    // defaults `ssl` to false, so a connection without this is refused outright.
    assert.equal(typeof config.ssl, "object");
    assert.equal(config.ssl.rejectUnauthorized, true, "TLS must verify, not just encrypt");
    assert.ok(config.ssl.ca.includes("BEGIN CERTIFICATE"), "the RDS CA must be passed explicitly");

    // The bad-plan guard: bounds the damage to an instance shared with the
    // gateway, well inside the function's 900s ceiling.
    assert.equal(config.statement_timeout, USAGE_EXPORT_STATEMENT_TIMEOUT_MS);
    assert.ok(USAGE_EXPORT_STATEMENT_TIMEOUT_MS < 900_000);
  });

  it("reads the RDS CA from the runtime's bundle rather than disabling verification", () => {
    assert.ok(sourceIncludes("RDS_CA_PATH = \"/var/runtime/ca-cert.pem\""));
    // The two ways this gets "fixed" badly, both of which must not appear.
    assert.ok(
      !/rejectUnauthorized:\s*false/.test(SOURCE),
      "TLS verification must never be disabled",
    );
    assert.ok(!/ssl:\s*true\b/.test(SOURCE), "ssl: true does not load the RDS CA");
  });

  it("registers its own timestamptz parser, which importing the module does", () => {
    // Importing the handler is what runs `setTypeParser`, so this asserts the
    // effect rather than the source text, which a grep would satisfy from a
    // comment. The driver's default parser for OID 1184 returns a `Date`, which
    // keeps milliseconds only.
    const raw = pgTypes.getTypeParser(1184)("2026-11-13 09:00:00.123456+00") as unknown;
    assert.equal(typeof raw, "string", "the raw string must reach the core, microseconds intact");
    assert.equal(raw, "2026-11-13 09:00:00.123456+00");
    // And the same for 1114, which GORM does not create today but which would
    // otherwise run through `Date`.
    assert.equal(typeof pgTypes.getTypeParser(1114)("2026-11-13 09:00:00.123456"), "string");
  });

  it("writes the file with a conditional PUT so a key is never overwritten", () => {
    // The command is built where it can be read, and the property asserted is
    // that the only PutObject in the handler carries the condition. A bare
    // "does this string appear" check would pass on a comment, which is exactly
    // what this file's earlier version did.
    // The capture stops at the command's own closing `})`, not at the first `))`
    // in the file: an unanchored lazy match runs on into the `console.log` below
    // and would make "exactly one PUT" and "the condition is in *that* PUT" pass
    // for the wrong reason. Anchored on the closing brace of the input object.
    const puts = [
      ...SOURCE.matchAll(/new PutObjectCommand\(\{([\s\S]*?)\n\s*\}\)/g),
    ];
    assert.equal(puts.length, 1, "the handler must make exactly one PUT per run");
    assert.ok(
      /IfNoneMatch:\s*"\*"/.test(puts[0][1]),
      "that PUT must refuse to overwrite an existing object",
    );
    assert.ok(/Body:\s*Buffer\.from\(/.test(puts[0][1]), "and carry the whole file in one body");
    assert.ok(
      !/console\.log/.test(puts[0][1]),
      "the capture must not run past the command into the code after it",
    );
  });

  it("logs a whitelisted summary and no row", () => {
    const result: ExportResult = {
      rows: 1234,
      bytes: 5678,
      key: "bifrost/logs/bifrost-requests-20261113T090000Z.parquet",
      windowStart: "2026-11-06T09:00:00.000Z",
      windowEnd: "2026-11-13T09:00:00.000Z",
    };
    assert.deepEqual(Object.keys(summarise(result)).sort(), [
      "bytes",
      "key",
      "rows",
      "windowEnd",
      "windowStart",
    ]);
    // The point: no field in the log summary can carry a person, a virtual key,
    // a model or a cost. Those live in the file, which the warehouse gates.
    for (const forbidden of ["user", "virtual", "email", "cost", "model", "provider"]) {
      assert.ok(
        !Object.keys(summarise(result)).some((field) =>
          field.toLowerCase().includes(forbidden),
        ),
        `the log summary must not carry a ${forbidden} field`,
      );
    }
    // And the handler logs that summary rather than the result object.
    assert.ok(
      /console\.log\("bifrost usage export", summarise\(result\)\)/.test(SOURCE),
      "the handler must log the whitelisted summary",
    );
  });

  const sourceIncludes = (needle: string): boolean => SOURCE.includes(needle);
});
