import { WebClient } from "@slack/web-api";
import { dispatch } from "./dispatch";
import { getSecrets } from "./secrets";
import { verifySlackWebhook } from "./verify";
import { handleGithub } from "./github";

type FunctionURLEvent = {
  rawPath: string;
  body?: string;
  headers: Record<string, string>;
};

const UNAUTHORIZED = { statusCode: 401, body: "unauthorized" };

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

  if (payload.type === "event_callback") {
    const event = payload.event;

    if (event.bot_id || event.subtype === "bot_message") {
      return { statusCode: 200, body: "ok" };
    }

    if (event.type === "app_mention") {
      const text = (event.text as string).replace(/<@[A-Z0-9]+>/g, "").trim();
      const threadTs = event.thread_ts ?? event.ts;

      const slack = new WebClient(secrets["SLACK_BOT_TOKEN"]);

      const [, { taskArn }] = await Promise.all([
        slack.reactions.add({
          channel: event.channel,
          timestamp: event.ts,
          name: "eyes",
        }),
        dispatch({
          agent: "slack-responder",
          message: text,
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
    }
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
