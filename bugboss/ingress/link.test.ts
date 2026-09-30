import assert from "node:assert/strict";
import { test } from "node:test";

import { describeOrigin, signalOrigin, type OriginLinker } from "./link";
import { GRAFANA_SOURCE, META_PREFIX } from "./grafana";
import {
  HUMAN_SOURCE,
  SLACK_CHANNEL_LABEL,
  SLACK_MESSAGE_TS_LABEL,
} from "./human";

const linker = (url = "https://goodparty.slack.com/archives/C0D/p1700000000"): {
  calls: { ts: string; channel?: string }[];
  port: OriginLinker;
} => {
  const calls: { ts: string; channel?: string }[] = [];
  return {
    calls,
    port: {
      permalink: (ts, channel) => {
        calls.push({ ts, channel });
        return Promise.resolve(url);
      },
    },
  };
};

const failing: OriginLinker = {
  permalink: () => Promise.reject(new Error("ratelimited")),
};

test("a Grafana alert never links to the Grafana root or a silence", async () => {
  const labels = {
    [`${META_PREFIX}generator_url`]: "https://goodparty.grafana.net/",
    [`${META_PREFIX}silence_url`]: "https://goodparty.grafana.net/alerting/silence/new?alertmanager=grafana",
    [`${META_PREFIX}external_url`]: "https://goodparty.grafana.net",
  };
  // The premise: an older signal still carries a silence link on its labels.
  assert.ok(labels[`${META_PREFIX}silence_url`].includes("silence"));

  const origin = await signalOrigin({ source: GRAFANA_SOURCE, labels }, failing);
  assert.deepEqual(origin, { label: "original alert", url: null });
});

test("a Grafana alert links to the rule that fired", async () => {
  // Not `sourceId`. That is the Alertmanager fingerprint, which addresses
  // nothing -- the link is `generatorURL`, which Grafana sends beside it.
  const origin = await signalOrigin(
    {
      source: GRAFANA_SOURCE,
      labels: {
        [`${META_PREFIX}generator_url`]: "https://goodparty.grafana.net/alerting/grafana/abc/view",
      },
    },
    failing,
  );

  assert.deepEqual(origin, {
    label: "original alert",
    url: "https://goodparty.grafana.net/alerting/grafana/abc/view",
  });
});

test("a generator_url Slack would refuse degrades to the label", async () => {
  // The whole point of this being a label with an optional url. `link()`
  // throws on anything that is not http(s) or mailto, and that throw would
  // come out of `renderEvent` -- which runs while composing the
  // incident-open announcement, inside the one try/catch that turns a
  // failure into `open_post_failed`. The announcement would be lost, every
  // tick, for that incident, and the only sign would be an alarm.
  //
  // A label is attacker-writable, so this is reachable rather than
  // theoretical: `carried` starts from the alert's own labels, so an alert
  // that sends no `generatorURL` and a label literally named
  // `grafana_generator_url` puts whatever it likes here.
  for (const hostile of [
    "javascript:alert(1)",
    "/alerting/grafana/abc/view",
    "not a url at all",
    " ",
  ]) {
    const origin = await signalOrigin(
      {
        source: GRAFANA_SOURCE,
        labels: { [`${META_PREFIX}generator_url`]: hostile },
      },
      failing,
    );
    assert.deepEqual(
      origin,
      { label: "original alert", url: null },
      `${JSON.stringify(hostile)} should degrade, not travel`,
    );
  }
});

test("a Grafana alert that arrived without one says so by having no url", async () => {
  // Nothing is assembled out of an instance host and a rule uid: a URL
  // built from parts is a guess that looks like a fact and breaks silently
  // the day either moves.
  const origin = await signalOrigin(
    { source: GRAFANA_SOURCE, labels: {} },
    failing,
  );

  assert.deepEqual(origin, { label: "original alert", url: null });
});

test("a Slack report links to the message, resolved against its own channel", async () => {
  const slack = linker();
  const origin = await signalOrigin(
    {
      source: HUMAN_SOURCE,
      labels: {
        [SLACK_CHANNEL_LABEL]: "C0DEVALERTS",
        [SLACK_MESSAGE_TS_LABEL]: "1700000000.000100",
      },
    },
    slack.port,
  );

  assert.equal(origin.label, "original report");
  assert.equal(origin.url, "https://goodparty.slack.com/archives/C0D/p1700000000");
  // The channel matters: a report can arrive anywhere the bot is, and
  // chat.getPermalink needs the one the message is actually in.
  assert.deepEqual(slack.calls, [
    { ts: "1700000000.000100", channel: "C0DEVALERTS" },
  ]);
});

test("a permalink Slack answers with but Slack would not render also degrades", async () => {
  const origin = await signalOrigin(
    {
      source: HUMAN_SOURCE,
      labels: {
        [SLACK_CHANNEL_LABEL]: "C0DEVALERTS",
        [SLACK_MESSAGE_TS_LABEL]: "1700000000.000100",
      },
    },
    linker("slack://channel?id=C0D").port,
  );

  assert.deepEqual(origin, { label: "original report", url: null });
});

test("a permalink Slack refuses costs the link, never the announcement", async () => {
  const origin = await signalOrigin(
    {
      source: HUMAN_SOURCE,
      labels: {
        [SLACK_CHANNEL_LABEL]: "C0DEVALERTS",
        [SLACK_MESSAGE_TS_LABEL]: "1700000000.000100",
      },
    },
    failing,
  );

  // Naming the source is most of the value and costs nothing, so a failed
  // lookup degrades to the label rather than to silence.
  assert.deepEqual(origin, { label: "original report", url: null });
});

test("a source nobody has taught this about is named, not guessed at", async () => {
  assert.equal(describeOrigin("sentry"), "original signal");
  assert.deepEqual(await signalOrigin({ source: "sentry", labels: {} }, failing), {
    label: "original signal",
    url: null,
  });
});
