import { WebClient } from "@slack/web-api";
import { runAgent, sendCallback } from "../framework";
import type { AgentConfig, AgentJob } from "../framework";
import { BASE_SYSTEM_PROMPT } from "../system-prompt";
import { setupGitHubAuth } from "./github-auth";
import { runScheduledAgentJob } from "./agent-job-runner";

const SLACK_PROMPT = `You are responding to a question in Slack.

Your response will be posted back to the Slack thread where you were mentioned. Write your final output as the message you want posted — no extra formatting or preamble needed.

Be concise and conversational. You're in a Slack thread, not writing a report.

## Formatting

Your output is posted directly to Slack. Use Slack's mrkdwn format, NOT Markdown:
- Bold: *bold* (not **bold**)
- Italic: _italic_ (not *italic*)
- Code: \`code\` (same as Markdown)
- Code block: \`\`\`code\`\`\` (same as Markdown)
- Bullet lists: use bullet character (•) or dash (-), no nested indentation
- Links: <url|label>
- Do NOT use headers (#), they don't render in Slack
- Do NOT use markdown tables (| col | col |) or horizontal rules (---), they don't render in Slack
- For tabular data, use a code block with monospaced alignment

## Thread context

You will receive the full Slack thread context in your prompt as <slack-thread> XML. ALWAYS read it carefully before responding. The thread contains all the information you need to understand the request. NEVER ask clarifying questions if the answer is in the thread. Just start investigating immediately with the tools you have.

## Alert investigation

If the thread contains a fired alert (e.g. from Grafana), investigate it immediately — do not ask for more details:
1. Extract the alert details from the thread (alert name, service, metrics)
2. Query Grafana logs/metrics around the alert time
3. If the problem isn't clear from Grafana, check Sentry for related errors
4. Summarize your findings — lead with the most important finding

## Pull Requests

When making pull requests, always link back to the original slack thread in the PR description.
`;

const slackResponder: AgentConfig = {
  name: "delegate-slack-responder",
  maxBudgetUsd: 5,
  systemPrompt: BASE_SYSTEM_PROMPT + "\n" + SLACK_PROMPT,
  model: "claude-opus-4-6",
};

const main = async () => {
  await setupGitHubAuth();

  const raw = process.env.AGENT_JOB;
  if (!raw) {
    console.error("AGENT_JOB environment variable not set");
    process.exit(1);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("AGENT_JOB is not valid JSON:", raw);
    process.exit(1);
  }

  if (typeof parsed.jobName === "string") {
    await runScheduledAgentJob(parsed.jobName);
    return;
  }

  const job = parsed as unknown as AgentJob;

  console.log("Starting delegate");
  if (job.metadata) console.log("Metadata:", job.metadata);

  const slack =
    job.metadata?.source === "slack"
      ? new WebClient(process.env.SLACK_BOT_TOKEN)
      : undefined;

  let message = job.message;
  if (slack && job.metadata?.source === "slack") {
    const threadTs =
      job.callback?.type === "slack" ? job.callback.threadTs : undefined;

    if (threadTs) {
      const replies = await slack.conversations.replies({
        channel: job.metadata.channel,
        ts: threadTs,
        limit: 50,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const formatMessage = (m: any) => {
        const parts: string[] = [];
        if (m.text) parts.push(m.text);
        if (m.attachments) {
          for (const a of m.attachments) {
            if (a.pretext) parts.push(a.pretext);
            if (a.title) parts.push(a.title);
            if (a.text) parts.push(a.text);
            if (a.fallback && !a.text && !a.title) parts.push(a.fallback);
          }
        }
        if (m.blocks) {
          for (const block of m.blocks as Array<{
            type: string;
            text?: { text?: string };
            elements?: Array<{ elements?: Array<{ text?: string }> }>;
          }>) {
            if (block.type === "section" && block.text?.text)
              parts.push(block.text.text);
            if (block.type === "rich_text" && block.elements) {
              for (const el of block.elements) {
                if (el.elements) {
                  for (const inner of el.elements) {
                    if (inner.text) parts.push(inner.text);
                  }
                }
              }
            }
          }
        }
        return parts.join("\n");
      };

      const threadMessages = (replies.messages ?? [])
        .map((m) => {
          const content = formatMessage(m);
          return `<message user="${m.user ?? m.bot_id ?? "unknown"}" ts="${
            m.ts
          }">\n${content}\n</message>`;
        })
        .join("\n");

      console.log("Thread context:", threadMessages.slice(0, 2000));
      message = `<slack-thread channel="${job.metadata.channel}" thread_ts="${threadTs}">\n${threadMessages}\n</slack-thread>\n\n${message}`;
    } else {
      message = `<slack-context channel="${job.metadata.channel}">You were mentioned in this Slack channel.</slack-context>\n\n${message}`;
    }
  }

  const result = await runAgent(slackResponder, message, job.cwd);

  console.log(`Agent completed in ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log("Output:", result.output);

  const callbacks: Promise<unknown>[] = [];

  if (job.callback) {
    console.log(`Sending callback to ${job.callback.type}...`);
    callbacks.push(sendCallback(job.callback, result));
  }

  if (slack && job.metadata?.source === "slack" && job.metadata.reactionTs) {
    callbacks.push(
      slack.reactions.remove({
        channel: job.metadata.channel,
        timestamp: job.metadata.reactionTs,
        name: "eyes",
      }),
    );
  }

  await Promise.all(callbacks);
  if (job.callback) console.log("Callback sent");
};

main().catch((err) => {
  console.error("Worker failed:", err);
  process.exit(1);
});
