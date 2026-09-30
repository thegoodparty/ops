// What the on-call person can do: write in Slack, and read, review and merge
// pull requests. Nothing here lets the persona reach BugBoss other than by
// writing in a thread, which is the only way a real person reaches it.

import type { SlackSnapshot } from "../standins/slack/state";
import type { PersonaGitHub } from "./github";
import type { ToolSpec } from "./model";

export const createSlackControl = (args: { controlUrl: string; token?: string }) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (args.token) headers.authorization = `Bearer ${args.token}`;
  const base = args.controlUrl.replace(/\/$/, "");
  return {
    state: async (): Promise<SlackSnapshot> => {
      const res = await fetch(`${base}/__control/state`, { headers });
      if (!res.ok) throw new Error(`slack state: ${res.status}`);
      return (await res.json()) as SlackSnapshot;
    },
    post: async (input: {
      user: string;
      channel: string;
      threadTs: string | null;
      text: string;
    }): Promise<{ ok: boolean; ts?: string; error?: string }> => {
      const res = await fetch(`${base}/__control/human-message`, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      });
      return (await res.json()) as { ok: boolean; ts?: string; error?: string };
    },
  };
};

export type SlackControl = ReturnType<typeof createSlackControl>;

export const PERSONA_TOOLS: ToolSpec[] = [
  {
    name: "reply_in_thread",
    description:
      "Write a message in a Slack thread, as yourself. This is how you talk to BugBoss about an incident: plain words, as to a colleague.",
    inputSchema: {
      type: "object",
      properties: {
        thread_ts: { type: "string", description: "The thread's ts, as shown in the channel view." },
        text: { type: "string" },
      },
      required: ["thread_ts", "text"],
    },
  },
  {
    name: "post_in_channel",
    description: "Write a new top-level message in the incident channel.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "list_pull_requests",
    description: "List the open pull requests on the repository.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "view_pull_request",
    description:
      "Read one pull request: its description, head commit, CI checks and reviews.",
    inputSchema: {
      type: "object",
      properties: { number: { type: "integer" } },
      required: ["number"],
    },
  },
  {
    name: "view_pull_request_diff",
    description: "Read the full diff of one pull request.",
    inputSchema: {
      type: "object",
      properties: { number: { type: "integer" } },
      required: ["number"],
    },
  },
  {
    name: "review_pull_request",
    description:
      "Submit your review of a pull request: approve it, request changes, or just comment. Say why in the body.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "integer" },
        verdict: { type: "string", enum: ["approve", "request_changes", "comment"] },
        body: { type: "string" },
      },
      required: ["number", "verdict", "body"],
    },
  },
  {
    name: "comment_on_pull_request",
    description: "Leave a comment on a pull request's conversation.",
    inputSchema: {
      type: "object",
      properties: { number: { type: "integer" }, body: { type: "string" } },
      required: ["number", "body"],
    },
  },
  {
    name: "merge_pull_request",
    description:
      "Merge a pull request. It needs green CI and an approving review from you on its latest commit. You get to it after your other work; you will hear whether it went through.",
    inputSchema: {
      type: "object",
      properties: { number: { type: "integer" } },
      required: ["number"],
    },
  },
];

export interface ToolContext {
  slack: SlackControl;
  github: PersonaGitHub;
  channel: string;
  userId: string;
  /** Queue a merge; it runs after the scenario's merge delay. */
  scheduleMerge: (n: number) => string;
  log: (action: string) => void;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

const asNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null;

const asText = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

const failed = (what: string, status: number, text: string): ToolOutcome => ({
  content: `${what} failed: HTTP ${status}\n${text}`,
  isError: true,
});

export const runPersonaTool = async (
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> => {
  const n = asNumber(input.number);
  switch (name) {
    case "reply_in_thread":
    case "post_in_channel": {
      const text = asText(input.text);
      const threadTs = name === "reply_in_thread" ? asText(input.thread_ts) : null;
      if (!text) return { content: "text is required", isError: true };
      if (name === "reply_in_thread" && !threadTs) {
        return { content: "thread_ts is required", isError: true };
      }
      const res = await ctx.slack.post({
        user: ctx.userId,
        channel: ctx.channel,
        threadTs,
        text,
      });
      if (!res.ok) return { content: `Slack refused the message: ${res.error}`, isError: true };
      ctx.log(threadTs ? `replied in thread ${threadTs}: ${text}` : `posted in the channel: ${text}`);
      return { content: `posted, ts ${res.ts}`, isError: false };
    }
    case "list_pull_requests": {
      const res = await ctx.github.listPulls();
      if (!res.ok) return failed("listing pull requests", res.status, res.text);
      const pulls = (res.body as { number: number; title: string; head?: { ref?: string } }[]) ?? [];
      if (!pulls.length) return { content: "no open pull requests", isError: false };
      return {
        content: pulls.map((p) => `#${p.number} ${p.title} (${p.head?.ref ?? "?"})`).join("\n"),
        isError: false,
      };
    }
    case "view_pull_request": {
      if (n === null) return { content: "number is required", isError: true };
      const pull = await ctx.github.getPull(n);
      if (!pull.ok) return failed(`reading #${n}`, pull.status, pull.text);
      const p = pull.body as {
        number: number;
        title: string;
        body: string | null;
        state: string;
        merged?: boolean;
        user?: { login?: string };
        head: { sha: string; ref: string };
        base?: { ref?: string };
      };
      const [checks, reviews] = await Promise.all([
        ctx.github.getChecks(p.head.sha),
        ctx.github.listReviews(n),
      ]);
      const runs = checks.ok
        ? ((checks.body as { check_runs?: { name: string; status: string; conclusion: string | null }[] })
            .check_runs ?? [])
        : [];
      const rs = reviews.ok
        ? (reviews.body as { user?: { login?: string }; state: string; body: string; commit_id?: string }[])
        : [];
      const lines = [
        `#${p.number} ${p.title}`,
        `by ${p.user?.login ?? "?"}, ${p.head.ref} into ${p.base?.ref ?? "?"}, ${p.merged ? "merged" : p.state}`,
        `head commit ${p.head.sha}`,
        "",
        p.body ?? "(no description)",
        "",
        "CI checks on the head commit:",
        ...(checks.ok
          ? runs.length
            ? runs.map((r) => `- ${r.name}: ${r.status}${r.conclusion ? `, ${r.conclusion}` : ""}`)
            : ["- none yet"]
          : [`- could not read checks: HTTP ${checks.status}`]),
        "",
        "Reviews:",
        ...(reviews.ok
          ? rs.length
            ? rs.map(
                (r) =>
                  `- ${r.user?.login ?? "?"}: ${r.state}${r.commit_id === p.head.sha ? " (on the head commit)" : r.commit_id ? " (on an older commit)" : ""}${r.body ? `\n  ${r.body}` : ""}`,
              )
            : ["- none"]
          : [`- could not read reviews: HTTP ${reviews.status}`]),
      ];
      return { content: lines.join("\n"), isError: false };
    }
    case "view_pull_request_diff": {
      if (n === null) return { content: "number is required", isError: true };
      const res = await ctx.github.getDiff(n);
      if (!res.ok) return failed(`reading the diff of #${n}`, res.status, res.text);
      return { content: res.text || "(empty diff)", isError: false };
    }
    case "review_pull_request": {
      if (n === null) return { content: "number is required", isError: true };
      const verdict = input.verdict;
      const event =
        verdict === "approve"
          ? "APPROVE"
          : verdict === "request_changes"
            ? "REQUEST_CHANGES"
            : verdict === "comment"
              ? "COMMENT"
              : null;
      if (!event) return { content: "verdict must be approve, request_changes or comment", isError: true };
      const body = typeof input.body === "string" ? input.body : "";
      if (event !== "APPROVE" && !body.trim()) {
        return { content: "say what you want changed in the body", isError: true };
      }
      const res = await ctx.github.review(n, event, body);
      if (!res.ok) return failed(`reviewing #${n}`, res.status, res.text);
      ctx.log(`reviewed #${n}: ${verdict}${body ? ` (${body})` : ""}`);
      return { content: `review submitted on #${n}`, isError: false };
    }
    case "comment_on_pull_request": {
      if (n === null) return { content: "number is required", isError: true };
      const body = asText(input.body);
      if (!body) return { content: "body is required", isError: true };
      const res = await ctx.github.comment(n, body);
      if (!res.ok) return failed(`commenting on #${n}`, res.status, res.text);
      ctx.log(`commented on #${n}: ${body}`);
      return { content: `comment posted on #${n}`, isError: false };
    }
    case "merge_pull_request": {
      if (n === null) return { content: "number is required", isError: true };
      return { content: ctx.scheduleMerge(n), isError: false };
    }
    default:
      return { content: `no tool named ${name}`, isError: true };
  }
};
