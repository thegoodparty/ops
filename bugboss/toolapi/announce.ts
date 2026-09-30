// What the two threads say when incidents combine.
//
// Lifted out of the tool API because there are now two ways a merge happens
// and only one of them runs inside an agent's call. Correlation merges on a
// root cause; a person merges by saying so in a thread, which the composition
// root applies with no agent involved. Both have to leave the same two
// messages behind -- a merge that reads one way when the Boss did it and
// another way when a person did is a thread nobody can follow back.

import type { Db } from "../db";
import type { Incident } from "../types";
import type { AssignResult, IncidentRow } from "./assign";
import { rowToIncident } from "./assign";
import { escape, link, mrkdwn, raw, splitForSlack, toMrkdwn } from "../slack/format";
import { makeAlarm } from "../logging";

const alarm = makeAlarm("toolapi");

/**
 * The line every close posts, whoever closed it. A close reads one way in the
 * thread whether an agent wrote the post-mortem or the Boss ended it.
 */
export const closedNotice = (incidentId: string, detail: string): string =>
  `${mrkdwn`*Incident ${incidentId} closed*`}\n${detail}`;

export const agentClosedDetail = (usersImpacted: number | null): string =>
  mrkdwn`_${usersImpacted ?? "Unknown"} users impacted · post-mortem written._`;

export const bossClosedDetail = (reason: string): string =>
  `_Closed by BugBoss:_ ${toMrkdwn(reason)}`;

/** The write half of Slack a merge announcement needs. */
export interface AnnouncePoster {
  post(threadTs: string | null, text: string): Promise<{ ts: string }>;
  /**
   * A link to one message, which is the only way a thread can point at
   * another one. Slack builds it from the workspace domain, so it is an API
   * call and not string concatenation.
   */
  permalink(messageTs: string): Promise<string>;
}

export interface Announcer {
  notify(incident: Incident, text: string): Promise<boolean>;
  threadRef(incident: Incident | undefined, label: string): Promise<string>;
  announceMerge(result: AssignResult): Promise<void>;
}

export const createAnnouncer = (deps: {
  db: Db;
  slack: AnnouncePoster;
}): Announcer => {
  const { db, slack } = deps;

  const readIncident = (id: string): Incident | undefined => {
    const row = db.get<IncidentRow>("SELECT * FROM incident WHERE id = ?", [id]);
    return row ? rowToIncident(row) : undefined;
  };

  /**
   * Everything the Boss says in an incident thread goes through here, so this
   * is where mrkdwn and the length ceiling are enforced. An escalation brief or a
   * root cause is model prose that can run past what one message holds, and
   * chat.postMessage truncates rather than refusing, so it is split into
   * consecutive messages instead of being cut mid sentence.
   */
  const notify = async (incident: Incident, text: string): Promise<boolean> => {
    // The thread is looked up here rather than taken from the row the caller
    // is holding. Every transition reads its incident before it writes, and a
    // thread can be opened in between -- openThreads does exactly that during
    // a split. A stale null posts at the top of the channel, where nothing
    // groups it with the incident and Slack still answers ok.
    const threadTs =
      db.get<{ slackThreadTs: string | null }>(
        "SELECT slackThreadTs FROM incident WHERE id = ?",
        [incident.id],
      )?.slackThreadTs ?? incident.slackThreadTs;
    try {
      for (const part of splitForSlack(text)) {
        await slack.post(threadTs, part);
      }
      return true;
    } catch (err) {
      alarm("thread_post_failed", {
        incidentId: incident.id,
        error: String(err),
      });
      return false;
    }
  };

  /**
   * A reference to another incident's thread, as mrkdwn. Both branches are
   * escaped already, so interpolate it with raw().
   *
   * Losing the link is not losing the message: a thread nobody can find is
   * what this is here to fix, so a permalink that fails says so and the
   * sentence still reads.
   */
  const threadRef = async (
    incident: Incident | undefined,
    label: string,
  ): Promise<string> => {
    if (!incident?.slackThreadTs) return escape(label);
    try {
      return link(await slack.permalink(incident.slackThreadTs), label);
    } catch (err) {
      alarm("permalink_failed", { incidentId: incident.id, error: String(err) });
      return escape(label);
    }
  };

  /**
   * Both sides of a merge, written for somebody who has never used this
   * system and is reading one of these threads at 2am.
   *
   * The absorbed incident's thread is the half that cannot be skipped. After
   * this it is never written to again, and a thread that simply goes quiet
   * forever is indistinguishable from the Boss having died -- which is what
   * the reader is left to guess when the only message goes to the other
   * thread.
   *
   * The merge is already committed and durable by the time this runs, so a
   * post that fails alarms inside notify and the rest still goes out. A
   * notification is not worth rolling a re-partition back for.
   */
  const announceMerge = async (result: AssignResult): Promise<void> => {
    const into = readIncident(result.target);
    if (!into) {
      alarm("merge_target_gone", {
        target: result.target,
        merged: result.merged,
      });
      return;
    }

    for (const absorbedId of result.merged) {
      const absorbed = readIncident(absorbedId);
      const why = toMrkdwn(result.reason);
      // Both links before either post. Each falls back on its own, and
      // resolving them up front is what lets the order below be the only
      // thing deciding which message survives a Slack failure.
      const absorbedRef = await threadRef(
        absorbed,
        `incident ${absorbedId}'s thread`,
      );
      const intoRef = await threadRef(
        into,
        `incident ${result.target}'s thread`,
      );

      // The absorbed thread goes first. It is the one that is never written
      // to again, so if only one of these two lands it has to be that one:
      // the alternative is a surviving thread announcing that a thread is
      // closing while that thread says nothing and simply stops.
      if (absorbed?.slackThreadTs) {
        await notify(
          absorbed,
          [
            mrkdwn`*This incident is the same problem as incident ${result.target}, so the two have been merged*`,
            why,
            mrkdwn`_This is the last message in this thread · everything from here, including the fix and the post-mortem, is in ${raw(intoRef)}._`,
          ].join("\n"),
        );
      } else {
        // Nobody is left reading a thread that was never opened, so this is
        // not a lost message so much as evidence of one that was: an
        // incident reached a merge without the thread every incident gets.
        alarm("absorbed_thread_missing", {
          incidentId: absorbedId,
          into: result.target,
        });
      }

      await notify(
        into,
        [
          mrkdwn`*Incident ${absorbedId} is the same problem as this one, so the two have been merged*`,
          why,
          mrkdwn`_Nothing further will be posted in ${raw(absorbedRef)} · updates for both incidents arrive here from now on._`,
        ].join("\n"),
      );
    }
  };

  return { notify, threadRef, announceMerge };
};
