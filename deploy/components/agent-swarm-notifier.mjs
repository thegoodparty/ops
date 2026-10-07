import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({});
let token;

export const formatAlarm = (alarm) =>
  [
    `*${alarm.AlarmName}* is ${alarm.NewStateValue} (was ${alarm.OldStateValue})`,
    alarm.AlarmDescription,
    alarm.NewStateValue === "OK" ? undefined : `> ${alarm.NewStateReason}`,
  ]
    .filter(Boolean)
    .join("\n");

export const handler = async (event) => {
  if (!token) {
    const { SecretString } = await secrets.send(
      new GetSecretValueCommand({ SecretId: process.env.SECRET_ID }),
    );
    token = JSON.parse(SecretString).SLACK_BOT_TOKEN;
  }
  for (const record of event.Records) {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: process.env.SLACK_CHANNEL,
        text: formatAlarm(JSON.parse(record.Sns.Message)),
        unfurl_links: false,
      }),
    });
    const body = await response.json();
    if (!body.ok) throw new Error(`chat.postMessage failed: ${body.error}`);
  }
};
