// What became of the pull requests an open incident is waiting on, noticed in
// code rather than by the agent.
//
// An agent that watches its own PR merge can be parked, dead, restarting,
// out of budget, or simply not say so. Incident 84's agent saw the merge
// within three minutes and the thread still said it needed a person to merge;
// incident 90's said so for 1h40m. So the merge, the close and delegate's
// settled verdict are read off GitHub here, once a minute, in one GraphQL
// call for every watched PR, and each transition is told to the thread and to
// the agent exactly once, whoever sees it first.

import type Database from "better-sqlite3";

import { DELEGATE_STATE_MARKER, REVIEW_SETTLE_SECONDS, parsePr, type PrRef } from "../agent/conditions";
import type { Db } from "../db";
import { makeAlarm, makeLog } from "../logging";
import { OPEN_STATUSES } from "../slack/status";
import { link, mrkdwn, raw } from "../slack/format";
import { createAnnouncer, type AnnouncePoster } from "../toolapi/announce";
import { pushDirective, rowToIncident, type IncidentRow } from "../toolapi/assign";

const alarm = makeAlarm("prwatch");
const log = makeLog("prwatch");

export const PR_WATCH_INTERVAL_MS = 60_000;

export type Recommendation = "approve" | "comment" | "request changes";

export interface DelegateVerdict {
  recommendation: Recommendation;
  sha: string;
  at: string;
  url: string;
}

export interface PrObservation {
  state: "OPEN" | "MERGED" | "CLOSED";
  url: string;
  mergedAt: string | null;
  closedAt: string | null;
  mergedBy: string | null;
  mergeCommit: string | null;
  head: string;
  /** delegate-reviewer's latest verdict on the head, settled or not. */
  verdict: DelegateVerdict | null;
}

/**
 * The one read this makes. Every ref in one call, so the cost of a tick does
 * not grow with the number of agents: the org ran out of REST quota on the
 * day this was written. A ref GitHub has no PR for is simply absent; a call
 * that failed outright throws.
 */
export interface PrWatchReader {
  read(refs: readonly PrRef[]): Promise<Map<string, PrObservation>>;
}

export const refKey = (ref: Pick<PrRef, "repo" | "number">): string => `${ref.repo}#${ref.number}`;

const PR_MENTION = /https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+|(?<![\w/#])(?:[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+#\d+\b/g;

/**
 * Every pull request a piece of text names, as `owner/repo#N`, `repo#N` or a
 * URL. An entity check, not a reading of what the text means: it decides
 * which PR a wait is on, never what anybody wanted.
 */
export const prRefsIn = (text: string | null | undefined): PrRef[] => {
  const found = new Map<string, PrRef>();
  for (const match of (text ?? "").matchAll(PR_MENTION)) {
    const ref = parsePr(match[0]);
    if (ref) found.set(refKey(ref), ref);
  }
  return [...found.values()];
};

const RECOMMENDATION = /Recommendation:\s*\**\s*(approve|comment|request[ -]changes)\b/i;

/** What a delegate review or state comment recommends, or null if it does not say. */
export const recommendationIn = (body: string | null, state?: string): Recommendation | null => {
  const said = RECOMMENDATION.exec(body ?? "")?.[1]?.toLowerCase().replace("-", " ");
  if (said === "approve" || said === "comment" || said === "request changes") return said;
  return state === "APPROVED" ? "approve" : null;
};

export interface ReviewNode {
  author: { login: string } | null;
  state: string;
  body: string | null;
  submittedAt: string | null;
  url: string;
  commit: { oid: string } | null;
}

export interface CommentNode {
  author: { login: string } | null;
  body: string | null;
  updatedAt: string;
  url: string;
}

const isDelegate = (login: string | undefined): boolean => (login ?? "").toLowerCase().startsWith("delegate-reviewer");

/**
 * delegate's verdict on the head commit, newest first. A review counts only
 * on the head it reviewed. The state comment carries no commit, so it counts
 * when it was written after the head was committed.
 */
export const latestDelegateVerdict = (args: {
  head: string;
  headCommittedAt: string | null;
  reviews: readonly ReviewNode[];
  comments: readonly CommentNode[];
}): DelegateVerdict | null => {
  const verdicts: DelegateVerdict[] = [];
  for (const review of args.reviews) {
    if (!isDelegate(review.author?.login) || review.commit?.oid !== args.head || !review.submittedAt) continue;
    const recommendation = recommendationIn(review.body, review.state);
    if (recommendation) verdicts.push({ recommendation, sha: args.head, at: review.submittedAt, url: review.url });
  }
  const headAt = args.headCommittedAt ? Date.parse(args.headCommittedAt) : 0;
  for (const comment of args.comments) {
    if (!isDelegate(comment.author?.login)) continue;
    if (!(comment.body ?? "").trimStart().startsWith(DELEGATE_STATE_MARKER)) continue;
    if (Date.parse(comment.updatedAt) < headAt) continue;
    const recommendation = recommendationIn(comment.body);
    if (recommendation) verdicts.push({ recommendation, sha: args.head, at: comment.updatedAt, url: comment.url });
  }
  verdicts.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return verdicts.at(-1) ?? null;
};

interface WatchRow {
  incidentId: string;
  repo: string;
  number: number;
  state: string | null;
  verdict: string | null;
  verdictSha: string | null;
  announcedAt: number | null;
}

const OPEN_SQL = OPEN_STATUSES.map((status) => `'${status}'`).join(", ");

/**
 * The PRs an open incident owns: what it shipped (`prUrls`), what its agent
 * recorded opening, and what its waits on a person name. A row, once
 * written, is what keeps the PR watched after the wait that named it ends.
 */
const discover = (db: Db): { incidentId: string; ref: PrRef }[] => {
  const found: { incidentId: string; ref: PrRef }[] = [];
  const add = (incidentId: string, text: string | null) => {
    for (const ref of prRefsIn(text)) found.push({ incidentId, ref });
  };
  for (const row of db.query<{ id: string; prUrls: string }>(
    `SELECT id, prUrls FROM incident WHERE status IN (${OPEN_SQL})`,
  )) {
    try {
      for (const url of JSON.parse(row.prUrls) as unknown[]) if (typeof url === "string") add(row.id, url);
    } catch {
      log("pr_urls_unreadable", { incidentId: row.id });
    }
  }
  for (const row of db.query<{ incidentId: string; evidenceUrl: string | null }>(
    `SELECT t.incidentId, t.evidenceUrl FROM incident_timeline_event t JOIN incident i ON i.id = t.incidentId
      WHERE i.status IN (${OPEN_SQL}) AND t.kind IN ('fix_pr_opened', 'fix_merged')`,
  )) add(row.incidentId, row.evidenceUrl);
  for (const row of db.query<{ incidentId: string; command: string; waitingFor: string | null }>(
    `SELECT p.incidentId, p.command, p.waitingFor FROM pending_wait p JOIN incident i ON i.id = p.incidentId
      WHERE i.status IN (${OPEN_SQL})`,
  )) add(row.incidentId, `${row.command} ${row.waitingFor ?? ""}`);
  for (const row of db.query<{ incidentId: string; waitingFor: string }>(
    `SELECT w.incidentId, w.waitingFor FROM incident_wait w JOIN incident i ON i.id = w.incidentId
      WHERE i.status IN (${OPEN_SQL})`,
  )) add(row.incidentId, row.waitingFor);
  return found;
};

const names = (text: string | null, ref: PrRef): boolean =>
  prRefsIn(text).some((other) => refKey(other) === refKey(ref));

/** Whether a person is being waited on for this PR: the thing a merge ends. */
const personWaitsOn = (w: Database.Database, incidentId: string, ref: PrRef): boolean => {
  const monitor = w
    .prepare("SELECT command, waitingFor FROM pending_wait WHERE incidentId = ?")
    .get(incidentId) as { command: string; waitingFor: string | null } | undefined;
  const parked = w
    .prepare("SELECT waitingFor FROM incident_wait WHERE incidentId = ?")
    .get(incidentId) as { waitingFor: string } | undefined;
  return (
    (monitor !== undefined && names(`${monitor.command} ${monitor.waitingFor ?? ""}`, ref)) ||
    (parked !== undefined && names(parked.waitingFor, ref))
  );
};

const utc = (iso: string | null): string => {
  if (!iso) return "an unknown time";
  const at = new Date(iso);
  return `${at.toISOString().slice(11, 16)} UTC`;
};

const short = (sha: string | null): string => (sha ?? "").slice(0, 7);

const prLabel = (ref: PrRef, url: string): string => link(url, ref.label);

export const mergedNotice = (ref: PrRef, pr: PrObservation): string =>
  [
    mrkdwn`*${raw(prLabel(ref, pr.url))} merged*`,
    pr.mergedBy ? mrkdwn` by @${pr.mergedBy}` : "",
    mrkdwn` at ${utc(pr.mergedAt)}`,
    pr.mergeCommit ? mrkdwn` · merge commit \`${short(pr.mergeCommit)}\`` : "",
  ].join("");

export const closedNotice = (ref: PrRef, pr: PrObservation): string =>
  mrkdwn`*${raw(prLabel(ref, pr.url))} closed without merging* at ${utc(pr.closedAt)}`;

export const verdictNotice = (ref: PrRef, verdict: DelegateVerdict): string =>
  mrkdwn`*delegate: ${verdict.recommendation}* on ${raw(prLabel(ref, verdict.url))} at \`${short(verdict.sha)}\``;

const mergedDirective = (ref: PrRef, pr: PrObservation): string =>
  `${ref.label} (${pr.url}) was merged${pr.mergedBy ? ` by ${pr.mergedBy}` : ""} at ${pr.mergedAt ?? "an unknown time"}${pr.mergeCommit ? `, merge commit ${pr.mergeCommit}` : ""}. BugBoss saw it on GitHub and has told the thread, so you do not need to. Carry on from the merge: confirm it ships and that the fix holds.`;

const closedDirective = (ref: PrRef, pr: PrObservation): string =>
  `${ref.label} (${pr.url}) was closed without merging at ${pr.closedAt ?? "an unknown time"}. BugBoss saw it on GitHub and has told the thread. Find out why before you open another.`;

const verdictDirective = (ref: PrRef, verdict: DelegateVerdict): string =>
  `delegate-reviewer's settled verdict on ${ref.label} at head ${verdict.sha} is: ${verdict.recommendation}. Read it at ${verdict.url}. BugBoss has told the thread.`;

export interface PrWatcherDeps {
  db: Db;
  reader: PrWatchReader;
  slack: AnnouncePoster;
  now?: () => number;
  settleMs?: number;
  intervalMs?: number;
}

export interface PrWatcher {
  /** One pass, at most once per interval. Returns the notices it posted. */
  sweep(): Promise<number>;
  /**
   * An agent's wait on a person just ended, naming these PRs. Reads them now
   * and announces whatever has happened, so the thread hears it once whether
   * this or the sweep saw it first. True when every one of them is merged or
   * closed and the thread has been told, which is when the agent's own "done"
   * would only repeat it.
   */
  coversWaitDone(incidentId: string, text: string): Promise<boolean>;
}

type Transition =
  | { kind: "merged"; pr: PrObservation }
  | { kind: "closed"; pr: PrObservation }
  | { kind: "verdict"; verdict: DelegateVerdict };

export const createPrWatcher = (deps: PrWatcherDeps): PrWatcher => {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const settleMs = deps.settleMs ?? REVIEW_SETTLE_SECONDS * 1000;
  const intervalMs = deps.intervalMs ?? PR_WATCH_INTERVAL_MS;
  const announcer = createAnnouncer({ db, slack: deps.slack });
  let lastSweepAt: number | null = null;
  let running: Promise<number> | null = null;

  const record = async (pairs: { incidentId: string; ref: PrRef }[]): Promise<void> => {
    const missing = pairs.filter(
      ({ incidentId, ref }) =>
        !db.get("SELECT 1 FROM pr_watch WHERE incidentId = ? AND repo = ? AND number = ?", [
          incidentId,
          ref.repo,
          ref.number,
        ]),
    );
    if (!missing.length) return;
    await db.withWrite((w) => {
      const insert = w.prepare(
        "INSERT OR IGNORE INTO pr_watch (incidentId, repo, number, firstSeenAt) VALUES (?, ?, ?, ?)",
      );
      for (const { incidentId, ref } of missing) insert.run(incidentId, ref.repo, ref.number, now());
    });
    log("prs_watched", { count: missing.length });
  };

  const settled = (verdict: DelegateVerdict | null): DelegateVerdict | null =>
    verdict && now() - Date.parse(verdict.at) >= settleMs ? verdict : null;

  /**
   * Commits the transition, then says it. The guard is in the UPDATE, so of
   * two observers of one merge exactly one gets `changes === 1` and posts;
   * and the commit goes before the post, so a container that dies between
   * the two stays quiet rather than saying it twice.
   */
  const apply = async (
    row: WatchRow,
    ref: PrRef,
    pr: PrObservation,
    options: { fromAgent: boolean },
  ): Promise<Transition | null> => {
    const verdict = settled(pr.verdict);
    // Every write is a snapshot to S3, so a minute in which nothing moved
    // must not write.
    if (
      row.state === "OPEN" &&
      pr.state === "OPEN" &&
      (!verdict || (verdict.recommendation === row.verdict && verdict.sha === row.verdictSha))
    ) {
      return null;
    }
    return db.withWrite((w): Transition | null => {
      const baseline = row.state === null;
      if (pr.state !== "OPEN") {
        // A PR first seen already merged is news only if somebody is still
        // waiting on it; otherwise it is history, and a deploy of this
        // watcher would re-announce every PR every open incident ever shipped.
        if (baseline && !options.fromAgent && !personWaitsOn(w, row.incidentId, ref)) {
          w.prepare(
            "UPDATE pr_watch SET state = ? WHERE incidentId = ? AND repo = ? AND number = ? AND state IS NULL",
          ).run(pr.state, row.incidentId, ref.repo, ref.number);
          return null;
        }
        const changes = w
          .prepare(
            `UPDATE pr_watch SET state = ?, announcedAt = ? WHERE incidentId = ? AND repo = ? AND number = ?
               AND announcedAt IS NULL`,
          )
          .run(pr.state, now(), row.incidentId, ref.repo, ref.number).changes;
        if (changes === 0) return null;

        const monitor = w
          .prepare("SELECT command, waitingFor FROM pending_wait WHERE incidentId = ?")
          .get(row.incidentId) as { command: string; waitingFor: string | null } | undefined;
        if (monitor && names(`${monitor.command} ${monitor.waitingFor ?? ""}`, ref)) {
          w.prepare("DELETE FROM pending_wait WHERE incidentId = ?").run(row.incidentId);
        }
        const kind: "merged" | "closed" = pr.state === "MERGED" ? "merged" : "closed";
        w.prepare(
          `INSERT INTO incident_action (incidentId, actorKind, actorId, action, reason, at)
           VALUES (?, 'boss', NULL, ?, ?, ?)`,
        ).run(
          row.incidentId,
          kind === "merged" ? "pr_merged" : "pr_closed",
          `${ref.label}${pr.mergedBy ? ` by ${pr.mergedBy}` : ""} at ${pr.mergedAt ?? pr.closedAt ?? "unknown"}`,
          now(),
        );
        // The agent saw it itself; telling it again would only steer it back
        // over ground it has already covered.
        if (!options.fromAgent) {
          pushDirective(w, row.incidentId, {
            type: "boss_message",
            text: kind === "merged" ? mergedDirective(ref, pr) : closedDirective(ref, pr),
            at: now(),
          });
        }
        return kind === "merged" ? { kind, pr } : { kind, pr };
      }

      const fresh = w
        .prepare(
          `UPDATE pr_watch SET state = 'OPEN' WHERE incidentId = ? AND repo = ? AND number = ? AND state IS NULL`,
        )
        .run(row.incidentId, ref.repo, ref.number).changes;
      if (!verdict) return null;
      const changes = w
        .prepare(
          `UPDATE pr_watch SET verdict = ?, verdictSha = ? WHERE incidentId = ? AND repo = ? AND number = ?
             AND (verdict IS NOT ? OR verdictSha IS NOT ?)`,
        )
        .run(verdict.recommendation, verdict.sha, row.incidentId, ref.repo, ref.number, verdict.recommendation, verdict.sha)
        .changes;
      // A verdict that was already standing when this started watching is
      // not news, any more than a merge nobody was waiting on is.
      if (changes === 0 || fresh === 1) return null;
      pushDirective(w, row.incidentId, { type: "boss_message", text: verdictDirective(ref, verdict), at: now() });
      return { kind: "verdict", verdict };
    });
  };

  const announce = async (incidentId: string, ref: PrRef, transition: Transition): Promise<void> => {
    const row = db.get<IncidentRow>("SELECT * FROM incident WHERE id = ?", [incidentId]);
    if (!row) return;
    const text =
      transition.kind === "merged"
        ? mergedNotice(ref, transition.pr)
        : transition.kind === "closed"
          ? closedNotice(ref, transition.pr)
          : verdictNotice(ref, transition.verdict);
    const posted = await announcer.notify(rowToIncident(row), text);
    log("pr_transition_announced", { incidentId, pr: ref.label, kind: transition.kind, posted });
  };

  const check = async (rows: WatchRow[], options: { fromAgent: boolean }): Promise<number> => {
    if (!rows.length) return 0;
    const refs = new Map<string, PrRef>();
    for (const row of rows) {
      const ref = parsePr(`${row.repo}#${row.number}`);
      if (ref) refs.set(refKey(ref), ref);
    }
    const seen = await deps.reader.read([...refs.values()]);
    let posted = 0;
    for (const row of rows) {
      const ref = refs.get(refKey(row));
      const pr = ref ? seen.get(refKey(ref)) : undefined;
      if (!ref || !pr) continue;
      const transition = await apply(row, ref, pr, options);
      if (!transition) continue;
      await announce(row.incidentId, ref, transition);
      posted += 1;
    }
    return posted;
  };

  const watchedRows = (where: string, params: unknown[]): WatchRow[] =>
    db.query<WatchRow>(
      `SELECT p.incidentId, p.repo, p.number, p.state, p.verdict, p.verdictSha, p.announcedAt
         FROM pr_watch p JOIN incident i ON i.id = p.incidentId
        WHERE i.status IN (${OPEN_SQL}) AND ${where}`,
      params,
    );

  const sweepOnce = async (): Promise<number> => {
    await record(discover(db));
    // A merged or closed PR is done changing, so it costs nothing to keep.
    return check(watchedRows("(p.state IS NULL OR p.state = 'OPEN')", []), { fromAgent: false });
  };

  const sweep: PrWatcher["sweep"] = async () => {
    if (running) return running;
    if (lastSweepAt !== null && now() - lastSweepAt < intervalMs) return 0;
    lastSweepAt = now();
    running = sweepOnce().finally(() => {
      running = null;
    });
    return running;
  };

  const coversWaitDone: PrWatcher["coversWaitDone"] = async (incidentId, text) => {
    const refs = prRefsIn(text);
    if (!refs.length) return false;
    await record(refs.map((ref) => ({ incidentId, ref })));
    const rows = watchedRows("p.incidentId = ?", [incidentId]).filter((row) =>
      refs.some((ref) => refKey(ref) === refKey(row)),
    );
    await check(rows.filter((row) => row.announcedAt === null), { fromAgent: true });
    return refs.every(
      (ref) =>
        (db.get<{ announcedAt: number | null }>(
          "SELECT announcedAt FROM pr_watch WHERE incidentId = ? AND repo = ? AND number = ?",
          [incidentId, ref.repo, ref.number],
        )?.announcedAt ?? null) !== null,
    );
  };

  return {
    sweep: async () => {
      try {
        return await sweep();
      } catch (error: unknown) {
        // A credential GitHub refuses will refuse every minute until a person
        // changes it; a 5xx or a timeout is weather, and the next minute reads
        // again.
        const status = (error as { status?: number }).status;
        (status === 401 || status === 403 ? alarm : log)("pr_watch_failed", { status, error: String(error) });
        return 0;
      }
    },
    coversWaitDone,
  };
};
