import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import {
  publishIncidentReport,
  publishPendingReports,
  readReportData,
  renderReportDocument,
  renderThreadSummary,
  reportMetrics,
  REPORT_PUBLISHED_ACTION,
  REPORT_GIVE_UP_MS,
  REPORT_SWEEP_GRACE_MS,
  type ReportDeps,
  type ReportUpload,
} from "./index";
import { duration, interval } from "./render";

const fakeS3 = () => {
  const objects = new Map<string, Buffer>();
  return {
    objects,
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

/** Two model turns and one out-of-band compaction call, as Pi writes them. */
const SESSION = [
  JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      model: "us.anthropic.claude-opus-5",
      usage: {
        input: 1_000,
        output: 500,
        cacheRead: 40_000,
        cacheWrite: 2_000,
        cost: { total: 1.5 },
      },
    },
  }),
  JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      model: "us.anthropic.claude-opus-5",
      usage: {
        input: 2_000,
        output: 700,
        cacheRead: 60_000,
        cacheWrite: 0,
        cost: { total: 2.25 },
      },
    },
  }),
  JSON.stringify({
    type: "compaction",
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
  }),
].join("\n");

const OPENED = Date.UTC(2026, 8, 27, 10, 0, 0);
const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);

let dir: string;
let db: Db;
let s3: ReturnType<typeof fakeS3>;
let posts: { threadTs: string | null; text: string }[];
let uploads: ReportUpload[];
let uploadFails: boolean;

const deps = (overrides: Partial<ReportDeps> = {}): ReportDeps => ({
  db,
  sessions: {
    get: async (key: string) => s3.objects.get(key)?.toString("utf8") ?? null,
  },
  post: async (threadTs, text) => {
    posts.push({ threadTs, text });
    return { ts: `ts-${posts.length}` };
  },
  channel: "C-INCIDENTS",
  uploader: {
    upload: async (file) => {
      if (uploadFails) throw new Error("slack: missing_scope");
      uploads.push(file);
    },
  },
  now: () => NOW,
  ...overrides,
});

interface SeedOptions {
  status?: string;
  closedAt?: number | null;
  postmortem?: string | null;
  signalTitle?: string;
  rootCause?: string;
  sessionRef?: string | null;
  /** Null for "never recorded"; later than `OPENED` for a backwards row. */
  impactStartedAt?: number | null;
  resolvedAt?: number | null;
  prUrls?: string[];
  /** The incident this one is the return of, and the answer recorded at close. */
  recurrenceOf?: string;
  recurrenceAnalysis?: string;
}

const seed = async (id: string, opts: SeedOptions = {}) => {
  const status = opts.status ?? "CLOSED";
  const closedAt = opts.closedAt === undefined ? NOW - 60_000 : opts.closedAt;
  const postmortem =
    opts.postmortem === undefined
      ? "## Timeline\n\n10:00 impact began.\n\n## Five whys\n\n1. The pool saturated."
      : opts.postmortem;
  const sessionRef = opts.sessionRef === undefined ? `sessions/incident/${id}/session.jsonl` : opts.sessionRef;
  const impactStartedAt =
    opts.impactStartedAt === undefined ? OPENED - 600_000 : opts.impactStartedAt;
  const resolvedAt =
    opts.resolvedAt === undefined
      ? status === "INVESTIGATING"
        ? null
        : OPENED + 3_600_000
      : opts.resolvedAt;

  await db.withWrite((w) => {
    w.prepare(
      `INSERT INTO incident (
         id, status, slackThreadTs, rootCause, prUrls, postmortem,
         usersImpacted, impactQuery, impactStartedAt, firstSignalAt, fixingAt,
         resolvedAt, closedAt, rotationAtOpen, sessionRef, lastStartedAt,
         attempts, modelId, tokensIn, tokensOut, cacheRead, cacheWrite,
         resolvedEvidence)
       VALUES (?, ?, 'thread-1', ?, ?, ?, 1240, 'sum(rate(errors))', ?, ?, ?, ?, ?, ?, ?, ?, 2, 'us.anthropic.claude-opus-5', 3000, 1200, 100000, 2000, ?)`,
    ).run(
      id,
      status,
      opts.rootCause ?? "The connection pool saturated after the <prod> deploy.",
      JSON.stringify(opts.prUrls ?? ["https://github.com/thegoodparty/omni/pull/42"]),
      postmortem,
      impactStartedAt,
      OPENED,
      OPENED + 900_000,
      resolvedAt,
      closedAt,
      JSON.stringify(["U-ONCALL"]),
      sessionRef,
      OPENED,
      "Errors stopped at 11:02; the alert cleared.",
    );
    if (opts.recurrenceOf !== undefined || opts.recurrenceAnalysis !== undefined) {
      w.prepare(
        "UPDATE incident SET recurrenceOf = ?, recurrenceAnalysis = ? WHERE id = ?",
      ).run(opts.recurrenceOf ?? null, opts.recurrenceAnalysis ?? null, id);
    }
    w.prepare(
      `INSERT INTO signal (id, source, sourceId, kind, title, body, labels, reportedBy, openedAt, closedAt, incidentId, explained)
       VALUES (?, 'grafana', ?, 'alert', ?, '', '{}', NULL, ?, ?, ?, 1)`,
    ).run(
      `${id}-sig`,
      `${id}-sig`,
      opts.signalTitle ?? "gp-api 5xx rate above 2%",
      OPENED,
      OPENED + 3_600_000,
      id,
    );
    w.prepare(
      `INSERT INTO incident_action (incidentId, actorKind, actorId, action, reason, at)
       VALUES (?, 'human', 'U-SWAIN', 'merge', 'same connection pool as inc-9', ?)`,
    ).run(id, OPENED + 120_000);
  });
  if (sessionRef) s3.objects.set(sessionRef, Buffer.from(SESSION, "utf8"));
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-report-"));
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  db?.close();
  s3 = fakeS3();
  posts = [];
  uploads = [];
  uploadFails = false;
  db = await Db.open({
    path: join(dir, `report-${Math.random().toString(36).slice(2)}.db`),
    bucket: "bugboss-test",
    key: "state/db",
    s3: s3 as unknown as S3Client,
  });
});

const markers = (incidentId: string): number =>
  db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM incident_action WHERE incidentId = ? AND action = ?",
    [incidentId, REPORT_PUBLISHED_ACTION],
  )[0].n;

describe("the report assembles from a real incident row", () => {
  it("carries the metrics, the post-mortem and the run's cost", async () => {
    await seed("inc-1");

    const data = await readReportData(deps(), "inc-1");
    assert.ok(data);
    assert.equal(data.run.modelId, "us.anthropic.claude-opus-5");
    assert.equal(data.run.turns, 2, "turns come from the session file, not the row");
    assert.equal(data.run.costUsd, 3.76);
    assert.equal(data.prs.length, 1);
    assert.equal(data.prs[0].state, null, "no PR reader wired, so state is not known");

    const doc = renderReportDocument(data);
    assert.match(doc, /^# Incident inc-1/);
    assert.match(doc, /\| Users impacted \| 1,240 \|/);
    // firstSignalAt - impactStartedAt, which is the alert rules and not the agent.
    assert.match(doc, /\| Time to detect \| 10m \|/);
    assert.match(doc, /\| Time to resolve \| 1h \|/);
    assert.match(doc, /\| Agent launches \| 2 \|/);
    assert.match(doc, /\| On call at open \| U-ONCALL \|/);
    assert.match(doc, /## Post-mortem/);
    assert.match(doc, /1\. The pool saturated\./);
    assert.match(doc, /## Root cause/);
    assert.match(doc, /\| Turns \| 2 \|/);
    assert.match(doc, /\| Total tokens \| 106,200 \(106\.2k\) \|/);
    assert.match(doc, /\| Cache read \| 100,000 \|/);
    assert.match(doc, /\$3\.76/);
    assert.match(doc, /derived and is not the record/);
    assert.match(doc, /https:\/\/github\.com\/thegoodparty\/omni\/pull\/42 — state not known/);
    assert.match(doc, /## What people did/);
    assert.match(doc, /U-SWAIN \| merge \| same connection pool as inc-9/);
  });

  it("says so rather than inventing a number it does not have", async () => {
    await seed("inc-2", { sessionRef: null });
    await db.withWrite((w) => {
      w.prepare(
        "UPDATE incident SET impactStartedAt = NULL, usersImpacted = NULL WHERE id = 'inc-2'",
      ).run();
    });

    const data = await readReportData(deps(), "inc-2");
    assert.ok(data);
    assert.equal(data.run.turns, null);
    assert.equal(data.run.costUsd, null);

    const doc = renderReportDocument(data);
    assert.match(doc, /\| Time to detect \| not known/);
    assert.match(doc, /\| Users impacted \| not measured \|/);
    assert.match(doc, /\| Turns \| not recorded \|/);
    assert.match(doc, /Tokens and the model id are the record here/);
    assert.doesNotMatch(doc, /\$0\.00/);
  });

  it("keeps an untrusted signal title inside its table cell", async () => {
    await seed("inc-3", {
      signalTitle: "pipe | in title\nand a newline",
    });

    const data = await readReportData(deps(), "inc-3");
    assert.ok(data);
    const table = renderReportDocument(data)
      .split("\n")
      .filter((line) => line.startsWith("| grafana |"));
    assert.equal(table.length, 1, "the title did not start a second row");
    assert.equal(
      (table[0].match(/(?<!\\)\|/g) ?? []).length,
      7,
      "six columns, so seven unescaped pipes: the title's own pipe is escaped",
    );
    assert.match(table[0], /pipe \\\| in title and a newline/);
  });

  it("nests the agent's own headings under the report's, code fences aside", async () => {
    await seed("inc-15", {
      postmortem: [
        "## Timeline",
        "",
        "Impact began at 10:00.",
        "",
        "```bash",
        "# this is a shell comment, not a heading",
        "kubectl rollout undo deploy/gp-api",
        "```",
      ].join("\n"),
    });

    const data = await readReportData(deps(), "inc-15");
    assert.ok(data);
    const doc = renderReportDocument(data);
    assert.match(doc, /^## Post-mortem$/m);
    assert.match(doc, /^### Timeline$/m, "the agent's h2 nests under the report's");
    assert.doesNotMatch(doc, /^## Timeline$/m);
    assert.match(
      doc,
      /^# this is a shell comment, not a heading$/m,
      "a fenced line is what the agent quoted, not a heading to demote",
    );
  });

  it("escapes the thread summary but not the document", async () => {
    await seed("inc-4", {
      rootCause: "A `<script>` tag & an ampersand reached the log line.",
    });

    const data = await readReportData(deps(), "inc-4");
    assert.ok(data);
    // The document is Markdown: nothing there can swallow the rest of a file.
    assert.match(renderReportDocument(data), /`<script>` tag & an ampersand/);
    // Slack reads `<...>` as an entity, so the same string has to be escaped.
    const summary = renderThreadSummary(data);
    assert.match(summary, /&lt;script&gt;/);
    assert.doesNotMatch(summary, /[^&]&[^agl]/);
  });
});

describe("publishing", () => {
  it("uploads the document and posts a summary beside it", async () => {
    await seed("inc-5");

    assert.equal(await publishIncidentReport(deps(), "inc-5"), "published");
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].channel, "C-INCIDENTS");
    assert.equal(uploads[0].threadTs, "thread-1");
    assert.equal(uploads[0].filename, "incident-inc-5.md");
    assert.match(uploads[0].content, /^# Incident inc-5/);
    // The summary rides on the file's own message, so the thread reads
    // without opening anything and there is no second post to scroll past.
    assert.match(uploads[0].comment, /\*Incident inc-5 — closing report\*/);
    assert.match(uploads[0].comment, /1,240 users impacted/);
    assert.match(uploads[0].comment, /106\.2k tokens/);
    assert.match(uploads[0].comment, /us\.anthropic\.claude-opus-5/);
    assert.equal(posts.length, 0, "a successful upload posts nothing separately");
  });

  it("refuses to publish an incident that has not closed", async () => {
    await seed("inc-6", { status: "INVESTIGATING", closedAt: null, postmortem: null });

    assert.equal(await publishIncidentReport(deps(), "inc-6"), "skipped");
    assert.equal(uploads.length, 0);
    assert.equal(posts.length, 0);
    assert.equal(markers("inc-6"), 0);
  });
});

describe("a failed upload degrades instead of breaking the close", () => {
  it("posts the whole report into the thread and says why", async () => {
    await seed("inc-7");
    uploadFails = true;

    assert.equal(await publishIncidentReport(deps(), "inc-7"), "degraded");
    assert.equal(uploads.length, 0);
    assert.ok(posts.length >= 2, "summary plus the report itself");
    assert.match(posts[0].text, /\*Incident inc-7 — closing report\*/);
    assert.match(posts[0].text, /could not be uploaded/);
    const body = posts.map((p) => p.text).join("\n");
    assert.match(body, /The pool saturated/, "the post-mortem still reached the thread");
    // Slack renders mrkdwn, so the document's Markdown headings are converted
    // on this path even though the file itself keeps them.
    assert.doesNotMatch(body, /^## Post-mortem$/m);
    assert.match(body, /\*Post-mortem\*/);
    assert.equal(
      db.get<{ status: string }>("SELECT status FROM incident WHERE id = 'inc-7'")
        ?.status,
      "CLOSED",
      "the transition is untouched by a failed notification",
    );
  });

  it("degrades the same way when no uploader is configured at all", async () => {
    await seed("inc-8");

    const outcome = await publishIncidentReport(
      deps({ uploader: undefined }),
      "inc-8",
    );
    assert.equal(outcome, "degraded");
    assert.match(posts[0].text, /no file upload configured/);
  });

  it("hands the claim back when the thread took nothing at all", async () => {
    await seed("inc-9");
    uploadFails = true;

    const outcome = await publishIncidentReport(
      deps({
        post: async () => {
          throw new Error("slack: ratelimited");
        },
      }),
      "inc-9",
    );

    assert.equal(outcome, "skipped");
    // The claim is what stops the sweep ever coming back, so leaving it
    // standing here would lose the report for good -- nothing relaunches an
    // agent on a CLOSED incident. Nothing landed, so a retry cannot post a
    // second copy, and `contact_human` already settled this trade for the
    // whole codebase: re-posting can at worst say it twice, not posting
    // cannot be recovered from at all.
    assert.equal(markers("inc-9"), 0);
    assert.equal(
      db.get<{ status: string }>("SELECT status FROM incident WHERE id = 'inc-9'")
        ?.status,
      "CLOSED",
      "and the transition is still untouched",
    );
  });

  it("keeps the claim when the thread took part of it", async () => {
    await seed("inc-9b");
    uploadFails = true;

    // The summary posts, the document underneath it does not. This is the
    // case the old ordering was right about: a retry would append a second
    // copy of a report a reader can already see half of, and half a report
    // somebody can read beats a duplicate they have to reconcile.
    let posted = 0;
    const outcome = await publishIncidentReport(
      deps({
        post: async (threadTs, text) => {
          posted++;
          if (posted > 1) throw new Error("slack: ratelimited");
          posts.push({ threadTs, text });
          return { ts: "ts-1" };
        },
      }),
      "inc-9b",
    );

    assert.equal(outcome, "skipped");
    assert.equal(posted, 2, "it got past the summary and failed on the document");
    assert.equal(markers("inc-9b"), 1, "so the claim stands and nothing retries");
  });
});

describe("a resumed or restarted container does not post it twice", () => {
  it("publishes once however many times it is asked", async () => {
    await seed("inc-10");

    assert.equal(await publishIncidentReport(deps(), "inc-10"), "published");
    assert.equal(await publishIncidentReport(deps(), "inc-10"), "skipped");
    assert.equal(await publishIncidentReport(deps(), "inc-10"), "skipped");
    assert.equal(uploads.length, 1);
    assert.equal(markers("inc-10"), 1);
  });

  it("publishes once when two publishers race", async () => {
    await seed("inc-11");

    const outcomes = await Promise.all([
      publishIncidentReport(deps(), "inc-11"),
      publishIncidentReport(deps(), "inc-11"),
    ]);
    assert.deepEqual(outcomes.filter((o) => o === "published").length, 1);
    assert.equal(uploads.length, 1);
    assert.equal(markers("inc-11"), 1);
  });
});

describe("the sweep catches a close whose container died", () => {
  it("publishes a closed incident that never got a report", async () => {
    await seed("inc-12", { closedAt: NOW - REPORT_SWEEP_GRACE_MS - 1_000 });

    assert.equal(await publishPendingReports(deps()), 1);
    assert.equal(uploads.length, 1);
  });

  it("leaves a just-closed incident to the fast path", async () => {
    await seed("inc-13", { closedAt: NOW - 1_000 });

    assert.equal(await publishPendingReports(deps()), 0);
    assert.equal(uploads.length, 0, "usage roll-up may still be in flight");
  });

  it("does not re-publish one the fast path already handled", async () => {
    await seed("inc-14", { closedAt: NOW - REPORT_SWEEP_GRACE_MS - 1_000 });
    await publishIncidentReport(deps(), "inc-14");

    assert.equal(await publishPendingReports(deps()), 0);
    assert.equal(uploads.length, 1);
  });
});

/**
 * Finds a row of the glance table by its label. A missing row is a failure
 * worth naming here rather than an `undefined` that makes every assertion
 * below it pass vacuously.
 */
const glanceRow = async (incidentId: string, label: string): Promise<string> => {
  const data = await readReportData(deps(), incidentId);
  assert.ok(data);
  const row = renderReportDocument(data)
    .split("\n")
    .find((line) => line.startsWith(`| ${label} |`));
  assert.ok(row, `the glance table always carries a "${label}" row`);
  return row;
};

describe("an interval whose two times disagree is named, not erased", () => {
  it("names the gap when impact is recorded as starting after the signal", async () => {
    // Both timestamps exist and they contradict each other: impact is on
    // record as beginning after we were already alerted. That is a fact about
    // whatever wrote the row, and the only place it can surface is here.
    await seed("inc-16", { impactStartedAt: OPENED + 12 * 60_000 });

    const data = await readReportData(deps(), "inc-16");
    assert.ok(data);
    assert.equal(reportMetrics(data).timeToDetectMs, -12 * 60_000);

    const row = await glanceRow("inc-16", "Time to detect");
    assert.match(row, /not usable/);
    assert.match(row, /beginning 12m after the first signal arrived/);
    assert.match(row, /one of the two times is wrong/);
    // The three states have to stay distinguishable in the output. Reading
    // "unknown" or "not known" here sends someone hunting for a timestamp
    // that was written, and never tells them it was written wrong.
    assert.doesNotMatch(row, /\| unknown \|/);
    assert.doesNotMatch(row, /not known/);
    // A raw pipe would open a third column and shift every row under it.
    assert.equal((row.match(/(?<!\\)\|/g) ?? []).length, 3);
  });

  it("carries the inconsistency into the thread summary too", async () => {
    await seed("inc-17", { impactStartedAt: OPENED + 12 * 60_000 });

    const data = await readReportData(deps(), "inc-17");
    assert.ok(data);
    const summary = renderThreadSummary(data);
    assert.match(summary, /detection time inconsistent/);
    // Most people only ever read the thread. Told the number was never
    // captured, they go looking for a writer that is in fact working.
    assert.doesNotMatch(summary, /time to detect not recorded/);
  });

  it("says something different for a time never recorded than for a backwards one", async () => {
    await seed("inc-18", { impactStartedAt: null });
    await seed("inc-19", { impactStartedAt: OPENED + 12 * 60_000 });

    const absent = await glanceRow("inc-18", "Time to detect");
    const backwards = await glanceRow("inc-19", "Time to detect");

    assert.match(absent, /not known — when impact began was never recorded/);
    // One sentence for both is the regression: nothing downstream, human or
    // otherwise, can then tell a gap in the data from a contradiction in it.
    assert.notEqual(absent, backwards);
  });

  it("names a resolve time that lands before the first signal", async () => {
    await seed("inc-20", { resolvedAt: OPENED - 5 * 60_000 });

    const row = await glanceRow("inc-20", "Time to resolve");
    assert.equal(
      row,
      "| Time to resolve | not usable — the incident is recorded as resolved 5m before its first signal arrived, so one of the two times is wrong |",
    );

    const data = await readReportData(deps(), "inc-20");
    assert.ok(data);
    assert.match(renderThreadSummary(data), /resolve time inconsistent/);
  });

  it("names a close time that lands before the first signal", async () => {
    await seed("inc-21", { closedAt: OPENED - 7 * 60_000 });

    // Its own row, not the resolve wording: the reader has to know which of
    // the two pairs of timestamps to go and look at.
    const row = await glanceRow("inc-21", "Open to closed");
    assert.equal(
      row,
      "| Open to closed | not usable — the incident is recorded as closed 7m before its first signal arrived, so one of the two times is wrong |",
    );
    assert.notEqual(row, await glanceRow("inc-21", "Time to resolve"));
  });
});

describe("duration prints the length it was handed", () => {
  it("keeps the sign on a negative rather than swallowing it", () => {
    // Deciding what a backwards interval means is `interval`'s job, so in
    // principle nothing reaches here with a negative. The point of printing
    // the sign is the call site nobody has thought of yet: it shows a number
    // that is visibly wrong instead of quietly showing none at all.
    assert.equal(duration(-12 * 60_000), "-12m");
    assert.equal(duration(-(3_600_000 + 4 * 60_000)), "-1h 4m");
  });

  it("keeps \"unknown\" for a number that is not one", () => {
    assert.equal(duration(Number.NaN), "unknown");
    assert.equal(duration(Number.POSITIVE_INFINITY), "unknown");
    assert.equal(duration(Number.NEGATIVE_INFINITY), "unknown");
  });
});

describe("the report survives GitHub being unreachable", () => {
  it("publishes the whole report when the PR reader throws", async () => {
    await seed("inc-22");

    const outcome = await publishIncidentReport(
      deps({
        prStates: {
          states: async () => {
            throw new Error("github: 503");
          },
        },
      }),
      "inc-22",
    );

    // PR state is the one field in the report that depends on a service we
    // do not run. Losing the report over it would trade every metric, the
    // post-mortem and the spend for one column nobody was blocked on.
    assert.equal(outcome, "published");
    assert.equal(uploads.length, 1);
    assert.match(uploads[0].content, /^# Incident inc-22/);
    assert.match(uploads[0].content, /pull\/42 — state not known/);
    assert.match(uploads[0].content, /\| Pull requests \| 1 \(0 merged\) \|/);
  });

  it("reflects a state the reader does answer with", async () => {
    await seed("inc-23");
    const wired = deps({
      prStates: {
        states: async () => ({
          "https://github.com/thegoodparty/omni/pull/42": "merged",
        }),
      },
    });

    const data = await readReportData(wired, "inc-23");
    assert.ok(data);
    assert.equal(reportMetrics(data).prsMerged, 1);

    const doc = renderReportDocument(data);
    assert.match(doc, /pull\/42 — merged/);
    assert.match(doc, /\| Pull requests \| 1 \(1 merged\) \|/);
    // The merged count is in the thread too, because "did the fix land" is
    // the question people scanning the channel are actually asking.
    assert.match(renderThreadSummary(data), /1 PR \(1 merged\)/);
  });

  it("answers for the urls it was told about and says so for the rest", async () => {
    await seed("inc-24", {
      prUrls: [
        "https://github.com/thegoodparty/omni/pull/42",
        "https://github.com/thegoodparty/omni/pull/43",
      ],
    });
    const wired = deps({
      prStates: {
        states: async () => ({
          "https://github.com/thegoodparty/omni/pull/42": "open",
        }),
      },
    });

    const data = await readReportData(wired, "inc-24");
    assert.ok(data);
    // A partial answer must not smear across the urls it did not cover: a
    // reader who sees a state at all is entitled to believe GitHub said it.
    assert.deepEqual(data.prs, [
      { url: "https://github.com/thegoodparty/omni/pull/42", state: "open" },
      { url: "https://github.com/thegoodparty/omni/pull/43", state: null },
    ]);

    const doc = renderReportDocument(data);
    assert.match(doc, /pull\/42 — open/);
    assert.match(doc, /pull\/43 — state not known/);
    assert.match(doc, /\| Pull requests \| 2 \(0 merged\) \|/);
  });
});

describe("an incident that came back explains itself", () => {
  it("carries the recorded answer, in words rather than as a slug", async () => {
    // The whole value of the recurrence answer is that it was written at
    // close and, before this, read back by nobody.
    // recurrenceOf is a foreign key, so the incident it points at is real.
    await seed("inc-30-prior");
    await seed("inc-30", {
      recurrenceOf: "inc-30-prior",
      recurrenceAnalysis: JSON.stringify({
        category: "previous_fix_incomplete",
        why: "The pool limit was raised on the web dynos and not on the worker, which opens the same pool.",
        remedy: "Raised it in the shared config both read, and added a check that they cannot diverge.",
      }),
    });

    const data = await readReportData(deps(), "inc-30");
    assert.ok(data);
    const doc = renderReportDocument(data);

    assert.match(doc, /^## Why it came back$/m);
    assert.match(doc, /A recurrence of inc-30-prior: the cause was right but only one way into the failure was closed\./);
    assert.match(doc, /not on the worker/);
    assert.match(doc, /added a check that they cannot diverge/);
    // A reader should not have to know the closed set to read the report.
    assert.doesNotMatch(doc, /previous_fix_incomplete/);
  });

  it("says plainly when the recurrence was BugBoss's own fault", async () => {
    // The one category nothing else in the system would ever surface.
    await seed("inc-31-prior");
    await seed("inc-31", {
      recurrenceOf: "inc-31-prior",
      recurrenceAnalysis: JSON.stringify({
        category: "bugboss_defect",
        why: "The close ran before the sweep had confirmed the alert stayed clear.",
        remedy: "Nothing yet; it needs a change in ops and the incident is filed there.",
      }),
    });

    const data = await readReportData(deps(), "inc-31");
    assert.ok(data);
    assert.match(
      renderReportDocument(data),
      /BugBoss let a premature close happen; the fix belongs in ops/,
    );
  });

  it("publishes a report even when the stored answer will not parse", async () => {
    await seed("inc-32-prior");
    await seed("inc-32", {
      recurrenceOf: "inc-32-prior",
      recurrenceAnalysis: "{not json",
    });

    const data = await readReportData(deps(), "inc-32");
    assert.ok(data);
    assert.equal(data.recurrence, null);

    const doc = renderReportDocument(data);
    // Missing rather than wrong, and said so: a recurrence section that
    // quietly vanished would read as an incident that never recurred.
    assert.match(doc, /^## Why it came back$/m);
    assert.match(doc, /could not be read back, so it is missing here rather than wrong/);
    assert.match(doc, /## Post-mortem/, "the rest of the report is untouched");
    assert.equal(await publishIncidentReport(deps(), "inc-32"), "published");
  });

  it("treats a row that parses but is not an answer the same as one that does not", async () => {
    // Rendering runs after the publish is claimed, so a `why` that turned out
    // to be missing would throw with the marker already durable -- and that
    // is the one failure that loses a report for good rather than degrading.
    for (const [id, stored] of [
      ["inc-34", "null"],
      ["inc-35", "42"],
      ["inc-36", JSON.stringify({ category: "previous_fix_wrong" })],
      ["inc-37", JSON.stringify({ category: 1, why: "x", remedy: "y" })],
    ] as const) {
      await seed(`${id}-prior`);
      await seed(id, { recurrenceOf: `${id}-prior`, recurrenceAnalysis: stored });

      const data = await readReportData(deps(), id);
      assert.ok(data);
      assert.equal(data.recurrence, null, stored);
      assert.match(renderReportDocument(data), /could not be read back/);
      assert.equal(await publishIncidentReport(deps(), id), "published", stored);
    }
  });

  it("says nothing at all for an incident that did not come back", async () => {
    await seed("inc-33");

    const data = await readReportData(deps(), "inc-33");
    assert.ok(data);
    assert.equal(data.recurrence, null);
    assert.doesNotMatch(renderReportDocument(data), /Why it came back/);
  });
});

describe("a report that cannot be rendered is not a report that is lost", () => {
  it("leaves no claim behind, so a later attempt still publishes", async () => {
    // The claim is durable and the sweep will not revisit an incident that
    // carries one, so the order of render and claim decides whether a bad row
    // costs one attempt or the report itself. This is the failure that does
    // not show up in the run that causes it: the marker persists, and the
    // next container comes up, sees it, and stays quiet forever.
    //
    // `rotationAtOpen` holds JSON written by another module. Valid JSON that
    // is not a list is the cheapest way to reach a throw inside rendering.
    await seed("inc-40");
    await db.withWrite((w) => {
      w.prepare("UPDATE incident SET rotationAtOpen = '{}' WHERE id = 'inc-40'").run();
    });

    assert.equal(await publishIncidentReport(deps(), "inc-40"), "skipped");
    assert.equal(uploads.length, 0);
    assert.equal(posts.length, 0, "nothing half-posted either");
    assert.equal(markers("inc-40"), 0, "and nothing durable to suppress a retry");

    // The sweep would pick it up again on the next tick, and once the row is
    // readable the report goes out in full.
    await db.withWrite((w) => {
      w.prepare(
        `UPDATE incident SET rotationAtOpen = '["U-ONCALL"]' WHERE id = 'inc-40'`,
      ).run();
    });

    assert.equal(await publishIncidentReport(deps(), "inc-40"), "published");
    assert.equal(uploads.length, 1);
    assert.match(uploads[0].content, /\| On call at open \| U-ONCALL \|/);
    assert.equal(markers("inc-40"), 1);
  });

  it("a failed upload leaves the incident closed and the claim standing", async () => {
    // The degraded path is the one that persists a marker without a file, so
    // what matters is that nothing else was disturbed: the transition is
    // untouched and the next resume reads a CLOSED incident with a report
    // already accounted for, rather than re-posting one.
    await seed("inc-41");
    uploadFails = true;

    assert.equal(await publishIncidentReport(deps(), "inc-41"), "degraded");
    assert.equal(markers("inc-41"), 1);
    assert.equal(
      db.get<{ status: string }>("SELECT status FROM incident WHERE id = 'inc-41'")
        ?.status,
      "CLOSED",
    );

    // A second pass -- a restart, or the sweep -- reads that marker and stops.
    const before = posts.length;
    assert.equal(await publishIncidentReport(deps(), "inc-41"), "skipped");
    assert.equal(posts.length, before, "no second copy in the thread");
  });
});

describe("an interval too wide to be one incident is named, not printed", () => {
  it("refuses a detect time computed from a seconds epoch", async () => {
    // `impactStartedAt` is validated as a positive integer and documented as
    // epoch millis, so a model handing back seconds passes validation clean.
    // Nothing downstream can tell: the subtraction succeeds, both times are
    // present and in the right order, and the most consequential row in the
    // table renders a confident answer twenty thousand days wide.
    const asSeconds = Math.round(OPENED / 1000);
    await seed("inc-50", { impactStartedAt: asSeconds });

    const data = await readReportData(deps(), "inc-50");
    assert.ok(data);
    const gap = reportMetrics(data).timeToDetectMs;
    assert.ok(gap !== null && gap > 0, "the sign is right, which is why nothing caught it");

    const row = await glanceRow("inc-50", "Time to detect");
    assert.match(row, /not usable/);
    assert.match(row, /further apart than any incident lasts/);
    assert.match(row, /written in the wrong unit/);
    // This is the whole point of the branch, and the assertion the others
    // rest on. A plausibly-shaped duration on this row gets read as a
    // detection time and acted on, and it is wrong by a factor of a
    // thousand -- so the number must not reach the page at all, not even
    // inside a sentence disowning it.
    assert.ok(!row.includes(duration(gap)), "the number that cannot be right is absent");
    assert.doesNotMatch(row, /\d+d/);
    // And it is still one cell: a raw pipe would shift every row under it.
    assert.equal((row.match(/(?<!\\)\|/g) ?? []).length, 3);
  });

  it("says something different again than for an absent or a backwards time", async () => {
    await seed("inc-51", { impactStartedAt: null });
    await seed("inc-52", { impactStartedAt: OPENED + 12 * 60_000 });
    await seed("inc-53", { impactStartedAt: Math.round(OPENED / 1000) });

    const absent = await glanceRow("inc-51", "Time to detect");
    const backwards = await glanceRow("inc-52", "Time to detect");
    const implausible = await glanceRow("inc-53", "Time to detect");

    // Three states, three sentences, and collapsing any pair of them costs
    // the reader the only thing this row can tell them: whether to go
    // looking for a writer that never ran, two clocks that disagree, or a
    // caller passing the wrong unit. They are different repairs.
    assert.notEqual(implausible, absent);
    assert.notEqual(implausible, backwards);
    assert.notEqual(absent, backwards);
  });

  it("carries the implausible case into the thread summary too", async () => {
    await seed("inc-54", { impactStartedAt: Math.round(OPENED / 1000) });

    const data = await readReportData(deps(), "inc-54");
    assert.ok(data);
    const summary = renderThreadSummary(data);
    assert.match(summary, /detection time not usable/);
    // Most people only ever read the thread, so "detected in 20337d" there
    // is the same wrong number with the wider audience.
    assert.doesNotMatch(summary, /detected in/);
    assert.doesNotMatch(summary, /\d+d \d+h/);
    // Not the backwards wording either. These two times are in order; it is
    // the distance between them that is impossible, and someone told they
    // are out of order goes looking at the wrong thing.
    assert.doesNotMatch(summary, /detection time inconsistent/);
  });

  it("still measures an incident that genuinely ran for weeks", async () => {
    // The ceiling has to sit well above anything real, or it turns a slow
    // incident into a fabricated data error -- the same failure pointing the
    // other way, and a harder one to argue with because it reads as rigour.
    await seed("inc-56", { impactStartedAt: OPENED - 30 * 86_400_000 });

    const row = await glanceRow("inc-56", "Time to detect");
    assert.equal(row, "| Time to detect | 30d |");
  });

  it("does not report a sub-second contradiction as no contradiction", async () => {
    // Both times are recorded and 400ms out of order. Whole seconds rounded
    // that to "0s", so the row declared the timeline self-contradictory and
    // then gave the contradiction as zero -- which reads as an argument
    // against its own finding, and invites the reader to dismiss it.
    await seed("inc-55", { impactStartedAt: OPENED + 400 });

    const data = await readReportData(deps(), "inc-55");
    assert.ok(data);
    assert.equal(reportMetrics(data).timeToDetectMs, -400);

    const row = await glanceRow("inc-55", "Time to detect");
    assert.match(row, /not usable/);
    assert.match(row, /beginning <1s after the first signal arrived/);
    assert.doesNotMatch(row, /beginning 0s/);
  });
});

describe("duration tells a short length from no length", () => {
  it("reads a gap under a second as one rather than rounding it away", () => {
    // "0s" is not a smaller number than "<1s", it is a different claim: it
    // says the two moments coincide. The caller that cannot afford that is
    // `interval`'s backwards branch, which prints the size of a
    // contradiction it has just declared.
    assert.equal(duration(1), "<1s");
    assert.equal(duration(400), "<1s");
    assert.equal(duration(999), "<1s");
    // Zero is untouched, because nothing was rounded and so nothing is
    // being hidden: the two moments really are the same moment.
    assert.equal(duration(0), "0s");
    assert.equal(duration(1_000), "1s");
  });

  it("keeps the sign on a sub-second negative as on any other", () => {
    assert.equal(duration(-400), "-<1s");
    assert.equal(duration(-12 * 60_000), "-12m");
  });

  it("still refuses to print a number that is not one", () => {
    assert.equal(duration(Number.NaN), "unknown");
    assert.equal(duration(Number.POSITIVE_INFINITY), "unknown");
  });
});

describe("interval decides what a difference means before anyone prints it", () => {
  it("sends a difference that is not a number to the absent sentence", () => {
    // `duration` answers "unknown" for a NaN, which is the bare word this
    // file exists to argue against: it tells the reader nothing about which
    // of the two moments to go and look at. A difference that is not a
    // number means one of them was not one either, which is what `absent`
    // already says in a sentence.
    const say = {
      absent: "not known — when impact began was never recorded",
      backwards: (gap: string) => `backwards by ${gap}`,
      implausible: () => "too far apart to be one incident",
    };
    assert.equal(interval(Number.NaN, say), say.absent);
    assert.equal(interval(Number.POSITIVE_INFINITY, say), say.absent);
    assert.equal(interval(Number.NEGATIVE_INFINITY, say), say.absent);
  });

  it("falls back to the backwards sentence for a caller that did not distinguish", () => {
    // The default is what lets a new call site be added without being taught
    // this state. Worst case its reader gets the wrong reason; they never
    // get the number, which is the failure that matters.
    const said = interval(400 * 86_400_000, {
      absent: "absent",
      backwards: (gap) => `not usable — ${gap} out of order`,
    });
    assert.match(said, /not usable/);
    assert.notEqual(said, "absent");
  });
});

describe("a row that can never be rendered stops being retried", () => {
  it("answers in the thread once retrying has stopped being useful", async () => {
    // Rendering is pure, so a row it cannot read fails identically on every
    // tick -- and the sweep takes the ten oldest unpublished closes, so ten
    // rows like this and no report publishes again, with a pair of alarms
    // every thirty seconds as the only sign. After the window it is answered
    // instead of repeated, which is the one thing a repeating alarm never
    // does.
    await seed("inc-42", { closedAt: NOW - REPORT_GIVE_UP_MS - 60_000 });
    await db.withWrite((w) => {
      w.prepare("UPDATE incident SET rotationAtOpen = '{}' WHERE id = 'inc-42'").run();
    });

    assert.equal(await publishIncidentReport(deps(), "inc-42"), "degraded");
    assert.equal(uploads.length, 0, "there was no document to upload");
    assert.equal(posts.length, 1, "one line, not a partial report");
    assert.match(posts[0].text, /could not be written/);
    assert.match(posts[0].text, /inc-42/);
    assert.equal(markers("inc-42"), 1, "claimed, so it stops coming round");

    // And it stays stopped.
    assert.equal(await publishIncidentReport(deps(), "inc-42"), "skipped");
    assert.equal(posts.length, 1);
  });

  it("keeps retrying inside the window, in case the row is repaired", async () => {
    await seed("inc-43", { closedAt: NOW - 60_000 });
    await db.withWrite((w) => {
      w.prepare("UPDATE incident SET rotationAtOpen = '{}' WHERE id = 'inc-43'").run();
    });

    assert.equal(await publishIncidentReport(deps(), "inc-43"), "skipped");
    assert.equal(posts.length, 0, "nothing said yet; it may still come good");
    assert.equal(markers("inc-43"), 0, "and nothing durable to suppress the retry");
  });

  it("gives up without a thread to give up into, and says so rather than looping", async () => {
    // A thread that will not take even the one line leaves the claim off, so
    // the sweep is free to try again -- the same rule the degraded path uses.
    await seed("inc-44", { closedAt: NOW - REPORT_GIVE_UP_MS - 60_000 });
    await db.withWrite((w) => {
      w.prepare("UPDATE incident SET rotationAtOpen = '{}' WHERE id = 'inc-44'").run();
    });

    const outcome = await publishIncidentReport(
      deps({
        post: async () => {
          throw new Error("slack: channel_not_found");
        },
      }),
      "inc-44",
    );

    assert.equal(outcome, "skipped");
    assert.equal(markers("inc-44"), 0);
  });
});
