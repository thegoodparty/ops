// Where a signal came from, as something a reader can open.
//
// An incident thread said "1 signal" and gave no way to reach the thing that
// opened it -- so somebody reading the channel had to go and find the alert
// or scroll for the report themselves, which on the alert side means knowing
// which Grafana rule fired.
//
// The two sources answer this from different places and neither is
// `sourceId`, which is why this is a function rather than a column. A Grafana
// signal's id is the Alertmanager fingerprint, which addresses nothing; the
// link is `generatorURL`, which Grafana sends beside it and ingress already
// carries as a label. A human report's id IS the message, but a Slack
// permalink is built from the workspace domain, which nothing here knows, so
// it is an API call.

import { isLinkable } from "../slack/format";
import { GRAFANA_SOURCE, META_PREFIX } from "./grafana";
import { HUMAN_SOURCE, SLACK_CHANNEL_LABEL, SLACK_MESSAGE_TS_LABEL } from "./human";

/** As much of a signal as knowing where it came from needs. */
export interface SignalOrigin {
  source: string;
  labels: Record<string, string>;
}

/**
 * Slack's permalink lookup. The same shape `SlackLinker` has, taken as an
 * interface so this is testable without one.
 */
export interface OriginLinker {
  permalink(messageTs: string, channel?: string): Promise<string>;
}

/**
 * What opened an incident: what it was, and where to read it.
 *
 * `label` is the link's text in the thread header, and says only which kind
 * of thing is behind it: nothing about the alert itself goes in the header.
 * `url` may be null, and then the header has no link line at all.
 */
export interface SignalOriginRef {
  label: string;
  url: string | null;
}

const isBareHost = (url: string): boolean => {
  try {
    const parsed = new URL(url.trim());
    return parsed.pathname.replace(/\/+$/, "") === "" && !parsed.search && !parsed.hash;
  } catch {
    return true;
  }
};

export const describeOrigin = (source: string): string =>
  source === HUMAN_SOURCE
    ? "original report"
    : source === GRAFANA_SOURCE
      ? "original alert"
      : "original signal";

export const signalOrigin = async (
  signal: SignalOrigin,
  linker: OriginLinker,
): Promise<SignalOriginRef> => {
  const label = describeOrigin(signal.source);

  if (signal.source === GRAFANA_SOURCE) {
    // Grafana's own deeplink to the rule that fired, sent on the webhook and
    // stored by ingress. Nothing is built here: a URL assembled out of an
    // instance host and a rule uid is a guess that looks like a fact, and it
    // breaks silently the day either moves.
    //
    // Checked rather than trusted, and this is not belt and braces. It
    // arrives on a label; `carried` starts from the alert's own labels, so
    // an alert that sends no `generatorURL` and a label named
    // `grafana_generator_url` decides this value. `link()` throws on a
    // scheme it will not emit, and the caller for this is `renderEvent`
    // composing an incident-open announcement -- inside the one try/catch
    // that turns any throw into `open_post_failed`. Unchecked, a hostile or
    // simply malformed url costs the whole announcement, on every tick, and
    // leaves an alarm as the only trace.
    //
    // A url with no path is the Grafana root, which is not this alert.
    const url = signal.labels[`${META_PREFIX}generator_url`] ?? "";
    return { label, url: isLinkable(url) && !isBareHost(url) ? url.trim() : null };
  }

  if (signal.source === HUMAN_SOURCE) {
    const channel = signal.labels[SLACK_CHANNEL_LABEL];
    const messageTs = signal.labels[SLACK_MESSAGE_TS_LABEL];
    if (!channel || !messageTs) return { label, url: null };
    try {
      // Same check as the alert branch. This one comes from
      // `chat.getPermalink` rather than from a label, so it is not the
      // hostile case -- but it lands in the same `link()` call, and one
      // surprising answer from Slack should cost the link rather than the
      // announcement.
      const url = await linker.permalink(messageTs, channel);
      return { label, url: isLinkable(url) ? url.trim() : null };
    } catch {
      // The caller is about to announce an incident. Losing the link loses a
      // convenience; throwing here would lose the announcement.
      return { label, url: null };
    }
  }

  return { label, url: null };
};
