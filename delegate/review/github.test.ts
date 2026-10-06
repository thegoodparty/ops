import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGitHub } from "./github";

type MockCall = {
  url: string;
  method: string;
  body?: unknown;
  headers: Record<string, string>;
};

type MockResponse = {
  status: number;
  body: unknown;
  linkHeader?: string;
};

const createMockFetch = (responses: MockResponse[]) => {
  const calls: MockCall[] = [];
  let idx = 0;

  const mockFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const resp = responses[idx++];
    if (!resp) throw new Error(`Unexpected fetch call #${idx} to ${url}`);
    const responseHeaders = new Headers({ "content-type": "application/json" });
    if (resp.linkHeader) responseHeaders.set("link", resp.linkHeader);
    calls.push({
      url: url.toString(),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers: responseHeaders,
    });
  };

  return { mockFetch, calls };
};

const TOKEN = "test-token";
const REPO = "acme/my-repo";
const PR = 42;

describe("createGitHub", () => {
  it("getPull sends correct headers", async () => {
    const { mockFetch, calls } = createMockFetch([
      {
        status: 200,
        body: {
          head: { sha: "headsha" },
          base: { sha: "basesha", ref: "main" },
          title: "My PR",
          body: "description",
          user: { login: "alice" },
          draft: false,
        },
      },
      { status: 200, body: [] },
    ]);
    const gh = createGitHub(TOKEN, mockFetch);
    await gh.getPull(REPO, PR);

    assert.equal(calls[0].headers["Authorization"], "Bearer test-token");
    assert.equal(calls[0].headers["Accept"], "application/vnd.github+json");
    assert.equal(calls[0].headers["X-GitHub-Api-Version"], "2022-11-28");
  });

  it("getPull fetches PR metadata and files in one page", async () => {
    const { mockFetch } = createMockFetch([
      {
        status: 200,
        body: {
          head: { sha: "abc123" },
          base: { sha: "def456", ref: "main" },
          title: "My PR",
          body: null,
          user: { login: "bob" },
          draft: true,
        },
      },
      {
        status: 200,
        body: [{ filename: "src/a.ts" }, { filename: "src/b.ts" }],
      },
    ]);
    const gh = createGitHub(TOKEN, mockFetch);
    const result = await gh.getPull(REPO, PR);

    assert.equal(result.headSha, "abc123");
    assert.equal(result.baseSha, "def456");
    assert.equal(result.baseRef, "main");
    assert.equal(result.title, "My PR");
    assert.equal(result.body, "");
    assert.equal(result.author, "bob");
    assert.equal(result.isDraft, true);
    assert.deepEqual(result.changedFiles, ["src/a.ts", "src/b.ts"]);
  });

  it("getPull paginates files via Link header", async () => {
    const page1Url = `https://api.github.com/repos/${REPO}/pulls/${PR}/files?per_page=100`;
    const page2Url = `https://api.github.com/repos/${REPO}/pulls/${PR}/files?per_page=100&page=2`;

    const { mockFetch, calls } = createMockFetch([
      {
        status: 200,
        body: {
          head: { sha: "h1" },
          base: { sha: "b1", ref: "main" },
          title: "T",
          body: "b",
          user: { login: "u" },
          draft: false,
        },
      },
      {
        status: 200,
        body: Array.from({ length: 100 }, (_, i) => ({ filename: `file${i}.ts` })),
        linkHeader: `<${page2Url}>; rel="next"`,
      },
      {
        status: 200,
        body: [{ filename: "last.ts" }],
      },
    ]);

    const gh = createGitHub(TOKEN, mockFetch);
    const result = await gh.getPull(REPO, PR);

    assert.equal(calls[1].url, page1Url);
    assert.equal(calls[2].url, page2Url);
    assert.equal(result.changedFiles.length, 101);
    assert.equal(result.changedFiles[0], "file0.ts");
    assert.equal(result.changedFiles[100], "last.ts");
  });

  it("getHeadSha returns PR head sha", async () => {
    const { mockFetch } = createMockFetch([
      {
        status: 200,
        body: { head: { sha: "deadbeef" } },
      },
    ]);
    const gh = createGitHub(TOKEN, mockFetch);
    const sha = await gh.getHeadSha(REPO, PR);
    assert.equal(sha, "deadbeef");
  });

  it("postStatus sends correct body with context pr-reviewer", async () => {
    const { mockFetch, calls } = createMockFetch([{ status: 201, body: {} }]);
    const gh = createGitHub(TOKEN, mockFetch);
    await gh.postStatus(REPO, "somesha", {
      state: "pending",
      description: "Review in progress",
      targetUrl: "https://logs.example.com",
    });

    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, `https://api.github.com/repos/${REPO}/statuses/somesha`);
    assert.deepEqual(calls[0].body, {
      state: "pending",
      description: "Review in progress",
      target_url: "https://logs.example.com",
      context: "pr-reviewer",
    });
  });

  it("postStatus omits target_url when not provided", async () => {
    const { mockFetch, calls } = createMockFetch([{ status: 201, body: {} }]);
    const gh = createGitHub(TOKEN, mockFetch);
    await gh.postStatus(REPO, "somesha", { state: "success", description: "Done" });

    const body = calls[0].body as Record<string, unknown>;
    assert.equal("target_url" in body, false);
    assert.equal(body.context, "pr-reviewer");
  });

  it("postReview posts the review, then matches its comments from the PR-wide endpoint", async () => {
    const { mockFetch, calls } = createMockFetch([
      { status: 200, body: { id: 99 } },
      {
        status: 200,
        body: [
          { id: 1001, path: "src/foo.ts", line: 5, original_line: 5, pull_request_review_id: 99 },
          { id: 1002, path: "src/bar.ts", line: null, original_line: 12, pull_request_review_id: 99 },
          { id: 900, path: "src/old.ts", line: 1, original_line: 1, pull_request_review_id: 42 },
        ],
      },
    ]);

    const gh = createGitHub(TOKEN, mockFetch);
    const result = await gh.postReview(REPO, PR, {
      commitId: "abc",
      event: "COMMENT",
      body: "Review body",
      comments: [{ path: "src/foo.ts", line: 5, body: "Looks suspicious" }],
    });

    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, `https://api.github.com/repos/${REPO}/pulls/${PR}/reviews`);
    assert.deepEqual(calls[0].body, {
      commit_id: "abc",
      event: "COMMENT",
      body: "Review body",
      comments: [{ path: "src/foo.ts", line: 5, body: "Looks suspicious" }],
    });

    assert.equal(calls[1].method, "GET");
    assert.equal(
      calls[1].url,
      `https://api.github.com/repos/${REPO}/pulls/${PR}/comments?per_page=100`,
    );

    assert.equal(result.reviewId, 99);
    assert.deepEqual(result.comments, [
      { id: 1001, path: "src/foo.ts", line: 5 },
      { id: 1002, path: "src/bar.ts", line: 12 },
    ]);
  });

  it("dismissReview sends PUT with message", async () => {
    const { mockFetch, calls } = createMockFetch([{ status: 200, body: {} }]);
    const gh = createGitHub(TOKEN, mockFetch);
    await gh.dismissReview(REPO, PR, 77, "Superseded by re-review");

    assert.equal(calls[0].method, "PUT");
    assert.equal(
      calls[0].url,
      `https://api.github.com/repos/${REPO}/pulls/${PR}/reviews/77/dismissals`,
    );
    assert.deepEqual(calls[0].body, { message: "Superseded by re-review" });
  });

  it("listReviewThreads sends GraphQL with owner/name split and returns threads", async () => {
    const { mockFetch, calls } = createMockFetch([
      {
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "thread1",
                      isResolved: false,
                      isOutdated: true,
                      comments: {
                        nodes: [{ databaseId: 500, body: "a bug", path: "src/x.ts", line: 10 }],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    ]);

    const gh = createGitHub(TOKEN, mockFetch);
    const threads = await gh.listReviewThreads("acme/my-repo", 7);

    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "https://api.github.com/graphql");
    const sent = calls[0].body as { variables: Record<string, unknown> };
    assert.equal(sent.variables["owner"], "acme");
    assert.equal(sent.variables["name"], "my-repo");
    assert.equal(sent.variables["number"], 7);

    assert.equal(threads.length, 1);
    assert.equal(threads[0].id, "thread1");
    assert.equal(threads[0].isOutdated, true);
    assert.equal(threads[0].firstComment.databaseId, 500);
    assert.equal(threads[0].firstComment.path, "src/x.ts");
    assert.equal(threads[0].firstComment.line, 10);
  });

  it("listReviewThreads paginates via pageInfo", async () => {
    const { mockFetch } = createMockFetch([
      {
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: true, endCursor: "cursor1" },
                  nodes: [
                    {
                      id: "t1",
                      isResolved: false,
                      isOutdated: false,
                      comments: { nodes: [{ databaseId: 1, body: "b1", path: "a.ts", line: 1 }] },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      {
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "t2",
                      isResolved: true,
                      isOutdated: false,
                      comments: { nodes: [{ databaseId: 2, body: "b2", path: "b.ts", line: 2 }] },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    ]);

    const gh = createGitHub(TOKEN, mockFetch);
    const threads = await gh.listReviewThreads(REPO, PR);
    assert.equal(threads.length, 2);
    assert.equal(threads[0].id, "t1");
    assert.equal(threads[1].id, "t2");
  });

  it("resolveThread sends resolveReviewThread mutation with threadId", async () => {
    const { mockFetch, calls } = createMockFetch([
      {
        status: 200,
        body: { data: { resolveReviewThread: { thread: { id: "thread1" } } } },
      },
    ]);
    const gh = createGitHub(TOKEN, mockFetch);
    await gh.resolveThread("thread1");

    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "https://api.github.com/graphql");
    const sent = calls[0].body as { query: string; variables: Record<string, unknown> };
    assert.ok(sent.query.includes("resolveReviewThread"));
    assert.equal(sent.variables["threadId"], "thread1");
  });

  it("unresolveThread sends unresolveReviewThread mutation with threadId", async () => {
    const { mockFetch, calls } = createMockFetch([
      {
        status: 200,
        body: { data: { unresolveReviewThread: { thread: { id: "thread2" } } } },
      },
    ]);
    const gh = createGitHub(TOKEN, mockFetch);
    await gh.unresolveThread("thread2");

    const sent = calls[0].body as { query: string; variables: Record<string, unknown> };
    assert.ok(sent.query.includes("unresolveReviewThread"));
    assert.equal(sent.variables["threadId"], "thread2");
  });

  it("findThreadIdByCommentId returns thread id for matching comment", () => {
    const gh = createGitHub(TOKEN, async () => new Response("", { status: 200 }));
    const threads = [
      { id: "t1", firstComment: { databaseId: 100 } },
      { id: "t2", firstComment: { databaseId: 200 } },
    ];
    assert.equal(gh.findThreadIdByCommentId(threads, 200), "t2");
    assert.equal(gh.findThreadIdByCommentId(threads, 999), undefined);
  });

  it("non-2xx response throws error with method, url, status and body excerpt", async () => {
    const { mockFetch } = createMockFetch([
      { status: 404, body: { message: "Not Found" } },
    ]);
    const gh = createGitHub(TOKEN, mockFetch);
    await assert.rejects(
      () => gh.getHeadSha(REPO, PR),
      (err: Error) => {
        assert.ok(err.message.includes("GET"));
        assert.ok(err.message.includes("404"));
        return true;
      },
    );
  });

  it("GraphQL error in response body throws", async () => {
    const { mockFetch } = createMockFetch([
      {
        status: 200,
        body: { errors: [{ message: "Field does not exist" }] },
      },
    ]);
    const gh = createGitHub(TOKEN, mockFetch);
    await assert.rejects(
      () => gh.listReviewThreads(REPO, PR),
      (err: Error) => {
        assert.ok(err.message.includes("GraphQL errors"));
        return true;
      },
    );
  });
});
