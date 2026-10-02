import { z } from "zod";

/**
 * Everything the world saw of one run, in order: the alert, every Slack
 * message in both directions, every GitHub event, the deploy check and the
 * close. This is what the judge compares. It carries no transcript, tool
 * call, turn count or incident row, so a run by one agent, a swarm or a
 * state machine renders the same way.
 */

const Event = z.discriminatedUnion("kind", [
  z.object({ at: z.number(), kind: z.literal("alert_fired"), refire: z.boolean() }).strict(),
  z.object({ at: z.number(), kind: z.literal("slack_post"), ts: z.string(), threadTs: z.string().nullable(), text: z.string() }).strict(),
  z.object({ at: z.number(), kind: z.literal("slack_update"), ts: z.string(), text: z.string() }).strict(),
  z.object({ at: z.number(), kind: z.literal("slack_human"), ts: z.string(), threadTs: z.string().nullable(), text: z.string() }).strict(),
  z.object({ at: z.number(), kind: z.literal("slack_file"), ts: z.string(), name: z.string(), text: z.string() }).strict(),
  z.object({ at: z.number(), kind: z.literal("pr_opened"), number: z.number().int(), title: z.string(), files: z.array(z.string()) }).strict(),
  z.object({ at: z.number(), kind: z.literal("pr_head_pushed"), number: z.number().int(), files: z.array(z.string()) }).strict(),
  z.object({ at: z.number(), kind: z.literal("ci_run"), number: z.number().int(), conclusion: z.enum(["success", "failure"]) }).strict(),
  z.object({ at: z.number(), kind: z.literal("review"), number: z.number().int(), state: z.string(), body: z.string() }).strict(),
  z.object({ at: z.number(), kind: z.literal("merge_refused"), number: z.number().int(), reason: z.string() }).strict(),
  z.object({ at: z.number(), kind: z.literal("merged"), number: z.number().int() }).strict(),
  z.object({ at: z.number(), kind: z.literal("check_result"), passed: z.boolean() }).strict(),
  z.object({ at: z.number(), kind: z.literal("closed") }).strict(),
]);

export type ActivityEvent = z.infer<typeof Event>;

export interface Activity {
  /** Epoch ms of the first alert delivery; every rendered time is relative to it. */
  alertAt: number;
  events: ActivityEvent[];
}

export const ActivitySchema: z.ZodType<Activity> = z
  .object({ alertAt: z.number(), events: z.array(Event) })
  .strict();

const two = (n: number) => String(n).padStart(2, "0");

/** `+MM:SS` under an hour, `+H:MM:SS` from then on. Negative for anything before the alert. */
export const relative = (at: number, alertAt: number): string => {
  const total = Math.round(Math.abs(at - alertAt) / 1000);
  const sign = at < alertAt ? "-" : "+";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${sign}${h}:${two(m)}:${two(s)}` : `${sign}${two(m)}:${two(s)}`;
};

/** Every line quoted, so a message that contains headings or fences cannot break out of its block. */
const quoted = (text: string): string[] =>
  text.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));

const list = (items: string[]) => (items.length ? items.join(", ") : "none");

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const describe = (event: ActivityEvent): { head: string; body: string | null } => {
  switch (event.kind) {
    case "alert_fired":
      return { head: event.refire ? "Alert fired again" : "Alert fired", body: null };
    case "slack_post":
      return {
        head: event.threadTs === null ? "System posted a new Slack message (the incident thread)" : "System posted in the thread",
        body: event.text,
      };
    case "slack_update":
      return { head: "System edited an earlier Slack message; it now reads", body: event.text };
    case "slack_human":
      return { head: event.threadTs === null ? "Human posted a new Slack message" : "Human replied in the thread", body: event.text };
    case "slack_file":
      return { head: `System uploaded a file to the thread: ${event.name}`, body: event.text };
    case "pr_opened":
      return { head: `Pull request #${event.number} opened: ${event.title}. Files: ${list(event.files)}`, body: null };
    case "pr_head_pushed":
      return { head: `Pull request #${event.number} updated. Files now: ${list(event.files)}`, body: null };
    case "ci_run":
      return { head: `CI on pull request #${event.number}: ${event.conclusion}`, body: null };
    case "review":
      return { head: `Review on pull request #${event.number}: ${event.state}`, body: event.body.trim() === "" ? null : event.body };
    case "merge_refused":
      return { head: `Merge of pull request #${event.number} refused: ${event.reason}`, body: null };
    case "merged":
      return { head: `Pull request #${event.number} merged and deployed`, body: null };
    case "check_result":
      return {
        head: event.passed ? "Deployed fix verified: the fault is gone" : "Deployed fix verified: the fault is still present",
        body: null,
      };
    case "closed":
      return { head: "Incident closed", body: null };
  }
};

/**
 * Markdown, one entry per event in time order, each with its offset from the
 * alert. Message and file text is rendered whole; nothing here cuts by length.
 * `blind` is applied to every piece of text, header and body alike.
 */
export const renderTimeline = (activity: Activity, blind: (s: string) => string): string => {
  const events = [...activity.events].sort((a, b) => a.at - b.at);
  const lines: string[] = [
    `Timeline of ${plural(events.length, "event")}, times relative to the alert.`,
    "",
  ];
  for (const event of events) {
    const { head, body } = describe(event);
    lines.push(`**${relative(event.at, activity.alertAt)}** ${blind(head)}`);
    if (body !== null) {
      lines.push("", ...quoted(blind(body)));
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
};
