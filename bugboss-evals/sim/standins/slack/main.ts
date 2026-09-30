// The Slack stand-in as a compose service. Everything is configured by env
// so the orchestrator owns the values; the defaults are the sim's fixed ids.

import { z } from "zod";

import { startSlackStandin } from "./server";

const Users = z.array(
  z
    .object({
      id: z.string(),
      name: z.string(),
      realName: z.string(),
      isBot: z.boolean().default(false),
    })
    .strict(),
);

const Env = z.object({
  PORT: z.coerce.number().int().default(8445),
  CONTROL_PORT: z.coerce.number().int().default(9003),
  TLS_CERT_FILE: z.string().optional(),
  TLS_KEY_FILE: z.string().optional(),
  SLACK_PUBLIC_URL: z.string().default("https://slack:8445"),
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_BOT_USER_ID: z.string().default("U0BUGBOSS"),
  SLACK_BOT_ID: z.string().default("B0BUGBOSS"),
  SLACK_TEAM_ID: z.string().default("T0SIM"),
  SLACK_APP_ID: z.string().default("A0BUGBOSS"),
  SLACK_WORKSPACE_DOMAIN: z.string().default("goodparty-sim.slack.com"),
  CONTROL_HOST: z.string().default("0.0.0.0"),
  CONTROL_TOKEN: z.string().optional(),
  /** The incident channel. */
  SLACK_CHANNEL_ID: z.string().optional(),
  /** Any further channels, comma-separated: the alert channel, say. */
  SLACK_CHANNEL_IDS: z.string().default(""),
  /** JSON array of { id, name, realName, isBot? }. The bot is added. */
  SLACK_USERS: z.string().default("[]"),
  /** JSON object of usergroup id to member ids. */
  SLACK_USERGROUPS: z.string().default("{}"),
  BUGBOSS_EVENTS_URL: z.string().url(),
  SLACK_INTERACTIVITY_URL: z.string().url().optional(),
  SLACK_REPLIES_PAGE_CAP: z.coerce.number().int().positive().optional(),
});

const main = async () => {
  const env = Env.parse(process.env);
  const channels = [
    ...new Set(
      [env.SLACK_CHANNEL_ID ?? "", ...env.SLACK_CHANNEL_IDS.split(",")]
        .map((c) => c.trim())
        .filter(Boolean),
    ),
  ];
  if (!channels.length) {
    throw new Error("SLACK_CHANNEL_ID or SLACK_CHANNEL_IDS is required");
  }
  const users = Users.parse(JSON.parse(env.SLACK_USERS));
  if (!users.some((u) => u.id === env.SLACK_BOT_USER_ID)) {
    users.push({
      id: env.SLACK_BOT_USER_ID,
      name: "bugboss",
      realName: "BugBoss",
      isBot: true,
    });
  }
  const tls =
    env.TLS_CERT_FILE && env.TLS_KEY_FILE
      ? { certFile: env.TLS_CERT_FILE, keyFile: env.TLS_KEY_FILE }
      : undefined;
  const standin = await startSlackStandin({
    store: {
      channels,
      users,
      usergroups: z
        .record(z.string(), z.array(z.string()))
        .parse(JSON.parse(env.SLACK_USERGROUPS)),
      botUserId: env.SLACK_BOT_USER_ID,
      botId: env.SLACK_BOT_ID,
      teamId: env.SLACK_TEAM_ID,
      workspaceDomain: env.SLACK_WORKSPACE_DOMAIN,
    },
    botToken: env.SLACK_BOT_TOKEN,
    events: {
      eventsUrl: env.BUGBOSS_EVENTS_URL,
      interactivityUrl: env.SLACK_INTERACTIVITY_URL,
      signingSecret: env.SLACK_SIGNING_SECRET,
      apiAppId: env.SLACK_APP_ID,
    },
    port: env.PORT,
    controlPort: env.CONTROL_PORT,
    controlHost: env.CONTROL_HOST,
    controlToken: env.CONTROL_TOKEN,
    publicUrl: env.SLACK_PUBLIC_URL,
    tls,
    repliesPageCap: env.SLACK_REPLIES_PAGE_CAP,
  });
  console.log(
    JSON.stringify({
      component: "slack-standin",
      event: "listening",
      apiPort: standin.apiPort,
      controlPort: standin.controlPort,
    }),
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
