import { WebClient } from "@slack/web-api";
import { dispatch } from "./dispatch";
import { getSecrets } from "./secrets";
import { verifySlackWebhook } from "./verify";
import { handleGithub } from "./github";
import { findLatestState, type Phase } from "../framework/thread-state";

type FunctionURLEvent = {
  rawPath: string;
  body?: string;
  headers: Record<string, string>;
};

const UNAUTHORIZED = { statusCode: 401, body: "unauthorized" };

// Verbs that begin a new workflow run. Each maps to the agent that owns
// the corresponding phase.
const WRITE_VERBS = {
  "tech-design": "tech-design-agent",
  epic: "epic-agent",
  "epic-edit": "epic-edit-agent",
  work: "task-execution-agent",
} as const;

type WriteVerb = keyof typeof WRITE_VERBS;

// Verbs that continue an in-flight workflow run. We resolve which agent
// to dispatch by parsing the most recent bot post's `[phase=...]` header
// and looking up `PHASE_TO_AGENT`.
const CONTINUATION_VERBS = new Set([
  "bless",
  "edit",
  "investigate",
  "abandon",
  "stage",
  "resume",
  "go",
  "plan",
  "focus",
  "split",
]);

const PHASE_TO_AGENT: Record<Phase, string> = {
  "tech-design": "tech-design-agent",
  epic: "epic-agent",
  "epic-edit": "epic-edit-agent",
  "task-execution": "task-execution-agent",
};

// Use Object.hasOwn (not `in`) so inherited Object.prototype keys
// (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, …) don't
// match — otherwise WRITE_VERBS[verb] resolves to a prototype function,
// JSON.stringify drops it, and the worker receives a malformed job.
const isWriteVerb = (verb: string): verb is WriteVerb =>
  Object.hasOwn(WRITE_VERBS, verb);
const isContinuationVerb = (verb: string): boolean =>
  CONTINUATION_VERBS.has(verb);

const parseAllowedUsers = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split("\n")
    .map((u) => u.trim())
    .filter(Boolean);

const handleSlack = async (body: string, headers: Record<string, string>) => {
  const secrets = await getSecrets();
  const secret = secrets["SLACK_SIGNING_SECRET"];
  if (!secret) throw new Error("Missing SLACK_SIGNING_SECRET in secrets");

  const timestamp = headers["x-slack-request-timestamp"];
  const signature = headers["x-slack-signature"];
  if (!verifySlackWebhook(body, timestamp, signature, secret))
    return UNAUTHORIZED;

  if (headers["x-slack-retry-num"]) {
    return { statusCode: 200, body: "ok" };
  }

  const payload = JSON.parse(body);

  if (payload.type === "url_verification") {
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge: payload.challenge }),
    };
  }

  if (payload.type !== "event_callback") {
    return { statusCode: 200, body: "ok" };
  }

  const event = payload.event;

  if (event.bot_id || event.subtype === "bot_message") {
    return { statusCode: 200, body: "ok" };
  }

  if (event.type !== "app_mention") {
    return { statusCode: 200, body: "ok" };
  }

  const text = (event.text as string).replace(/<@[A-Z0-9]+>/g, "").trim();
  const [verb, ...rest] = text.split(/\s+/);
  const args = rest.join(" ");
  const threadTs = event.thread_ts ?? event.ts;

  const slack = new WebClient(secrets["SLACK_BOT_TOKEN"]);

  const writeVerb = isWriteVerb(verb);
  const continuationVerb = isContinuationVerb(verb);

  if (writeVerb || continuationVerb) {
    const allowed = parseAllowedUsers(secrets["WORKFLOW_USERS"]);
    if (!allowed.includes(event.user)) {
      await slack.chat.postEphemeral({
        channel: event.channel,
        user: event.user,
        thread_ts: threadTs,
        text: writeVerb
          ? `You're not in WORKFLOW_USERS — write verbs are restricted. Ping an eng lead to be added.`
          : `You're not in WORKFLOW_USERS — continuation verbs are restricted.`,
      });
      return { statusCode: 200, body: "ok" };
    }
  }

  let agent: string;
  let message: string;

  if (writeVerb) {
    agent = WRITE_VERBS[verb as WriteVerb];
    message = args;
  } else if (continuationVerb) {
    const replies = await slack.conversations.replies({
      channel: event.channel,
      ts: threadTs,
      limit: 50,
    });
    const messages = (replies.messages ?? []) as Array<{
      text?: string;
      bot_id?: string;
    }>;
    const state = findLatestState(messages);

    if (!state) {
      const lastBot = [...messages]
        .reverse()
        .find((m) => m.bot_id && m.text);
      const firstLine = lastBot?.text
        ?.split("\n")
        .find((l) => l.trim().length > 0);
      if (firstLine && /^\[(.+?)\]/.test(firstLine)) {
        console.warn(
          JSON.stringify({
            event: "workflow_malformed_header",
            channel: event.channel,
            threadTs,
            firstLine,
          }),
        );
      }
      await slack.chat.postEphemeral({
        channel: event.channel,
        user: event.user,
        thread_ts: threadTs,
        text: `No prior workflow state found in this thread. Start a new run with \`@delegate tech-design <url>\` (or \`epic\` / \`work\`).`,
      });
      return { statusCode: 200, body: "ok" };
    }

    agent = PHASE_TO_AGENT[state.phase];
    message = text;
  } else {
    agent = "slack-responder";
    message = text;
  }

  const [, { taskArn }] = await Promise.all([
    slack.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: "eyes",
    }),
    dispatch({
      agent,
      message,
      callback: {
        type: "slack",
        channel: event.channel,
        threadTs,
      },
      metadata: {
        source: "slack",
        user: event.user,
        channel: event.channel,
        reactionTs: event.ts,
      },
    }),
  ]);

  if (taskArn) {
    const taskId = taskArn.split("/").pop();
    const clusterName = taskArn.split("/")[1];
    const logsUrl = `https://us-west-2.console.aws.amazon.com/cloudwatch/home?region=us-west-2#logsV2:log-groups/log-group/$252Faws$252Fecs$252Fdelegate/log-events/agent$252Fagent$252F${taskId}`;
    const taskUrl = `https://us-west-2.console.aws.amazon.com/ecs/v2/clusters/${clusterName}/tasks/${taskId}?region=us-west-2`;
    await slack.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      thread_ts: threadTs,
      text: `I'm getting started on this now! (<${taskUrl}|view task> · <${logsUrl}|view logs>)`,
    });
  }

  return { statusCode: 200, body: "ok" };
};

type RouteHandler = (
  body: string,
  headers: Record<string, string>,
) => Promise<{
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
}>;

const routes: Record<string, RouteHandler> = {
  "/slack": handleSlack,
  "/github": handleGithub,
};

export const handler = async (event: FunctionURLEvent) => {
  const route = routes[event.rawPath];

  if (!route) {
    return {
      statusCode: 404,
      body: `Unknown path: ${event.rawPath}. Available: ${Object.keys(
        routes,
      ).join(", ")}`,
    };
  }

  try {
    return await route(event.body ?? "{}", event.headers);
  } catch (err) {
    console.error(`Error handling ${event.rawPath}:`, err);
    return { statusCode: 500, body: "internal error" };
  }
};
