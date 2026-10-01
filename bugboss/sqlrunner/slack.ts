// The production SqlRunnerSlack. Wiring only: what each answer means is
// decided in runner.ts.

import { ErrorCode, retryPolicies, WebClient } from "@slack/web-api";

import type { Reaction, SqlRunnerSlack } from "./runner";

const isSlackError = (err: unknown, code: string): boolean => {
  const e = err as { code?: unknown; data?: { error?: unknown } } | null;
  return e?.code === ErrorCode.PlatformError && e.data?.error === code;
};

export const createSqlRunnerSlack = (token: string): SqlRunnerSlack => {
  // Writes may wait out a rate limit: a request nobody can see, or an outcome
  // line that never lands, is worse than a slow one.
  const writer = new WebClient(token, {
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
  });
  // Reads do not retry. The poll comes round again in five seconds, and an
  // SDK parked on a 429 for minutes would hold every other request's poll.
  const reader = new WebClient(token, { retryConfig: { retries: 0 } });

  return {
    post: async (channel, threadTs, text) => {
      const res = await writer.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!res.ts) throw new Error("chat.postMessage returned no ts");
      return { ts: res.ts, text: res.message?.text ?? text };
    },

    update: async (channel, ts, text) => {
      await writer.chat.update({ channel, ts, text });
    },

    reactions: async (channel, ts) => {
      try {
        const res = await reader.reactions.get({ channel, timestamp: ts, full: true });
        return (res.message?.reactions ?? []).map(
          (r): Reaction => ({
            name: r.name ?? "",
            users: (r.users ?? []).filter((u): u is string => typeof u === "string"),
          }),
        );
      } catch (err) {
        if (isSlackError(err, "message_not_found")) return null;
        throw err;
      }
    },

    // conversations.replies always puts the thread's parent first, whatever
    // oldest/latest say, so `limit: 1` would return the parent and never the
    // reply. The window is pinned to our ts and the reply is found by ts.
    reply: async (channel, threadTs, ts) => {
      const res = await reader.conversations.replies({
        channel,
        ts: threadTs,
        oldest: ts,
        latest: ts,
        inclusive: true,
        limit: 10,
      });
      const found = (res.messages ?? []).find((m) => m.ts === ts);
      if (!found) return null;
      return { text: found.text ?? "", edited: found.edited !== undefined };
    },

    rotationMembers: async (usergroupId) => {
      const res = await reader.usergroups.users.list({ usergroup: usergroupId });
      return (res.users ?? []).filter((u): u is string => typeof u === "string");
    },
  };
};
