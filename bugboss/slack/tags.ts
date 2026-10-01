// A message that tags the Boss is always answered. These three calls are how
// that guarantee is watched rather than assumed: the relay records the tag,
// the Boss's answer marks it, and the sweep alarms on one still open past
// TAG_ANSWER_SECONDS. Incident 100's "what's the status here?" went
// unanswered and the only detector was the person who asked.

import type Database from "better-sqlite3";
import type { Db } from "../db";
import { makeAlarm } from "../logging";

const alarm = makeAlarm("slack-tags");

/** Long enough for a Boss run that reads a session and a thread, short enough that nobody is still waiting. */
export const TAG_ANSWER_SECONDS = 300;

/** A settled tag is kept a week, for reading back, then dropped. */
const TAG_KEEP_MS = 7 * 86_400_000;

/** Inside the relay's own write, so a tag is recorded exactly when the message is. */
export const recordTag = (
  d: Database.Database,
  tag: { channel: string; threadTs: string; ts: string },
  now: number,
): void => {
  d.prepare(
    "INSERT OR IGNORE INTO boss_tag (channel, ts, threadTs, taggedAt) VALUES (?, ?, ?, ?)",
  ).run(tag.channel, tag.ts, tag.threadTs, now);
};

/**
 * The Boss answered in this thread having read these messages. Only the
 * messages the run read are marked, so a tag that arrived while it was
 * answering is still owed an answer of its own.
 */
export const answerTags = async (
  db: Db,
  channel: string,
  read: readonly string[],
  now: number,
): Promise<void> => {
  if (read.length === 0) return;
  await db.withWrite((d) => {
    const mark = d.prepare(
      "UPDATE boss_tag SET answeredAt = ? WHERE channel = ? AND ts = ? AND answeredAt IS NULL",
    );
    for (const ts of read) mark.run(now, channel, ts);
  });
};

/**
 * Alarm once for every tag left unanswered too long. The row is marked in the
 * same write that picks it, before anything is said, so a failed write says
 * nothing and the next tick tries again rather than alarming twice.
 */
export const sweepUnansweredTags = async (db: Db, now: number): Promise<number> => {
  const cutoff = now - TAG_ANSWER_SECONDS * 1000;
  const due = await db.withWrite((d) => {
    const rows = d
      .prepare(
        `SELECT channel, threadTs, ts, taggedAt FROM boss_tag
          WHERE answeredAt IS NULL AND alarmedAt IS NULL AND taggedAt <= ?`,
      )
      .all(cutoff) as { channel: string; threadTs: string; ts: string; taggedAt: number }[];
    const mark = d.prepare("UPDATE boss_tag SET alarmedAt = ? WHERE channel = ? AND ts = ?");
    for (const row of rows) mark.run(now, row.channel, row.ts);
    d.prepare("DELETE FROM boss_tag WHERE taggedAt < ? AND (answeredAt IS NOT NULL OR alarmedAt IS NOT NULL)").run(
      now - TAG_KEEP_MS,
    );
    return rows;
  });
  for (const row of due) {
    alarm("tag_unanswered", {
      channel: row.channel,
      thread: row.threadTs,
      ts: row.ts,
      minutes: Math.floor((now - row.taggedAt) / 60_000),
      note: "a message that tagged the Boss has had no answer from it",
    });
  }
  return due.length;
};
