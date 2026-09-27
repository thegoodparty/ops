// The one message BugBoss builds with Block Kit: a question the agent asks
// with its likely answers beside it as buttons. Everything else it posts is
// plain mrkdwn (`format.ts`), which is still the right default.
//
// Buttons are an affordance, never a command language. The same question is
// always answerable as prose: the options are numbered in the message body,
// the notification fallback carries them, and a typed reply reaches the agent
// down the path it always did. So a workspace where interactivity is still
// off, a client that cannot render blocks, and an answer nobody anticipated
// all keep working, and the agent must never write a question that only makes
// sense if somebody presses something.
//
// A message with `blocks` and no `text` shows "This content can't be
// displayed" in every notification, so the fallback is not optional here.

import { escape, MAX_MESSAGE_CHARS, splitForSlack, toMrkdwn } from "./format";

/** Marks the actions block as ours. Nothing else in this app posts buttons. */
export const CHOICE_BLOCK_ID = "bugboss_choice";

/**
 * Every choice button's `action_id` starts with this, and the click handler
 * keys off the prefix rather than an exact id. An interaction that does not
 * carry one is somebody else's app sharing the request URL, not ours.
 */
export const CHOICE_ACTION_PREFIX = "bugboss_choice_";

/**
 * Five is a thread on a phone, not a form. Slack's own limit is 25 elements
 * in an actions block, which is far past the point where reading them all is
 * slower than typing the answer.
 */
export const MAX_CHOICE_OPTIONS = 5;

/** Slack's cap on a button label. Past it, chat.postMessage rejects the post. */
export const MAX_CHOICE_LABEL_CHARS = 75;

export interface SlackTextObject {
  type: "mrkdwn" | "plain_text";
  text: string;
  emoji?: boolean;
}

export interface SlackButton {
  type: "button";
  action_id: string;
  text: { type: "plain_text"; text: string; emoji: true };
  value: string;
}

export type SlackBlock =
  | { type: "section"; text: SlackTextObject }
  | { type: "actions"; block_id: string; elements: SlackButton[] }
  | { type: "context"; elements: SlackTextObject[] };

/**
 * The buttons half of a Slack client, kept apart from `SlackPoster` so that a
 * fake for the relay or the Slack agent — neither of which ever posts a
 * question — stays two lines.
 */
export interface ChoicePoster {
  postChoice(
    threadTs: string | null,
    text: string,
    blocks: readonly SlackBlock[],
  ): Promise<{ ts: string }>;
}

/** One press, as it comes back down the request URL. */
export interface SlackChoiceClick {
  channel: string;
  /** Who pressed it. Anyone in the channel may. */
  user: string;
  /** The question message the buttons are attached to. */
  messageTs: string;
  /** The incident thread that message lives in. */
  threadTs: string;
  /** The label the agent wrote, echoed back by Slack. This is the answer. */
  choice: string;
  /** Slack's own timestamp for the press, used as the answer's ts. */
  actionTs: string;
}

/**
 * Why these options cannot be rendered, or null. Read at the tool, so the
 * model gets something it can correct, and again at the loopback boundary,
 * which is the side that does not trust the child.
 *
 * Duplicate labels are refused because the label *is* the answer: two buttons
 * reading "Roll back" leave the agent unable to say which was pressed.
 */
export const choiceProblem = (options: readonly string[]): string | null => {
  if (options.length < 2) return "options needs at least two answers";
  if (options.length > MAX_CHOICE_OPTIONS) {
    return `options takes at most ${MAX_CHOICE_OPTIONS} answers, got ${options.length}`;
  }
  const labels = options.map((label) => label.trim());
  if (labels.some((label) => !label)) return "an option label is empty";
  const tooLong = labels.find((label) => label.length > MAX_CHOICE_LABEL_CHARS);
  if (tooLong) {
    return `option ${JSON.stringify(tooLong)} is longer than ${MAX_CHOICE_LABEL_CHARS} characters`;
  }
  const distinct = new Set(labels.map((label) => label.toLowerCase()));
  if (distinct.size !== labels.length) return "two options have the same label";
  return null;
};

/** The bail-out, said in the message rather than assumed. */
const HINT = "Press one, or just reply in this thread to say anything else.";

export interface ChoiceQuestion {
  /**
   * The front of a question too long for one message, posted as plain text
   * ahead of the buttons. Empty for any question of a sane length, which is
   * all of them: a section block and a Slack message share the same 3,000
   * character ceiling.
   */
  lead: string[];
  /** The notification fallback, and what a client without blocks shows. */
  text: string;
  blocks: SlackBlock[];
}

export const renderChoiceQuestion = (
  message: string,
  options: readonly string[],
): ChoiceQuestion => {
  const problem = choiceProblem(options);
  if (problem) throw new Error(`cannot render a choice: ${problem}`);

  const parts = splitForSlack(toMrkdwn(message), MAX_MESSAGE_CHARS);
  // The buttons hang off the last part, because that is the one that ends in
  // the question. A reader scrolling to the buttons has just read it.
  const body = parts[parts.length - 1];
  const labels = options.map((label) => label.trim());
  const listed = labels
    .map((label, index) => `${index + 1}. ${escape(label)}`)
    .join("\n");

  return {
    lead: parts.slice(0, -1),
    text: [body, "", listed, `_${HINT}_`].join("\n"),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: body } },
      {
        type: "actions",
        block_id: CHOICE_BLOCK_ID,
        elements: labels.map((label, index) => ({
          type: "button" as const,
          action_id: `${CHOICE_ACTION_PREFIX}${index}`,
          text: { type: "plain_text" as const, text: escape(label), emoji: true },
          // Unescaped on purpose: `value` is never rendered, it comes back on
          // the click and is recorded as the answer. The agent has to read
          // back the label it wrote, not an `&amp;`-riddled copy of it.
          value: label,
        })),
      },
      { type: "context", elements: [{ type: "mrkdwn", text: `_${HINT}_` }] },
    ],
  };
};
