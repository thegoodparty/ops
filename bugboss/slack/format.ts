// Slack does not render Markdown. It renders mrkdwn, which is a different
// language that happens to look like Markdown: `*bold*` not `**bold**`,
// `<url|label>` not `[label](url)`, no headings, no tables, no auto-numbered
// lists. Text written as Markdown does not degrade in Slack, it renders wrong
// — `## Root cause` appears with the hashes, a pipe table is a wall of pipes.
//
// The escaping is the part that bites hardest. Slack reads `<...>` as an
// entity, so one `<` in a quoted log line swallows everything after it and the
// API still returns success. `&`, `<` and `>` have to become `&amp;`, `&lt;`
// and `&gt;` everywhere Slack renders text, code spans and code blocks
// included.
//
// Two kinds of text reach Slack here and they are escaped differently:
//
// - Values. Signal titles, slugs, ids, numbers, anything out of telemetry.
//   They are data, never formatting, so `mrkdwn` escapes every interpolation.
// - Model prose. Root causes, evidence, hand-off briefs, post-mortems, the
//   answers the Slack agent writes. The model is told to write mrkdwn, so
//   `toMrkdwn` keeps the formatting it meant, converts the Markdown it slipped
//   into anyway, and escapes everything else.
//
// Nothing here is used on the way *into* the database. The stored root cause
// and post-mortem are what the agent wrote; conversion happens at the Slack
// boundary, so a later reader — the Slack agent querying `incident` — gets the
// source rather than `&lt;`-riddled markup.

import { makeLog } from "../logging";

const log = makeLog("slack-format");

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * The three characters Slack treats as markup. Ampersand goes first: escaping
 * it after `<` would turn the `&` of `&lt;` into `&amp;lt;`.
 *
 * Deliberately not idempotent. `escape("&amp;")` is `"&amp;amp;"`, because a
 * log line that literally contains `&amp;` has to survive, and "already
 * escaped?" is not a question this can answer. Nothing upstream pre-escapes:
 * the agent prompt tells the model to write the raw characters.
 */
export const escape = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Pre-rendered mrkdwn, exempt from escaping. Explicit, so it is greppable. */
export interface Raw {
  readonly raw: string;
}

export const raw = (markup: string): Raw => ({ raw: markup });

export type Value = string | number | Raw;

const interpolate = (value: Value, index: number): string => {
  if (typeof value === "string") return escape(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`mrkdwn interpolation #${index} is ${String(value)}`);
    }
    return String(value);
  }
  if (typeof value === "object" && value !== null && typeof value.raw === "string") {
    return value.raw;
  }
  // An undefined field interpolated into a template renders the word
  // "undefined" into the incident thread and nothing anywhere says so. The
  // types already forbid it; this is what makes a type hole loud.
  throw new Error(
    `mrkdwn interpolation #${index} is not a string, a finite number or raw()`,
  );
};

/**
 * Template tag for Boss-authored mrkdwn. The literal parts are the formatting
 * and are left alone; every interpolation is escaped unless it is `raw()`.
 */
export const mrkdwn = (
  parts: TemplateStringsArray,
  ...values: Value[]
): string =>
  parts.reduce(
    (out, part, index) =>
      index === 0 ? part : out + interpolate(values[index - 1], index) + part,
    "",
  );

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * What may appear inside `<@…>` and `<#…>`. Slack ids are opaque, so this is
 * not a shape check: it is the set of characters that cannot break out of the
 * entity. `<`, `>`, `&`, `|` and whitespace are what would, and escaping is
 * not an option here — a mention is only a mention as those exact bytes.
 */
const ENTITY_ID = /^[A-Za-z0-9._-]+$/;

/** Throws rather than posting `<@>` or a half-entity that eats the line. */
export const userMention = (userId: string): string => {
  if (!ENTITY_ID.test(userId)) {
    throw new Error(`unusable Slack user id: ${JSON.stringify(userId)}`);
  }
  return `<@${userId}>`;
};

export const channelLink = (channelId: string): string => {
  if (!ENTITY_ID.test(channelId)) {
    throw new Error(`unusable Slack channel id: ${JSON.stringify(channelId)}`);
  }
  return `<#${channelId}>`;
};

/**
 * Anything else inside `<…>` is a Slack directive, not a destination:
 * `<!channel>` pages everyone and `<@U123>` mentions somebody. A url is
 * whatever the caller was handed — an agent's `prUrls`, a link in its prose —
 * so the scheme is checked rather than assumed.
 */
const LINKABLE = /^(?:https?:\/\/|mailto:)/;

/**
 * A link, as `<url|label>`. The label cannot contain a pipe — Slack splits on
 * the first one and there is no escape for it — so pipes in a label become
 * slashes rather than silently truncating the label at the first pipe.
 */
export const link = (url: string, label?: string): string => {
  if (!url.trim()) throw new Error("link() needs a url");
  if (!LINKABLE.test(url.trim())) {
    throw new Error(`not a linkable url: ${JSON.stringify(url)}`);
  }
  const target = escape(url.trim());
  const text = label?.trim();
  return text ? `<${target}|${escape(text).replaceAll("|", "/")}>` : `<${target}>`;
};

/** Slack has no list markup, so a bullet is a literal character we type. */
export const bullets = (items: readonly string[]): string =>
  items.map((item) => `• ${item}`).join("\n");

// ---------------------------------------------------------------------------
// Model prose -> mrkdwn
// ---------------------------------------------------------------------------

/**
 * The spans of model prose that survive untouched.
 *
 * Exported because a second pass runs over finished mrkdwn on the way out --
 * `slack/incidents.ts` -- and it has to protect exactly what this protects.
 * Two copies of this list would drift, and the way that shows up is one pass
 * rewriting the inside of a code block the other one left alone.
 *
 * Code first, so a `**` inside a fenced block stays what the agent typed. Then
 * the two entity forms an agent may legitimately write: a user or channel
 * reference, and a link.
 *
 * Broadcasts — `<!here>`, `<!channel>`, `<!subteam^S…>` — are deliberately
 * absent. Which three events earn a ping is the Boss's decision (`relay.ts`,
 * MENTION_EVENTS), and at twenty incidents a week an agent that can page the
 * rotation for itself is how the rotation gets muted. They fall through to
 * escaping, so they render as literal text rather than disappearing.
 */
export const PROTECTED = new RegExp(
  [
    "(",
    "```[\\s\\S]*?```", // fenced block
    "|```[\\s\\S]*", // an unterminated fence still means "this is code"
    "|`[^`\\n]+`", // inline code
    "|<[@#][A-Z0-9]+(?:\\|[^<>|]*)?>", // user or channel
    "|<(?:https?://|mailto:)[^<>|\\s]+(?:\\|[^<>|]*)?>", // link
    ")",
  ].join(""),
);

const isDivider = (line: string): boolean => {
  const body = line.trim();
  return /^[|\-:\s]+$/.test(body) && body.includes("|") && body.includes("--");
};

const isTableRow = (line: string): boolean => line.trim().startsWith("|");

const convertInline = (text: string): string => {
  // Slack has no headings at any level. A bold line on its own is the
  // substitute, and it is what the agent is told to write.
  let out = text.replace(/^([ \t]*)#{1,6}[ \t]+(.+?)[ \t]*$/gm, "$1*$2*");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
  out = out.replace(/__([^_\n]+)__/g, "*$1*");
  out = out.replace(/~~([^~\n]+)~~/g, "~$1~");
  // The text is already escaped, so this builds the entity directly rather
  // than going through link(), which escapes what it is given.
  out = out.replace(
    /\[([^\]\n]*)\]\(([^)\s]+)\)/g,
    (match: string, label: string, url: string) =>
      // Only a real destination becomes an entity. `[look](!channel)` out of a
      // quoted log line would otherwise be the broadcast this refuses to pass
      // through anywhere else; left alone, it renders as the text it is.
      LINKABLE.test(url)
        ? label.trim()
          ? `<${url}|${label.replaceAll("|", "/")}>`
          : `<${url}>`
        : match,
  );
  return out.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");
};

/**
 * Escape, then convert everything that is not a table.
 *
 * A pipe table is unreadable in Slack and there is no markup that fixes it, so
 * the columns are kept the only way Slack keeps columns: a monospaced block.
 * The `|---|---|` divider goes, since it is Markdown's way of marking a header
 * row and carries nothing once the table is just text.
 *
 * The table is pulled out *before* the conversions rather than fenced after
 * them, because what is inside a fence is code and a reader should see the
 * bytes that were written. Converting first would leave a `**Endpoint**`
 * header cell reading `*Endpoint*` inside the block that was supposed to
 * protect it.
 */
const convertProse = (text: string): string => {
  const lines = escape(text).split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isTableRow(lines[i])) {
      const start = i;
      while (i < lines.length && !isTableRow(lines[i])) i++;
      out.push(convertInline(lines.slice(start, i).join("\n")));
      continue;
    }
    let end = i;
    while (end < lines.length && isTableRow(lines[end])) end++;
    const block = lines.slice(i, end);
    if (block.length >= 2 && block.some(isDivider)) {
      out.push("```", ...block.filter((line) => !isDivider(line)), "```");
    } else {
      out.push(convertInline(block.join("\n")));
    }
    i = end;
  }
  return out.join("\n");
};

/**
 * Render model-authored prose as mrkdwn.
 *
 * The model is instructed to write mrkdwn already (`agent/prompt.ts`), so this
 * is the backstop rather than the mechanism: it converts the Markdown that
 * slips through anyway, and it does the escaping, which the model is told not
 * to attempt by hand.
 */
export const toMrkdwn = (text: string): string =>
  text
    .split(PROTECTED)
    .map((segment, index) =>
      index % 2 === 0
        ? convertProse(segment)
        : // Odd indices are the captured spans. An entity is those exact bytes
          // or it is not an entity; code is escaped like everything else,
          // because Slack renders `&lt;` inside a code block as `<`.
          segment.startsWith("<")
          ? segment
          : escape(segment),
    )
    .join("");

// ---------------------------------------------------------------------------
// Length
// ---------------------------------------------------------------------------

/**
 * Per-message budget. `chat.postMessage` accepts 40,000 characters and
 * truncates past it, which is the failure this avoids: a post-mortem cut mid
 * sentence with a 200 OK. 3,000 is Slack's own per-block ceiling and about as
 * much as anyone reads in one message.
 */
export const MAX_MESSAGE_CHARS = 3000;

/**
 * How much prose one thread post may carry before it is refused.
 *
 * Measured on a real incident thread rather than guessed: the messages this
 * codebase composes ran 7 to 98 words, and the agent's own free text ran 370
 * to 426 -- four times the longest thing anyone had written on purpose, in
 * the place least able to carry it. Around 200 words is the ceiling that
 * still leaves room to say something. Characters because every other bound
 * here is in characters, and 1,200 is about 200 words of English prose.
 *
 * `MAX_MESSAGE_CHARS` is a different kind of number and they are not
 * alternatives: 3,000 is what Slack will accept in one message, so past it
 * text is *split*. This is what a reader will read, so past it text is
 * *refused* -- splitting a 400-word post into two 200-word posts does not
 * make it shorter.
 *
 * **This is the thread's budget and only the thread's.** The closing report
 * is a file and is deliberately exempt: the thread is short, the document is
 * complete. That exemption is `postDocument` below -- a different function
 * rather than a bigger number -- so the one long thing is a call site you
 * can grep for rather than a check somebody forgot.
 */
export const THREAD_PROSE_CHARS = 1200;

/**
 * Why this text is too long for a thread, or null.
 *
 * A sentence rather than a boolean, because every caller is about to hand it
 * to whoever wrote the text, and "too long" on its own has never once been
 * enough for anybody to fix anything. It names the field, both numbers, and
 * where the long version is supposed to go.
 */
export const overThreadBudget = (what: string, text: string): string | null =>
  text.length <= THREAD_PROSE_CHARS
    ? null
    : `${what} is ${text.length} characters and the limit for a thread post is ` +
      `${THREAD_PROSE_CHARS}, about 200 words. Keep the conclusion and what it ` +
      "means for users; the full write-up belongs in the post-mortem, which is " +
      "not capped and which becomes the closing report.";

/**
 * How long an incident's summary may be before it is refused.
 *
 * A title, not a paragraph. Eighty characters is about a dozen words, which
 * is what fits on one line of a status board next to an id and a status and
 * still leaves room for what is needed from a person -- and a board whose
 * rows wrap is a board nobody scans.
 *
 * The same shape as `overThreadBudget` rather than a second idea: past the
 * limit the value is refused with a sentence naming the field, both numbers
 * and where the long version belongs. Nothing here truncates. A title cut at
 * eighty characters reads as a complete thought that happens to be wrong,
 * which is worse than no title at all, and the thing that wrote it is a model
 * that can be asked again.
 */
export const SUMMARY_CHARS = 80;

/**
 * Why this summary is too long, or null. Sibling of `overThreadBudget`.
 */
export const overSummaryBudget = (text: string): string | null =>
  text.length <= SUMMARY_CHARS
    ? null
    : `The summary is ${text.length} characters and the limit is ` +
      `${SUMMARY_CHARS}, about a dozen words. It is a title, not a ` +
      "description: name what is broken and who it is broken for. The " +
      "mechanism belongs in the root cause and the detail in the post-mortem.";

/** Room for the `_(2/3)_` marker, which is added after chunking. */
const CONTINUATION_RESERVE = 16;

/** Room for a fence the split has to close and reopen. */
const FENCE_RESERVE = 8;

/**
 * Where the entities are. By the time a line reaches here every `<` that is
 * not one has been escaped, so this is the whole set.
 */
const entityRanges = (line: string): [number, number][] => {
  const ranges: [number, number][] = [];
  const entity = /<[^<>\n]*>/g;
  let found = entity.exec(line);
  while (found !== null) {
    ranges.push([found.index, found.index + found[0].length]);
    found = entity.exec(line);
  }
  return ranges;
};

/**
 * Break one over-long line. A cut inside `<url|label>` leaves a bare `<` that
 * eats the rest of that message, so the cut moves off an entity even at the
 * cost of a shorter piece.
 */
const hardSplit = (line: string, size: number): string[] => {
  if (line.length <= size) return [line];
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > size) {
    const ranges = entityRanges(rest);
    const straddled = ranges.find(([from, to]) => from < size && size < to);
    let cut = straddled ? straddled[0] : size;
    const space = rest.lastIndexOf(" ", cut - 1);
    if (
      space > size * 0.6 &&
      !ranges.some(([from, to]) => from < space && space < to)
    ) {
      cut = space;
    }
    if (cut <= 0) {
      // One entity longer than a whole message. Cutting it would corrupt the
      // rest of the post, so it goes out over budget and says so rather than
      // being quietly mangled.
      cut = straddled ? straddled[1] : size;
      log("oversized_entity", { chars: cut });
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
};

/**
 * Split one message into as many as it needs, on line boundaries.
 *
 * A post-mortem is long by design and truncation is the one outcome that
 * cannot be recovered from by reading further, so the remainder becomes the
 * next message in the same thread. A code fence open at a split is closed and
 * reopened, otherwise the rest of the post-mortem renders as code.
 */
export const splitForSlack = (
  text: string,
  max: number = MAX_MESSAGE_CHARS,
): string[] => {
  if (!Number.isInteger(max) || max < 200) {
    throw new Error(`splitForSlack needs a budget of 200 or more, got ${max}`);
  }
  if (text.length <= max) return [text];

  const budget = max - CONTINUATION_RESERVE;
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  let openFence = false;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push([...current, ...(openFence ? ["```"] : [])].join("\n"));
    current = [];
    length = 0;
  };

  const push = (line: string) => {
    if (current.length === 0 && openFence) {
      current.push("```");
      length += 4;
    }
    current.push(line);
    length += line.length + 1;
  };

  for (const line of text.split("\n")) {
    for (const piece of hardSplit(line, budget - FENCE_RESERVE)) {
      if (length + piece.length + 1 > budget && current.length > 0) flush();
      push(piece);
      if (piece.trimStart().startsWith("```")) openFence = !openFence;
    }
  }
  if (current.length > 0) chunks.push(current.join("\n"));

  return chunks.map((chunk, index) => `${chunk}\n_(${index + 1}/${chunks.length})_`);
};

/**
 * Convert, split, and post every part into the same thread. The first ts is
 * returned because that is the message the rest hang off.
 *
 * A split is not a failure, but it is a thing that happened to somebody's
 * post-mortem, so it is said out loud rather than inferred from the channel.
 */
/**
 * Post the one text that is exempt from `THREAD_PROSE_CHARS`: the closing
 * report, when it could not be uploaded as a file and the thread is the only
 * place left for it.
 *
 * It does nothing `postProse` does not. It exists so the exemption is a name
 * at a call site instead of the absence of a check -- the thread is short and
 * the document is complete, and this is the one place the document ends up in
 * the thread anyway. A new caller of this is a decision somebody has to
 * defend in review; a new caller of `postProse` is not.
 */
export const postDocument = (
  post: (text: string) => Promise<{ ts: string }>,
  text: string,
  context: Record<string, unknown> = {},
): Promise<{ ts: string }> => postProse(post, text, { ...context, document: true });

export const postProse = async (
  post: (text: string) => Promise<{ ts: string }>,
  text: string,
  context: Record<string, unknown> = {},
): Promise<{ ts: string }> => {
  const parts = splitForSlack(toMrkdwn(text));
  if (parts.length > 1) log("message_split", { ...context, parts: parts.length });
  let first: { ts: string } | null = null;
  for (const part of parts) {
    const posted = await post(part);
    first = first ?? posted;
  }
  if (!first) throw new Error("splitForSlack produced no message to post");
  return first;
};
