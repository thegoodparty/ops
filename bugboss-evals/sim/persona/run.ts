// The persona as a process on the orchestrator's network. It needs the Slack
// stand-in's control port and the GitHub stand-in's REST API, and real
// Bedrock credentials from the default chain: its spend is not BugBoss's, so
// it does not go through the counting proxy.

import { readFileSync, writeFileSync } from "node:fs";

import { z } from "zod";

import { createPersona } from "./agent";
import { createPersonaGitHub } from "./github";
import { createBedrockPersonaModel } from "./model";
import { createSlackControl } from "./tools";

const Env = z.object({
  PERSONA_FILE: z.string(),
  PERSONA_MODEL: z.string(),
  PERSONA_REPLY_DELAY_SECONDS: z
    .string()
    .regex(/^\d+,\d+$/)
    .transform((v) => v.split(",").map(Number) as [number, number]),
  PERSONA_MERGE_DELAY_SECONDS: z.coerce.number().int().nonnegative(),
  PERSONA_SEED: z.coerce.number().int().default(1),
  PERSONA_USER_ID: z.string().default("U0ONCALL"),
  PERSONA_OUT: z.string().optional(),
  SLACK_CONTROL_URL: z.string().url(),
  SLACK_CHANNEL_ID: z.string(),
  SLACK_BOT_USER_ID: z.string().default("U0BUGBOSS"),
  CONTROL_TOKEN: z.string().optional(),
  GITHUB_API_URL: z.string().url(),
  GITHUB_HUMAN_TOKEN: z.string().min(1),
  GITHUB_REPO: z.string().regex(/^[^/]+\/[^/]+$/).default("thegoodparty/omni"),
  AWS_REGION: z.string().default("us-west-2"),
});

const main = async () => {
  const env = Env.parse(process.env);
  const [lo, hi] = env.PERSONA_REPLY_DELAY_SECONDS;
  if (lo > hi) throw new Error("PERSONA_REPLY_DELAY_SECONDS must be min,max");
  const persona = createPersona({
    brief: readFileSync(env.PERSONA_FILE, "utf8"),
    model: createBedrockPersonaModel({ model: env.PERSONA_MODEL, region: env.AWS_REGION }),
    slack: createSlackControl({ controlUrl: env.SLACK_CONTROL_URL, token: env.CONTROL_TOKEN }),
    github: createPersonaGitHub({
      apiUrl: env.GITHUB_API_URL,
      token: env.GITHUB_HUMAN_TOKEN,
      repo: env.GITHUB_REPO,
    }),
    channel: env.SLACK_CHANNEL_ID,
    userId: env.PERSONA_USER_ID,
    botUserId: env.SLACK_BOT_USER_ID,
    replyDelaySeconds: [lo, hi],
    mergeDelaySeconds: env.PERSONA_MERGE_DELAY_SECONDS,
    seed: env.PERSONA_SEED,
    onStats: (stats) => {
      if (env.PERSONA_OUT) writeFileSync(env.PERSONA_OUT, JSON.stringify(stats, null, 2));
    },
  });
  const stop = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => stop.abort());
  }
  await persona.run(stop.signal);
  if (env.PERSONA_OUT) writeFileSync(env.PERSONA_OUT, JSON.stringify(persona.stats(), null, 2));
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
