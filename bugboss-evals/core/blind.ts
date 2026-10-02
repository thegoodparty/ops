/**
 * Removes what would tell the judge which variant produced a run, or how
 * efficiently. A system's closing post may print the run's tokens, turns and
 * an estimated cost, and a summary line may say how long the incident took;
 * left in, any of those tells the judge which side was cheaper or faster, and
 * the quality verdict stops being independent of the cost measure.
 *
 * Two kinds of text, two treatments. Prose (anything said in Slack or
 * uploaded to the thread) loses whole lines and whole sections that talk
 * about the run itself. A diff loses nothing but identifiers, because
 * dropping a line of code changes what the judge thinks the fix was.
 *
 * Nothing here cuts by length. A line is removed for what it says, never for
 * how long it is.
 */

export type TextKind = "prose" | "diff";

export interface BlindOptions {
  /**
   * Literal strings that name a variant or a run: git refs, image tags, run
   * ids, branch names. Replaced wherever they appear, longest first so a ref
   * that contains another is not half-replaced.
   */
  identifying?: string[];
}

export interface Blinded {
  text: string;
  /** Lines removed from prose because they described the run. */
  droppedLines: number;
}

/** A section about the run, dropped with everything under it. */
const RUN_SECTION = /^(#{1,6})\s*(agent run|run|cost|costs|spend|usage|run stats?|tokens?)\s*$/i;

/**
 * A prose line that states the run's own cost, size or duration. Matched on
 * the line so the whole statement goes, not a number out of the middle of a
 * sentence that would then read as a different claim.
 */
// Narrow on purpose. "The query took 18 s" and "the 20 s pool timeout" are
// evidence about the system and must reach the judge; only statements about
// the run doing the work are removed.
const RUN_LINE: RegExp[] = [
  /\$\s?\d[\d,]*\.\d\d\b/,
  /\b(cost|spend|spent|usd|dollars?|price[ds]?|bill(ed)?)\b.*\$\s?\d/i,
  /\$\s?\d.*\b(cost|spend|spent|usd|dollars?|bill(ed)?)\b/i,
  /\bestimated cost\b/i,
  /\(est\.\s/i,
  /\b\d[\d,.]*\s*[kKmM]?\s+tokens\b/,
  /\b(input|output|total|cached?)\s+tokens?\b/i,
  /\b\d[\d,]*\s+turns?\b/i,
  /\bturns?\b\s*[:|]\s*\d/i,
  /\bcache (read|write)\b/i,
  /\b\d+\s+agent launch(es)?\b/i,
  /^\|\s*(launches|model)\s*\|/i,
  /\btime to (detect|resolve|mitigate|merge|fix|close)\b/i,
  /\b(resolved|detected|mitigated|closed|finished|completed) in \d/i,
  /\b(incident|investigation|run|agent|resolution)\b.{0,40}\b(took|lasted|elapsed)\b.*\d/i,
  /\bwall[- ]?clock\b.*\d/i,
];

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SUBSTITUTIONS: Array<[RegExp, string]> = [
  // ISO timestamps before dates and times, so one is not split into two.
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, "<time>"],
  [/\b\d{4}-\d{2}-\d{2}\b/g, "<date>"],
  [/\b\d{1,2}:\d{2}(:\d{2})?\s*(UTC|GMT|Z|[AP]M|[ECMP][SD]T)\b/gi, "<time>"],
  // Slack ts, then epoch millis, then epoch seconds.
  [/\b1[6-9]\d{8}\.\d{6}\b/g, "<time>"],
  [/\b1[6-9]\d{11}\b/g, "<time>"],
  [/\b1[6-9]\d{8}\b/g, "<time>"],
  [/\b(us\.|global\.|eu\.)?anthropic\.[\w.:-]+/g, "<model>"],
  [/\bclaude-[a-z0-9][\w.-]*/gi, "<model>"],
  [/\brefs\/heads\/[\w./-]+/g, "<branch>"],
  // Branch names, by the shapes agents and people give them: `<owner>/<kind>-…`
  // or `<kind>/<name>`. File paths and URLs are left alone, because a path
  // in a message or a diff header is evidence the judge needs.
  [/(?<![\w./-])[a-z][\w-]*\/(?:incident|fix|feat|feature|eval|hotfix|bug|chore|refactor)(?![a-z])[\w./-]*/gi, "<branch>"],
  [/(?<![\w./-])(?:incident|fix|feat|feature|eval|hotfix|bug|chore|refactor)\/[\w][\w./-]*/gi, "<branch>"],
  [/\/pull\/\d+/g, "/pull/<n>"],
  [/\bPR\s+#?\d+\b/g, "PR <n>"],
  [/(^|[^\w&])#\d+\b/g, "$1#<n>"],
  [/\bpull request\s+#?\d+\b/gi, "pull request <n>"],
  // A hex run with at least one digit and one letter: a SHA, not a word.
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, "<sha>"],
];

const substitute = (text: string, identifying: string[]): string => {
  let out = text;
  const literals = [...new Set(identifying.filter((s) => s.trim() !== ""))].sort(
    (a, b) => b.length - a.length,
  );
  for (const literal of literals) {
    out = out.replace(new RegExp(escapeRegExp(literal), "g"), "<redacted>");
  }
  for (const [pattern, replacement] of SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
};

const dropRunProse = (text: string): { text: string; dropped: number } => {
  const kept: string[] = [];
  let dropped = 0;
  let skippingLevel: number | null = null;
  for (const line of text.split("\n")) {
    // A timeline quotes every message line, so headings arrive as `> ## Cost`.
    const bare = line.replace(/^(?:>\s?)+/, "");
    const heading = /^(#{1,6})\s/.exec(bare);
    if (skippingLevel !== null) {
      if (heading && heading[1].length <= skippingLevel) {
        skippingLevel = null;
      } else {
        if (bare.trim() !== "") dropped += 1;
        continue;
      }
    }
    const section = RUN_SECTION.exec(bare);
    if (section) {
      skippingLevel = section[1].length;
      dropped += 1;
      continue;
    }
    if (RUN_LINE.some((pattern) => pattern.test(bare))) {
      dropped += 1;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), dropped };
};

export const blind = (text: string, kind: TextKind, options: BlindOptions = {}): Blinded => {
  const identifying = options.identifying ?? [];
  if (kind === "diff") {
    return { text: substitute(text, identifying), droppedLines: 0 };
  }
  // Drop before substituting: the patterns read the numbers that substitution
  // would otherwise have already turned into placeholders.
  const { text: kept, dropped } = dropRunProse(text);
  return { text: substitute(kept, identifying), droppedLines: dropped };
};

/** What one side of a pair looks like to the judge, before or after blinding. */
export interface SideOutput {
  /** The rendered activity timeline (core/activity.ts): every Slack message, GitHub event, the check and the close. */
  timeline: string;
  /** From the scenario's base commit to the merge commit, or to the first pull request's head when nothing merged. Null when no pull request was opened. */
  diff: string | null;
}

export const blindSide = (
  side: SideOutput,
  options: BlindOptions = {},
): { output: SideOutput; droppedLines: number } => {
  const timeline = blind(side.timeline, "prose", options);
  return {
    output: {
      timeline: timeline.text,
      diff: side.diff === null ? null : blind(side.diff, "diff", options).text,
    },
    droppedLines: timeline.droppedLines,
  };
};
