const BASE_URL = "https://api.github.com";
const GRAPHQL_URL = "https://api.github.com/graphql";

const parseLinkNext = (header: string | null): string | undefined => {
  if (!header) return undefined;
  const match = header.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1];
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

    const commentsRes = await doFetch(
      "GET",
      `${BASE_URL}/repos/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments`,
    );
    const rawComments = (await commentsRes.json()) as Array<{
      id: number;
      path: string;
      line: number | null;
    }>;

    return {
      reviewId,
      comments: rawComments.map((c) => ({ id: c.id, path: c.path, line: c.line })),
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
                comments(first: 1) {
                  nodes { databaseId body path line }
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
          });
        }
      }
      hasNext = page.pageInfo.hasNextPage;
      after = page.pageInfo.endCursor;
    }

    return threads;
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
    getHeadSha,
    postStatus,
    postReview,
    dismissReview,
    listReviewThreads,
    resolveThread,
    unresolveThread,
    findThreadIdByCommentId,
  };
};
