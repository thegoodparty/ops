// Against real SQLite and real FTS5. A fake would prove neither the MATCH
// grammar nor the ranking, which are the two things that can be wrong here.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { S3Client } from "@aws-sdk/client-s3";

import { Db } from ".";
import { searchTool } from "../triage/sql";
import {
  indexIncident,
  reconcileSearchIndex,
  searchIncidents,
  toMatchQuery,
  UnsearchableQuery,
} from "./search";

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

let dir: string;
let db: Db;

const seed = async (args: {
  id: string;
  status?: string;
  rootCause: string;
  postmortem: string;
  title?: string;
  index?: boolean;
}) => {
  await db.withWrite((w) => {
    const status = args.status ?? "CLOSED";
    w.prepare(
      `INSERT INTO incident
         (id, status, prUrls, firstSignalAt, resolvedAt, closedAt, postmortem,
          rootCause, resolvedEvidence, attempts, tokensIn, tokensOut, cacheRead, cacheWrite, cacheWrite1h)
       VALUES (?, ?, '[]', 1000, ?, ?, ?, ?, 'the alert went quiet for 90 minutes', 0, 0, 0, 0, 0, 0)`,
    ).run(
      args.id,
      status,
      // The CHECK constraints refuse a resolved timestamp on an open row,
      // which is the point of having them.
      status === "CLOSED" || status === "RESOLVED" ? 2000 : null,
      status === "CLOSED" ? 3000 : null,
      status === "CLOSED" ? args.postmortem : null,
      args.rootCause,
    );
    w.prepare(
      `INSERT INTO signal (id, source, sourceId, kind, title, body, labels,
         reportedBy, openedAt, closedAt, incidentId, explained)
       VALUES (?, 'grafana', ?, 'alert', ?, '', '{}', NULL, 1000, 2000, ?, 1)`,
    ).run(`sig-${args.id}`, `fp-${args.id}`, args.title ?? "[PROD] an alert", args.id);
    if (args.index !== false) indexIncident(w, args.id);
  });
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-search-"));
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  db?.close();
  db = await Db.open({
    path: join(dir, `s-${Math.random().toString(36).slice(2)}.db`),
    bucket: "bugboss-test",
    key: "state/db",
    s3: fakeS3() as unknown as S3Client,
  });
});

describe("toMatchQuery: model text in, a safe MATCH expression out", () => {
  it("quotes every term, so no FTS5 operator survives the input", () => {
    assert.equal(toMatchQuery("pool exhausted"), '"pool" OR "exhausted"');
  });

  it("neutralises the characters FTS5 reads as syntax", () => {
    const match = toMatchQuery('rootCause: pool* AND "unbalanced');
    assert.ok(match);
    assert.doesNotMatch(match!, /[:*]/);
    assert.match(match!, /"pool"/);
  });

  it("drops the words every incident contains", () => {
    assert.equal(toMatchQuery("prod error in the service"), null);
  });

  it("answers null rather than an expression that matches everything", () => {
    assert.equal(toMatchQuery("  a of "), null);
  });

  it("a query FTS5 would reject runs instead of throwing", async () => {
    await seed({ id: "1", rootCause: "the pool", postmortem: "## Summary\npool" });
    assert.doesNotThrow(() => searchIncidents(db, 'rootCause: pool" ('));
  });

  it("an identifier keeps its underscore, and still finds the prose", async () => {
    // A quoted term is an FTS5 phrase, not a literal: the query goes through
    // the same tokenizer as the corpus, so "connection_pool" becomes the
    // phrase `connection pool` and matches either spelling. Keeping the
    // underscore is what makes it a phrase rather than two OR'd words, so a
    // model pasting an identifier gets adjacency instead of every incident
    // that said "pool".
    assert.equal(toMatchQuery("connection_pool sized"), '"connection_pool" OR "sized"');
    await seed({
      id: "under-1",
      rootCause: "the connection_pool was sized for the old traffic shape",
      postmortem: "## Summary\nthe connection_pool was too small",
    });
    await seed({
      id: "under-2",
      rootCause: "the connection pool was sized for the old traffic shape",
      postmortem: "## Summary\nthe connection pool was too small",
    });

    const hits = searchIncidents(db, "connection_pool").map((h) => h.incidentId);
    assert.deepEqual(
      [...hits].sort(),
      ["under-1", "under-2"],
      "the underscore spelling and the spaced one are the same phrase to FTS5",
    );
  });
});

describe("searchIncidents: the reach a signal key does not have", () => {
  it("finds a cause that came back under a different alert", async () => {
    await seed({
      id: "10",
      title: "[PROD] gp-api route errors",
      rootCause: "the connection pool was sized for the old traffic shape",
      postmortem: "## Summary\nEvery request queued behind an exhausted pool.",
    });

    // A different alert entirely. No shared fingerprint, no shared slug.
    const hits = searchIncidents(db, "requests queueing behind an exhausted pool");

    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.incidentId, "10");
    assert.match(String(hits[0]?.excerpt), /\[/, "the excerpt brackets the hit");
  });

  it("never returns an incident that is still open", async () => {
    await seed({
      id: "10",
      status: "FIXING",
      rootCause: "the connection pool was exhausted",
      postmortem: "",
    });

    assert.deepEqual(searchIncidents(db, "connection pool exhausted"), []);
  });

  it("includes RESOLVED, which has already made the claim", async () => {
    await seed({
      id: "10",
      status: "RESOLVED",
      rootCause: "the connection pool was exhausted",
      postmortem: "",
    });

    assert.equal(searchIncidents(db, "connection pool exhausted")[0]?.incidentId, "10");
  });

  it("ranks a hit in the root cause above one buried in a timeline", async () => {
    await seed({
      id: "10",
      rootCause: "unrelated",
      postmortem: "## Timeline\n10:04 someone mentioned peerly in passing",
    });
    await seed({
      id: "20",
      rootCause: "peerly rejected every send with a 503",
      postmortem: "## Summary\nupstream",
    });

    assert.deepEqual(
      searchIncidents(db, "peerly").map((h) => h.incidentId),
      ["20", "10"],
    );
  });

  it("finds the recurrence analysis, not only the post-mortem", async () => {
    await seed({ id: "10", rootCause: "unrelated", postmortem: "## Summary\nnothing" });
    await db.withWrite((w) => {
      w.prepare("UPDATE incident SET recurrenceAnalysis = ? WHERE id = '10'").run(
        JSON.stringify({
          category: "resolution_evidence_too_weak",
          why: "the previous agent watched a five minute window for an alert that fires every ten",
          remedy: "widened the quiet window",
        }),
      );
      indexIncident(w, "10");
    });

    assert.equal(
      searchIncidents(db, "watched a five minute quiet window")[0]?.incidentId,
      "10",
      "'this came back once before, and here is why' is the corpus's best sentence",
    );
  });
});

describe("reconcileSearchIndex: a corpus older than the index", () => {
  it("backfills incidents closed before the table existed", async () => {
    await seed({
      id: "10",
      rootCause: "the nightly refresh held a lock",
      postmortem: "## Summary\nstatement timeout",
      index: false,
    });
    assert.deepEqual(searchIncidents(db, "nightly refresh lock"), []);

    assert.deepEqual(await reconcileSearchIndex(db), { indexed: 1 });
    assert.equal(searchIncidents(db, "nightly refresh lock")[0]?.incidentId, "10");
  });

  it("does not re-index what is already there", async () => {
    await seed({ id: "10", rootCause: "a lock", postmortem: "## Summary\nlock" });
    assert.deepEqual(await reconcileSearchIndex(db), { indexed: 0 });
  });

  it("leaves an open incident out, so the index only holds finished claims", async () => {
    await seed({ id: "10", status: "INVESTIGATING", rootCause: "a lock", postmortem: "" });
    assert.deepEqual(await reconcileSearchIndex(db), { indexed: 0 });
  });

  it("re-indexing an incident does not duplicate it", async () => {
    await seed({ id: "10", rootCause: "a lock on the refresh", postmortem: "## S\nlock" });
    await db.withWrite((w) => indexIncident(w, "10"));

    assert.equal(searchIncidents(db, "lock refresh").length, 1);
  });
});

describe("a query that never ran is not a query that found nothing", () => {
  // The whole point of this corpus is an agent asking "has this happened
  // before". An empty array is an answer it acts on -- it stops looking and
  // reports a recurrence as novel -- so the one input that produces no query
  // at all must not be able to produce that answer.
  const STOPWORDS_ONLY = "the error in production after the alert failed";

  it("throws rather than answering empty when no term survives", async () => {
    await seed({
      id: "1",
      rootCause: "the connection pool was exhausted",
      postmortem: "## Summary\nthe pool ran out",
    });

    assert.equal(toMatchQuery(STOPWORDS_ONLY), null);
    assert.throws(
      () => searchIncidents(db, STOPWORDS_ONLY),
      (err: unknown) =>
        err instanceof UnsearchableQuery && /did not run/.test(String(err)),
    );
  });

  it("still answers empty when the query ran and matched nothing", async () => {
    await seed({
      id: "1",
      rootCause: "the connection pool was exhausted",
      postmortem: "## Summary\nthe pool ran out",
    });

    assert.deepEqual(searchIncidents(db, "certificate rotation expiry"), []);
  });

  it("triage's tool tells the agent the search did not happen", async () => {
    await seed({
      id: "1",
      rootCause: "the connection pool was exhausted",
      postmortem: "## Summary\nthe pool ran out",
    });
    const tool = searchTool(db);

    const unsearchable = String(await tool.run({ text: STOPWORDS_ONLY }));
    const empty = String(await tool.run({ text: "certificate rotation expiry" }));

    assert.match(unsearchable, /^error:/);
    assert.match(unsearchable, /did not run/);
    assert.match(empty, /^0 matches/);
    assert.notEqual(
      unsearchable,
      empty,
      "the same answer for both is the bug: the agent cannot tell it failed to search",
    );
  });
});
