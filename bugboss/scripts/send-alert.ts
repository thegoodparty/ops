// Replay a Grafana alert at a running BugBoss, signed the way Grafana signs.
//
// The point is to drive one alert you chose through the whole loop before any
// notification policy points real traffic at it. Works against a local run or
// the deployed one; the signature is the same either way.
//
//   GRAFANA_WEBHOOK_SECRET=... npx tsx bugboss/scripts/send-alert.ts
//   ... --url https://bugboss.goodparty.org/grafana
//   ... --file ./a-real-payload.json
//   ... --slug campaigns-route-errors --resolved
//
// With no --file it sends a realistic single firing alert. Copy a real body
// out of Grafana's delivery log and pass --file to replay an actual one.

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const secret = process.env.GRAFANA_WEBHOOK_SECRET;
if (!secret) {
  console.error(
    "GRAFANA_WEBHOOK_SECRET is required: it is both the HMAC key and, unless\n" +
      "the contact point sets its own, the basic-auth password.",
  );
  process.exit(1);
}

const url = arg("url") ?? "http://127.0.0.1:3000/grafana";
const slug = arg("slug") ?? "bugboss-smoke-test";
const status = flag("resolved") ? "resolved" : "firing";

// A firing episode is identified by fingerprint plus startsAt, so replaying
// the same pair is a duplicate and a new startsAt is a new episode. That is
// the distinction to play with when testing recurrence.
const startsAt = arg("starts-at") ?? new Date().toISOString();

const body =
  arg("file") !== undefined
    ? readFileSync(arg("file")!, "utf8")
    : JSON.stringify({
        status,
        alerts: [
          {
            status,
            fingerprint: arg("fingerprint") ?? "bugboss-smoke-0001",
            startsAt,
            labels: { alert_slug: slug, environment: "prod" },
            annotations: {
              summary: `[PROD] ${slug}`,
              description: "Sent by hand from bugboss/scripts/send-alert.ts.",
            },
          },
        ],
      });

const stamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", secret)
  .update(`${stamp}:${body}`, "utf8")
  .digest("hex");

const main = async () => {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Grafana only sends this if the contact point names it explicitly.
      // Without it the body is signed alone, which is replayable, so ingress
      // rejects the delivery -- silently, from the sender's point of view.
      "X-Grafana-Alerting-Timestamp": stamp,
      "X-Grafana-Alerting-Signature": signature,
      authorization: `Basic ${Buffer.from(
        `bugboss:${process.env.GRAFANA_BASIC_AUTH_PASSWORD ?? secret}`,
      ).toString("base64")}`,
    },
    body,
  });
  console.log(res.status, await res.text());
  if (res.status === 401) {
    console.error(
      "\n401 means verification failed, not that BugBoss is down. Check the\n" +
        "secret matches, and that your clock is within 300s of the server's.",
    );
  }
};

void main();
