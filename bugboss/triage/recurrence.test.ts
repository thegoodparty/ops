// Against real SQLite, because the whole point of this module is two queries
// and the indexes that keep them cheap. A fake would prove neither.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import type { RawSignal } from "../types";
import {
  CANDIDATE_LOOKBACK_MS,
  RECURRENCE_WINDOW_MS,
  conclusiveRecurrence,
  findRecurrenceCandidates,
  renderRecurrence,
} from "./recurrence";

const fakeS3 = () => {
  const objects = new Map<string, Buffer>();
  return {
    send: async (cmd: {
      constructor: { name: string };
      input: { Key: string; Body?: Buffer };
    }) => {
      if (cmd.constructor.name === "GetObjectCommand") {
        const body = objects.get(cmd.input.Key);
        if (!body) {
          const err = new Error("NoSuchKey");
          err.name = "NoSuchKey";
          throw err;
        }
        return { Body: { transformToByteArray: async () => body } };
      }
      objects.set(cmd.input.Key, Buffer.from(cmd.input.Body!));
      return {};
    },
  };
};

const NOW = 1_758_700_000_000;
const DAY = 86_400_000;

let dir: string;
let db: Db;
let seq = 0;

const signal = (over: Partial<RawSignal> = {}): RawSignal => ({
  source: "grafana",
  sourceId: "fp-1",
  kind: "alert",
  title: "[PROD] Route errors detected",
  body: "500s on POST /campaigns",
  labels: { alert_slug: "campaigns-route-errors" },
  reportedBy: null,
  openedAt: NOW,
  ...over,
});

/** A resolved-and-closed incident carrying one signal, as an agent leaves it. */
const seedClosed = async (args: {
  id: string;
  sourceId: string;
  slug?: string;
  resolvedAt: number;
  status?: string;
  rootCause?: string;
}) => {
  await db.withWrite((w) => {
    w.prepare(
      `INSERT INTO incident
         (id, status, prUrls, firstSignalAt, resolvedAt, closedAt, postmortem,
          rootCause, resolvedEvidence, attempts, tokensIn, tokensOut, cacheRead, cacheWrite, cacheWrite1h)
       VALUES (?, ?, '[]', ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)`,
    ).run(
      args.id,
      args.status ?? "CLOSED",
      args.resolvedAt - DAY,
      args.resolvedAt,
      args.status === "RESOLVED" ? null : args.resolvedAt,
      args.status === "RESOLVED" ? null : "## Summary\nit was the lock",
      args.rootCause ?? "the nightly refresh held a lock past its statement timeout",
      "zero matching lines for 90 minutes after the deploy",
    );
    w.prepare(
      `INSERT INTO signal
         (id, source, sourceId, kind, title, body, labels, reportedBy, openedAt, closedAt, incidentId, explained)
       VALUES (?, 'grafana', ?, 'alert', ?, '', ?, NULL, ?, ?, ?, 1)`,
    ).run(
      `sig-${seq++}`,
      args.sourceId,
      `[PROD] ${args.sourceId} firing`,
      JSON.stringify(args.slug ? { alert_slug: args.slug } : {}),
      args.resolvedAt - DAY,
      args.resolvedAt,
      args.id,
    );
  });
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-recurrence-"));
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  db?.close();
  seq = 0;
  db = await Db.open({
    path: join(dir, `rec-${Math.random().toString(36).slice(2)}.db`),
    bucket: "bugboss-test",
    key: "state/db",
    s3: fakeS3() as unknown as S3Client,
  });
});

describe("recurrence: the closed-incident analogue of the open list", () => {
  it("finds the incident that closed on this exact signal", async () => {
    await seedClosed({ id: "41", sourceId: "fp-1", resolvedAt: NOW - 6 * DAY });

    const found = findRecurrenceCandidates(db, signal());

    assert.equal(found.length, 1);
    assert.equal(found[0]?.incidentId, "41");
    assert.equal(found[0]?.conclusive, true);
    assert.equal(found[0]?.daysSince, 6);
    assert.match(String(found[0]?.rootCause), /statement timeout/);
  });

  it("keeps a RESOLVED incident, not only a CLOSED one", async () => {
    await seedClosed({
      id: "41",
      sourceId: "fp-1",
      resolvedAt: NOW - DAY,
      status: "RESOLVED",
    });

    const found = findRecurrenceCandidates(db, signal());

    assert.equal(found[0]?.status, "RESOLVED");
    assert.equal(
      found[0]?.conclusive,
      true,
      "RESOLVED already claims no further alerts should occur",
    );
  });

  it("never names an incident that is still open", async () => {
    await db.withWrite((w) => {
      w.prepare(
        `INSERT INTO incident (id, status, prUrls, firstSignalAt, attempts,
           tokensIn, tokensOut, cacheRead, cacheWrite, cacheWrite1h)
         VALUES ('9', 'FIXING', '[]', ?, 0, 0, 0, 0, 0, 0)`,
      ).run(NOW - DAY);
      w.prepare(
        `INSERT INTO signal (id, source, sourceId, kind, title, body, labels,
           reportedBy, openedAt, closedAt, incidentId, explained)
         VALUES ('sig-open', 'grafana', 'fp-1', 'alert', 't', '', '{}', NULL, ?, NULL, '9', 0)`,
      ).run(NOW - DAY);
    });

    assert.deepEqual(findRecurrenceCandidates(db, signal()), []);
  });

  it("stops being conclusive once the window has passed", async () => {
    await seedClosed({
      id: "41",
      sourceId: "fp-1",
      resolvedAt: NOW - RECURRENCE_WINDOW_MS - DAY,
    });

    const found = findRecurrenceCandidates(db, signal());

    assert.equal(found.length, 1, "still worth showing the model");
    assert.equal(found[0]?.conclusive, false);
    assert.equal(conclusiveRecurrence(found), null);
  });

  it("drops anything past the lookback entirely", async () => {
    await seedClosed({
      id: "41",
      sourceId: "fp-1",
      resolvedAt: NOW - CANDIDATE_LOOKBACK_MS - DAY,
    });

    assert.deepEqual(findRecurrenceCandidates(db, signal()), []);
  });

  it("ignores a sibling alert on the same slug", async () => {
    await seedClosed({
      id: "41",
      sourceId: "fp-OTHER",
      slug: "campaigns-route-errors",
      resolvedAt: NOW - DAY,
    });

    assert.deepEqual(
      findRecurrenceCandidates(db, signal()),
      [],
      "a shared rule is not a shared cause; that reach belongs to the search",
    );
  });

  it("takes the newest resolution when an alert has recurred before", async () => {
    await seedClosed({ id: "10", sourceId: "fp-1", resolvedAt: NOW - 10 * DAY });
    await seedClosed({ id: "20", sourceId: "fp-1", resolvedAt: NOW - 2 * DAY });

    const found = findRecurrenceCandidates(db, signal());

    assert.deepEqual(
      found.map((c) => c.incidentId),
      ["20", "10"],
    );
    assert.equal(
      conclusiveRecurrence(found)?.incidentId,
      "20",
      "the resolution a signal contradicts is the last one made",
    );
  });

  it("works for a signal with no slug at all", async () => {
    await seedClosed({ id: "41", sourceId: "fp-1", resolvedAt: NOW - DAY });

    const found = findRecurrenceCandidates(db, signal({ labels: {} }));

    assert.equal(found[0]?.incidentId, "41", "the exact key is always present");
  });

  it("uses an index rather than scanning every signal ever", async () => {
    const plan = db
      .query<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT i.id FROM signal s JOIN incident i ON i.id = s.incidentId
         WHERE s.source = ? AND s.sourceId = ?`,
        ["grafana", "fp-1"],
      )
      .map((row) => row.detail)
      .join(" | ");

    assert.match(plan, /signal_source_idx/);
    assert.doesNotMatch(plan, /SCAN s\b/);
  });
});

describe("recurrence: how it reaches the model", () => {
  it("says unavailable rather than showing an empty list", () => {
    const rendered = renderRecurrence(null);
    assert.match(rendered, /UNAVAILABLE/);
    assert.doesNotMatch(rendered, /no incident in the last/);
  });

  it("distinguishes 'checked and found nothing' from 'did not check'", () => {
    assert.match(renderRecurrence([]), /no incident in the last 90 days/);
  });

  it("carries the earlier cause and the evidence the resolution rested on", async () => {
    await seedClosed({ id: "41", sourceId: "fp-1", resolvedAt: NOW - 3 * DAY });

    const rendered = renderRecurrence(findRecurrenceCandidates(db, signal()));

    assert.match(rendered, /41 \| CLOSED/);
    assert.match(rendered, /statement timeout/);
    assert.match(rendered, /zero matching lines/);
    assert.match(rendered, /CONCLUSIVE/);
  });
});
