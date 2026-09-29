// How an incident reference reaches a reader: "Incident 4", capitalised, and
// linked to its thread unless that thread is the one being read.
//
// This used to be a line in the Slack agent's system prompt -- "every
// incident you name that is not the one whose thread you are standing in
// gets a link to its thread" -- and a prompt instruction is followed
// probabilistically. Some answers linked, some did not, and the casing
// wandered between "incident 4" and "Incident 4" in the same message. None of
// that is a model failing at anything hard. It is formatting, and formatting
// belongs in code.
//
// This is not the deterministic command matching the rest of this codebase
// refuses. That rule is about reading what a person meant, where a fixed
// phrase is a magic word nobody can guess. This is the opposite direction:
// text we wrote, on the way out, put into one shape. Determinism is the whole
// point of it.
//
// It runs on everything, which is the only way it means anything. There is no
// single place above the Slack client where outbound text is composed -- the
// relay, the Slack agent, the tool API, the merge announcements, the closing
// report and three call sites in the composition root each build their own --
// so the pass is a decorator on the client itself. A surface added later gets
// it by default rather than by somebody remembering.

import { link, PROTECTED } from "./format";
import type { SlackBlock } from "./blocks";
import { makeAlarm } from "../logging";

const alarm = makeAlarm("slack-incidents");

/**
 * An incident reference in our own outbound text.
 *
 * Deliberately narrow. It matches a keyword immediately followed by one
 * number and nothing else -- not "incidents 4 and 5", where the 5 would have
 * to be recognised as an id purely from sitting after a conjunction. A bare
 * number is a count, a duration, a status code and an hour of the day far
 * more often than it is an incident, and a link to the wrong incident sends
 * somebody to the wrong thread at 2am while looking exactly as authoritative
 * as a right one. A reference this misses is still readable prose; one it
 * gets wrong is a lie with a link on it.
 *
 * The plural is matched only so the capitalisation rule has no exception.
 */
const REFERENCE = /\bincidents?[ \t]+#?\d+\b/gi;

/** The same pattern, unanchored and not global, for asking "is there one?".
 * A global regex carries `lastIndex` between `test` calls, and the way that
 * shows up is every second message skipping the pass. */
const HAS_REFERENCE = /\bincidents?[ \t]+#?\d+\b/i;

const ID = /\d+/;

/**
 * "incident 4", "INCIDENT 4" and "Incident 4" all become "Incident 4". The
 * one thing that happens unconditionally.
 *
 * The tail is lower-cased rather than left alone, because a shouted
 * reference is as much a deviation as a lower-case one and "INCIDENT 4" with
 * only its first letter fixed is still not the shape. Nothing after the
 * keyword is a letter, so this cannot touch anything else.
 */
const capitalise = (reference: string): string =>
  `I${reference.slice(1).toLowerCase()}`;

/** Only a url entity carries a label worth normalising. */
const URL_ENTITY = /^<(?:https?:\/\/|mailto:)[^<>|\s]+\|/;

/**
 * Where an incident's thread is, as a permalink, or null when there is no
 * link to give.
 */
export interface IncidentLinks {
  permalink(incidentId: string): Promise<string | null>;
}

/**
 * Normalise every incident reference in one piece of finished mrkdwn, and
 * link the ones that are not `here`.
 *
 * `here` is the incident whose thread this text is being posted into, or null
 * outside one. It still gets capitalised; it does not get a link, because a
 * link to where the reader already is is noise.
 */
export const renderIncidentRefs = async (
  text: string,
  here: string | null,
  links: IncidentLinks,
): Promise<string> => {
  // The segments at even indices are prose; the odd ones are code spans and
  // Slack entities, which are protected. Splitting first is what keeps this
  // out of a quoted log line that happens to mention an incident.
  const segments = text.split(PROTECTED);

  const wanted = new Set<string>();
  let any = false;
  for (const [index, segment] of segments.entries()) {
    const body =
      index % 2 === 0
        ? segment
        : URL_ENTITY.test(segment)
          ? segment.slice(segment.indexOf("|") + 1)
          : "";
    if (!HAS_REFERENCE.test(body)) continue;
    any = true;
    // Only prose earns a link. A reference already inside a link is
    // capitalised and left where it is.
    if (index % 2 !== 0) continue;
    for (const found of body.matchAll(REFERENCE)) {
      const id = ID.exec(found[0])![0];
      if (id !== here) wanted.add(id);
    }
  }
  // The overwhelmingly common case: no reference at all, one split and one
  // scan, no lookups and no rebuild. Checked on `any` rather than on
  // `wanted`, because a reference to the incident we are standing in wants
  // no link and still wants capitalising.
  if (!any) return text;

  // Sequential, not `Promise.all`, for the reason the query tool used to
  // give: `createCachingLinker` learns the workspace domain from its first
  // real answer and derives every later link from it as string work, so a
  // message naming ten incidents is one API call when they are asked in
  // order and ten when they are fired together.
  const resolved = new Map<string, string>();
  for (const id of wanted) {
    try {
      const url = await links.permalink(id);
      if (url) resolved.set(id, url);
    } catch (err) {
      // A link is a convenience and this text is somebody's answer. Losing
      // the link loses a convenience; failing the post loses the answer.
      //
      // And the rest of this message stops asking: ten incidents against a
      // Slack that is refusing is ten consecutive ten-second deadlines, paid
      // by whoever is waiting on the post. The next message tries again.
      alarm("incident_link_failed", { incidentId: id, error: String(err) });
      break;
    }
  }

  const rendered = segments.map((segment, index) => {
    if (index % 2 === 1) {
      // A label we wrote earlier -- "incident 82's thread" -- is still a
      // reference a reader sees, so the capitalisation rule reaches inside
      // it. Nothing else does: it is already a link, and the url half is
      // never touched.
      if (!URL_ENTITY.test(segment)) return segment;
      const split = segment.indexOf("|");
      return (
        segment.slice(0, split + 1) +
        segment.slice(split + 1).replace(REFERENCE, capitalise)
      );
    }
    return segment.replace(REFERENCE, (reference) => {
      const label = capitalise(reference);
      const url = resolved.get(ID.exec(reference)![0]);
      return url ? link(url, label) : label;
    });
  });

  return rendered.join("");
};

/**
 * The incident an id or a thread belongs to, and where its thread is. Two
 * reads against the incident table, behind an interface so the pass can be
 * tested without one.
 */
export interface IncidentThreads {
  /** The incident whose thread this is, or null. */
  incidentForThread(threadTs: string): string | null;
  /** That incident's thread ts, or null if it has none. */
  threadOf(incidentId: string): string | null;
}

export interface IncidentReferences {
  render(text: string, threadTs: string | null): Promise<string>;
}

/**
 * The production pass, with both lookups memoised for the life of the
 * process.
 *
 * Memoising is not an optimisation here, it is the thing that keeps
 * `permalink_shape_unknown` from mattering. That alarm fires when the
 * workspace origin cannot be parsed out of a permalink, after which every
 * link in `createCachingLinker` costs a round trip instead of string work --
 * and this pass asks for a link every time an answer names an incident,
 * which is the one change that could turn a quiet tenfold into a loud one.
 * Memoised per incident, a workspace we cannot parse costs one call per
 * incident for the life of the container and nothing after that.
 *
 * Only answers are held. A resolved permalink is safe forever -- an
 * incident's thread is written once, under `WHERE slackThreadTs IS NULL`, so
 * it never moves, and a Slack permalink to a message does not change either.
 * A *missing* answer is the opposite: the relay posts the rest of a split
 * opening message into a thread before it records that thread on the
 * incident, so "this thread belongs to no incident" is true for a moment and
 * false forever after. Caching that moment would leave every later message
 * in the thread linking the incident to itself.
 */
export const createIncidentReferences = (deps: {
  threads: IncidentThreads;
  permalink(messageTs: string): Promise<string>;
}): IncidentReferences => {
  const linkOf = new Map<string, string>();
  const idOf = new Map<string, string>();

  const links: IncidentLinks = {
    permalink: async (incidentId) => {
      const held = linkOf.get(incidentId);
      if (held !== undefined) return held;
      const ts = deps.threads.threadOf(incidentId);
      // Not a failure, and not cached. An incident whose thread has not
      // opened yet, and an id that names nothing at all, both land here and
      // both read as plain text -- which is the honest rendering of "there
      // is nowhere to send you". It is one indexed read to ask again.
      if (!ts) return null;
      const url = await deps.permalink(ts);
      linkOf.set(incidentId, url);
      return url;
    },
  };

  return {
    render: async (text, threadTs) => {
      let here: string | null = null;
      if (threadTs !== null) {
        here = idOf.get(threadTs) ?? deps.threads.incidentForThread(threadTs);
        if (here !== null) idOf.set(threadTs, here);
      }
      try {
        return await renderIncidentRefs(text, here, links);
      } catch (err) {
        // Nothing in the pass should throw, and if it does the text still has
        // to go out: this sits in front of every message BugBoss posts, so a
        // defect here would otherwise silence the whole system.
        alarm("incident_refs_failed", { error: String(err) });
        return text;
      }
    },
  };
};

/** The write half of Slack the pass wraps. */
export interface ReferencePoster {
  post(
    threadTs: string | null,
    text: string,
    channel?: string,
  ): Promise<{ ts: string }>;
  postChoice(
    threadTs: string | null,
    text: string,
    blocks: readonly SlackBlock[],
  ): Promise<{ ts: string }>;
  update(channel: string, ts: string, text: string): Promise<void>;
}

/**
 * Every outbound message, through the pass, on the way to Slack.
 *
 * A decorator on the client rather than a call in each composer, for the
 * reason at the top of this file: there are eight places that compose text
 * and no two of them share a path. A pass that sat on some of them would
 * produce the same inconsistency with a new cause, which is worse than the
 * old one because it looks fixed.
 *
 * `update` carries the thread's own id, so its references resolve against the
 * incident whose header it is rewriting.
 */
export const withIncidentReferences = <T extends ReferencePoster>(
  slack: T,
  refs: IncidentReferences,
): T => ({
  ...slack,
  post: async (threadTs, text, channel) =>
    slack.post(threadTs, await refs.render(text, threadTs), channel),
  postChoice: async (threadTs, text, blocks) =>
    slack.postChoice(threadTs, await refs.render(text, threadTs), blocks),
  // A header update names its own incident and nothing else, so `ts` is both
  // the message being rewritten and the thread it heads.
  update: async (channel, ts, text) =>
    slack.update(channel, ts, await refs.render(text, ts)),
});
