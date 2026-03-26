import { z } from "zod";
import { WebClient } from "@slack/web-api";
import { AgentConfig, runAgent } from "../framework";
import { BASE_SYSTEM_PROMPT } from "../system-prompt";
import type { AgentJob } from "../../jobs/framework";
import { createAgentHandler } from "../../jobs/framework";

const MAX_ATTEMPTS = 3;

const extractJson = (text: string): unknown | null => {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }

  const raw = text.match(/\{[\s\S]*\}/);
  if (raw) {
    try {
      return JSON.parse(raw[0]);
    } catch {}
  }

  return null;
};

export const runScheduledAgentJob = async (jobName: string) => {
  const mod = await import(`../../jobs/${jobName}.js`);
  const agentJob: AgentJob = mod.default;

  if (agentJob.type !== "agent") {
    throw new Error(`Job "${jobName}" is not an agent job`);
  }

  const jsonSchema = z.toJSONSchema(agentJob.definition.outputSchema);

  const augmentedPrompt = [
    agentJob.definition.agent.prompt,
    "",
    "You MUST respond with your final answer as a JSON code block matching this schema:",
    "```json",
    JSON.stringify(jsonSchema, null, 2),
    "```",
  ].join("\n");

  const agentConfig: AgentConfig = {
    name: `job-${jobName}`,
    systemPrompt: BASE_SYSTEM_PROMPT + "\n" + augmentedPrompt,
    model: agentJob.definition.agent.model,
    maxBudgetUsd: 5,
  };

  let lastError: string | undefined;
  let lastOutput: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`Agent job "${jobName}" attempt ${attempt}/${MAX_ATTEMPTS}`);

    const result = await runAgent(
      agentConfig,
      "Execute the task described in your system prompt.",
    );
    lastOutput = result.output;

    const parsed = extractJson(result.output);
    if (parsed === null) {
      lastError = `No valid JSON found in agent output (attempt ${attempt})`;
      console.error(lastError);
      continue;
    }

    const validation = agentJob.definition.outputSchema.safeParse(parsed);
    if (!validation.success) {
      lastError = `Schema validation failed (attempt ${attempt}): ${validation.error.message}`;
      console.error(lastError);
      continue;
    }

    console.log(`Agent job "${jobName}" succeeded on attempt ${attempt}`);
    const handler = createAgentHandler(agentJob);
    await handler(validation.data);
    return;
  }

  console.error(
    `Agent job "${jobName}" failed after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  );

  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (slackToken) {
    const slack = new WebClient(slackToken);
    await slack.chat.postMessage({
      channel: "#serve-dev",
      text: [
        `*Agent job \`${jobName}\` failed*`,
        `${MAX_ATTEMPTS} attempts, output never matched schema.`,
        `Last error: ${lastError}`,
        `Last raw output: ${(lastOutput ?? "").slice(0, 500)}`,
      ].join("\n"),
    });
  }

  process.exit(1);
};
