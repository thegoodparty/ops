import "../agents";
import { WebClient } from "@slack/web-api";
import { getAgent, runAgent, sendCallback } from "../framework";
import type { AgentJob } from "../framework";
import { setupGitHubAuth } from "./github-auth";

const main = async () => {
  await setupGitHubAuth();

  const raw = process.env.AGENT_JOB;
  if (!raw) {
    console.error("AGENT_JOB environment variable not set");
    process.exit(1);
  }

  let job: AgentJob;
  try {
    job = JSON.parse(raw);
  } catch {
    console.error("AGENT_JOB is not valid JSON:", raw);
    process.exit(1);
  }

  console.log(`Starting agent: ${job.agent}`);
  if (job.metadata) console.log("Metadata:", job.metadata);

  const config = getAgent(job.agent);

  const slack = job.metadata?.source === "slack"
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
          for (const block of m.blocks as Array<{ type: string; text?: { text?: string }; elements?: Array<{ elements?: Array<{ text?: string }> }> }>) {
            if (block.type === "section" && block.text?.text) parts.push(block.text.text);
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
          return `<message user="${m.user ?? m.bot_id ?? "unknown"}" ts="${m.ts}">\n${content}\n</message>`;
        })
        .join("\n");

      console.log("Thread context:", threadMessages.slice(0, 2000));
      message = `<slack-thread channel="${job.metadata.channel}" thread_ts="${threadTs}">\n${threadMessages}\n</slack-thread>\n\n${message}`;
    } else {
      message = `<slack-context channel="${job.metadata.channel}">You were mentioned in this Slack channel.</slack-context>\n\n${message}`;
    }
  }

  const result = await runAgent(config, message, job.cwd);

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
