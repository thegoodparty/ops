import { WebClient } from "@slack/web-api";
import { execFileSync } from "child_process";
import type { AgentResult, CallbackTarget } from "./types";

const getSlack = () => {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not set");
  return new WebClient(token);
};

export const sendCallback = async (
  target: CallbackTarget,
  result: AgentResult
) => {
  const summary = `${result.output}\n\n_${result.agent} · ${(result.durationMs / 1000).toFixed(1)}s_`;

  switch (target.type) {
    case "slack": {
      const slack = getSlack();
      await slack.chat.postMessage({
        channel: target.channel,
        thread_ts: target.threadTs,
        text: summary,
      });
      break;
    }
    case "github":
    case "github-pr": {
      const cmd = target.type === "github" ? "issue" : "pr";
      const num = target.type === "github" ? target.issueNumber : target.prNumber;
      execFileSync("gh", [cmd, "comment", String(num), "--repo", target.repo, "--body", summary], { stdio: "pipe" });
      break;
    }
  }
};
