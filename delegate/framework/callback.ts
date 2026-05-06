import { WebClient } from "@slack/web-api";
import { execFileSync } from "child_process";
import type { AgentResult, CallbackTarget } from "./types";

const getSlack = () => {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not set");
  return new WebClient(token);
};

const formatFooter = (result: AgentResult): string => {
  const parts = [
    result.agent,
    `${(result.durationMs / 1000).toFixed(1)}s`,
  ];
  const isWorkflowAgent = result.agent.endsWith("-agent");
  if (isWorkflowAgent) {
    const sha = (process.env.RUNBOOKS_SHA ?? "").slice(0, 7);
    if (sha) parts.push(`runbooks=${sha}`);
    if (typeof result.costUsd === "number")
      parts.push(`cost=$${result.costUsd.toFixed(2)}`);
    if (typeof result.turns === "number") parts.push(`turns=${result.turns}`);
  }
  return `_${parts.join(" · ")}_`;
};

export const sendCallback = async (
  target: CallbackTarget,
  result: AgentResult
) => {
  const summary = `${result.output}\n\n${formatFooter(result)}`;

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
