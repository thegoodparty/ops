const BASE_URL = "https://api.github.com";
const GRAPHQL_URL = "https://api.github.com/graphql";

const parseLinkNext = (header: string | null): string | undefined => {
  if (!header) return undefined;
  const match = header.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1];
};

// One reply in a review thread. `byViewer` is true for comments the reviewer
// App itself posted, which is how the bot's own answers are told apart from
// other bots without hard-coding its login.
export type ThreadComment = {
  databaseId: number;
  body: string;
  createdAt: string;
  authorAssociation: string;
  byViewer: boolean;
  authorLogin: string;
  authorIsUser: boolean;
};

type FetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;

export const createGitHub = (token: string, fetchImpl: FetchFn = fetch) => {
  const baseHeaders: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const doFetch = async (method: string, url: string, body?: unknown): Promise<Response> => {
    const headers: Record<string, string> = { ...baseHeaders };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return res;
  };

  const graphql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const res = await fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST ${GRAPHQL_URL} → ${res.status}: ${text.slice(0, 300)}`);
    }
    const envelope = (await res.json()) as { data: T; errors?: Array<{ message: string }> };
    if (envelope.errors?.length) {
      throw new Error(`GraphQL errors: ${JSON.stringify(envelope.errors).slice(0, 300)}`);
    }
    return envelope.data;
  };

  const getPull = async (repo: string, prNumber: number) => {
    const prRes = await doFetch("GET", `${BASE_URL}/repos/${repo}/pulls/${prNumber}`);
    const pr = (await prRes.json()) as {
      head: { sha: string };
      base: { sha: string; ref: string };
      title: string;
      body: string | null;
      user: { login: string };
      draft: boolean;
    };

    const changedFiles: string[] = [];
    let filesUrl: string | undefined = `${BASE_URL}/repos/${repo}/pulls/${prNumber}/files?per_page=100`;
    while (filesUrl) {
      const filesRes = await doFetch("GET", filesUrl);
      const files = (await filesRes.json()) as Array<{ filename: string }>;
      for (const f of files) changedFiles.push(f.filename);
      filesUrl = parseLinkNext(filesRes.headers.get("Link"));
    }

    return {
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      baseRef: pr.base.ref,
      title: pr.title,
      body: pr.body ?? "",
      author: pr.user.login,
      isDraft: pr.draft,
      changedFiles,
    };
  };

  const getMergeBase = async (repo: string, base: string, head: string): Promise<string> => {
    const res = await doFetch("GET", `${BASE_URL}/repos/${repo}/compare/${base}...${head}`);
    const data = (await res.json()) as { merge_base_commit: { sha: string } };
    return data.merge_base_commit.sha;
  };

  const postIssueComment = async (repo: string, prNumber: number, body: string): Promise<void> => {
    await doFetch("POST", `${BASE_URL}/repos/${repo}/issues/${prNumber}/comments`, { body });
  };

  const getHeadSha = async (repo: string, prNumber: number): Promise<string> => {
    const res = await doFetch("GET", `${BASE_URL}/repos/${repo}/pulls/${prNumber}`);
    const pr = (await res.json()) as { head: { sha: string } };
    return pr.head.sha;
  };

  const postStatus = async (
    repo: string,
    sha: string,
    status: {
      state: "pending" | "success" | "error" | "failure";
      description: string;
      targetUrl?: string;
    },
  ): Promise<void> => {
    await doFetch("POST", `${BASE_URL}/repos/${repo}/statuses/${sha}`, {
      state: status.state,
      description: status.description,
      target_url: status.targetUrl,
      context: "pr-reviewer",
    });
  };

  const postReview = async (
    repo: string,
    prNumber: number,
    review: {
      commitId: string;
      event: "APPROVE" | "COMMENT";
      body: string;
      comments: Array<{
        path: string;
        line: number;
        side?: "RIGHT";
        start_line?: number;
        start_side?: "RIGHT";
        body: string;
      }>;
    },
  ) => {
    const reviewRes = await doFetch(
      "POST",
      `${BASE_URL}/repos/${repo}/pulls/${prNumber}/reviews`,
      {
        commit_id: review.commitId,
        event: review.event,
        body: review.body,
        comments: review.comments,
      },
    );
    const reviewData = (await reviewRes.json()) as { id: number };
    const reviewId = reviewData.id;

    // /reviews/{id}/comments returns the legacy shape with no `line`, so the
    // PR-wide comments endpoint is the one that can be matched to findings.
    const rawComments: Array<{
      id: number;
      path: string;
      line: number | null;
      original_line: number | null;
      pull_request_review_id: number | null;
    }> = [];
    let commentsUrl: string | undefined =
      `${BASE_URL}/repos/${repo}/pulls/${prNumber}/comments?per_page=100`;
    while (commentsUrl) {
      const commentsRes = await doFetch("GET", commentsUrl);
      const page = (await commentsRes.json()) as typeof rawComments;
      for (const c of page) rawComments.push(c);
      commentsUrl = parseLinkNext(commentsRes.headers.get("Link"));
    }

    return {
      reviewId,
      comments: rawComments
        .filter((c) => c.pull_request_review_id === reviewId)
        .map((c) => ({ id: c.id, path: c.path, line: c.line ?? c.original_line })),
    };
  };

  const dismissReview = async (
    repo: string,
    prNumber: number,
    reviewId: number,
    message: string,
  ): Promise<void> => {
    await doFetch(
      "PUT",
      `${BASE_URL}/repos/${repo}/pulls/${prNumber}/reviews/${reviewId}/dismissals`,
      { message },
    );
  };

  const listReviewThreads = async (repo: string, prNumber: number) => {
    const [owner, name] = repo.split("/") as [string, string];

    type RawThread = {
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      comments: {
        nodes: Array<{
          databaseId: number;
          body: string;
          path: string;
          line: number | null;
          createdAt: string;
          authorAssociation: string;
          viewerDidAuthor: boolean;
          author: { login: string; __typename: string } | null;
        }>;
      };
    };

    type PageResponse = {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: RawThread[];
          };
        };
      };
    };

    const query = `
      query($owner: String!, $name: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id isResolved isOutdated
                comments(first: 100) {
                  nodes {
                    databaseId body path line createdAt authorAssociation viewerDidAuthor
                    author { login __typename }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const threads: Array<{
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      firstComment: { databaseId: number; body: string; path: string; line: number | null };
      replies: ThreadComment[];
    }> = [];

    let after: string | null = null;
    let hasNext = true;

    while (hasNext) {
      const data: PageResponse = await graphql<PageResponse>(query, { owner, name, number: prNumber, after });
      const page: PageResponse["repository"]["pullRequest"]["reviewThreads"] = data.repository.pullRequest.reviewThreads;
      for (const t of page.nodes) {
        const first = t.comments.nodes[0];
        if (first) {
          threads.push({
            id: t.id,
            isResolved: t.isResolved,
            isOutdated: t.isOutdated,
            firstComment: {
              databaseId: first.databaseId,
              body: first.body,
              path: first.path,
              line: first.line,
            },
            replies: t.comments.nodes.slice(1).map((c) => ({
              databaseId: c.databaseId,
              body: c.body,
              createdAt: c.createdAt,
              authorAssociation: c.authorAssociation,
              byViewer: c.viewerDidAuthor,
              authorLogin: c.author?.login ?? "ghost",
              authorIsUser: c.author?.__typename === "User",
            })),
          });
        }
      }
      hasNext = page.pageInfo.hasNextPage;
      after = page.pageInfo.endCursor;
    }

    return threads;
  };

  // Posted as the reviewer App, so the reply shows up in the finding's own
  // thread rather than as a new top-level comment.
  const replyToReviewComment = async (
    repo: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<void> => {
    await doFetch(
      "POST",
      `${BASE_URL}/repos/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
      { body },
    );
  };

  const resolveThread = async (threadId: string): Promise<void> => {
    await graphql<unknown>(
      `mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
      }`,
      { threadId },
    );
  };

  const unresolveThread = async (threadId: string): Promise<void> => {
    await graphql<unknown>(
      `mutation($threadId: ID!) {
        unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
      }`,
      { threadId },
    );
  };

  const findThreadIdByCommentId = (
    threads: Array<{ id: string; firstComment: { databaseId: number } }>,
    commentId: number,
  ): string | undefined =>
    threads.find((t) => t.firstComment.databaseId === commentId)?.id;

  return {
    getPull,
    postIssueComment,
    getMergeBase,
    getHeadSha,
    postStatus,
    postReview,
    dismissReview,
    listReviewThreads,
    replyToReviewComment,
    resolveThread,
    unresolveThread,
    findThreadIdByCommentId,
  };
};
