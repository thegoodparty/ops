import type Database from "better-sqlite3";
import type { BossInboxItem, BossInboxKind } from "../types";

export const recordForBoss = (
  db: Database.Database,
  item: { incidentId: string; kind: BossInboxKind; text: string },
): number =>
  Number(
    db
      .prepare(
        "INSERT INTO boss_inbox (incidentId, kind, text, createdAt) VALUES (?, ?, ?, ?)",
      )
      .run(item.incidentId, item.kind, item.text, Date.now()).lastInsertRowid,
  );

export const unseenByBoss = (
  db: Database.Database,
  incidentId: string,
): BossInboxItem[] =>
  db
    .prepare(
      `SELECT id, incidentId, kind, text, createdAt, seenAt FROM boss_inbox
        WHERE incidentId = ? AND seenAt IS NULL ORDER BY id`,
    )
    .all(incidentId) as BossInboxItem[];

export const markSeenByBoss = (
  db: Database.Database,
  ids: number[],
): void => {
  const at = Date.now();
  const mark = db.prepare(
    "UPDATE boss_inbox SET seenAt = ? WHERE id = ? AND seenAt IS NULL",
  );
  for (const id of ids) mark.run(at, id);
};
