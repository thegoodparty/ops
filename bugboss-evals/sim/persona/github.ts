// The persona reaches GitHub as a person would: plain REST with a human
// token, so every review and merge it makes is attributed to a human login
// and the stand-in's branch protection judges it as a human's.

export interface GitHubResult {
  ok: boolean;
  status: number;
  body: unknown;
  text: string;
}

export const createPersonaGitHub = (args: {
  apiUrl: string;
  token: string;
  repo: string;
}) => {
  const base = `${args.apiUrl.replace(/\/$/, "")}/repos/${args.repo}`;
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    accept = "application/vnd.github+json",
  ): Promise<GitHubResult> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `token ${args.token}`,
        accept,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    if (accept.endsWith("+json")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { ok: res.ok, status: res.status, body: parsed, text };
  };

  return {
    listPulls: () => request("GET", "/pulls?state=open"),
    getPull: (n: number) => request("GET", `/pulls/${n}`),
    getDiff: (n: number) =>
      request("GET", `/pulls/${n}`, undefined, "application/vnd.github.v3.diff"),
    getChecks: (sha: string) => request("GET", `/commits/${sha}/check-runs`),
    listReviews: (n: number) => request("GET", `/pulls/${n}/reviews`),
    review: (n: number, event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT", body: string) =>
      request("POST", `/pulls/${n}/reviews`, { event, body }),
    comment: (n: number, body: string) =>
      request("POST", `/issues/${n}/comments`, { body }),
    merge: (n: number) =>
      request("PUT", `/pulls/${n}/merge`, { merge_method: "squash" }),
  };
};

export type PersonaGitHub = ReturnType<typeof createPersonaGitHub>;
