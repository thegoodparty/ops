import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldDispatch, shouldDispatchReReview } from "./github";

const prPayload = (repo: string) => ({
  action: "opened",
  pull_request: {
    number: 1,
    draft: false,
    html_url: `https://github.com/thegoodparty/${repo}/pull/1`,
    title: "t",
    user: { login: "someone" },
    base: { ref: "main" },
    head: { sha: "abc" },
  },
  repository: { name: repo, full_name: `thegoodparty/${repo}` },
});

const commentPayload = (repo: string) => ({
  action: "created",
  issue: {
    number: 1,
    title: "t",
    html_url: `https://github.com/thegoodparty/${repo}/pull/1`,
    state: "open",
    pull_request: { html_url: `https://github.com/thegoodparty/${repo}/pull/1` },
    user: { login: "someone" },
  },
  comment: { id: 1, body: "delegate review", user: { login: "someone" } },
  repository: { name: repo, full_name: `thegoodparty/${repo}` },
});

describe("REVIEW_REPOS scope", () => {
  it("dispatches reviews for ops PRs", () => {
    assert.equal(shouldDispatch("pull_request", prPayload("ops")), true);
    assert.equal(
      shouldDispatchReReview("issue_comment", commentPayload("ops")),
      true,
    );
  });

  it("does not dispatch for repos outside the review scope", () => {
    assert.equal(shouldDispatch("pull_request", prPayload("not-a-repo")), false);
    assert.equal(
      shouldDispatchReReview("issue_comment", commentPayload("not-a-repo")),
      false,
    );
  });
});
