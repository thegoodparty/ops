import "../agents";
import { execFileSync } from "node:child_process";
import { WebClient } from "@slack/web-api";
import { getAgent, runAgent, sendCallback } from "../framework";
import type { AgentJob } from "../framework";
import { setupGitHubAuth } from "./github-auth";

// Workflow agents (PRD-to-code) need the runbooks repo on disk and the
// ClickUp credentials in env. Framework agents (slack-responder, pr-reviewer)
// don't — they should keep working even if those secrets are unset.
const isWorkflowAgent = (name: string): boolean => name.endsWith("-agent");

const CLICKUP_TEAM_ID = "90132012119";

// Best-effort Slack post used to surface fatal boot-time failures back to
// the user's thread. Returns silently on any failure — the process is
// going to exit anyway.
const reportBootFailure = async (
  job: AgentJob | undefined,
  message: string,
) => {
  if (!job?.callback || job.callback.type !== "slack") return;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;
  try {
    const slack = new WebClient(token);
    await slack.chat.postMessage({
      channel: job.callback.channel,
      thread_ts: job.callback.threadTs,
      text: `:warning: Boot failure: ${message}. Re-mention me to retry.`,
    });
  } catch {
    // intentionally silent — we're already exiting
  }
};

const parseJob = (): AgentJob | undefined => {
  const raw = process.env.AGENT_JOB;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as AgentJob;
  } catch {
    return undefined;
  }
};

const main = async () => {
  // Parse the job first so any subsequent fatal can be surfaced to the
  // originating Slack thread instead of leaving the user with :eyes: and
  // silence.
  const job = parseJob();
  if (!job) {
    console.error("AGENT_JOB environment variable not set or invalid JSON");
    process.exit(1);
  }

  await setupGitHubAuth();

  const needsRunbooks = isWorkflowAgent(job.agent);
  const runbooksDir = process.env.RUNBOOKS_DIR ?? "/app/runbooks";

  if (needsRunbooks) {
    try {
      execFileSync(
        "gh",
        ["repo", "clone", "thegoodparty/runbooks", runbooksDir, "--", "--depth=1"],
        { stdio: "inherit" },
      );
      const sha = execFileSync("git", ["-C", runbooksDir, "rev-parse", "--short", "HEAD"])
        .toString()
        .trim();
      process.env.RUNBOOKS_DIR = runbooksDir;
      process.env.RUNBOOKS_SHA = sha;
      console.log(`Runbooks cloned at ${runbooksDir} (SHA ${sha})`);
    } catch (err) {
      console.error("Failed to clone runbooks:", err);
      await reportBootFailure(
        job,
        "could not clone `thegoodparty/runbooks`. Verify the GitHub App is installed on that repo",
      );
      process.exit(1);
    }

    if (!process.env.CLICKUP_TOKEN) {
      console.error("CLICKUP_TOKEN environment variable not set");
      await reportBootFailure(
        job,
        "`CLICKUP_TOKEN` is missing from the DELEGATES secret",
      );
      process.exit(1);
    }
    if (!process.env.CLICKUP_API_KEY) {
      process.env.CLICKUP_API_KEY = process.env.CLICKUP_TOKEN;
    }
    if (!process.env.CLICKUP_TEAM_ID) {
      process.env.CLICKUP_TEAM_ID = CLICKUP_TEAM_ID;
    }
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
