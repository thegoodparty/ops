import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldDispatch, shouldDispatchReconsider, shouldDispatchReReview } from "./github";

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

describe("dispatch actions", () => {
  it("dispatches on open and ready_for_review, never on a plain push", () => {
    for (const action of ["opened", "ready_for_review"]) {
      assert.equal(shouldDispatch("pull_request", { ...prPayload("omni"), action }), true);
    }
    for (const action of ["synchronize", "edited", "reopened"]) {
      assert.equal(shouldDispatch("pull_request", { ...prPayload("omni"), action }), false);
    }
  });
});

describe("REVIEW_REPOS scope", () => {
  it("dispatches reviews for ops PRs", () => {
    assert.equal(shouldDispatch("pull_request", prPayload("ops")), true);
    assert.equal(
      shouldDispatchReReview("issue_comment", commentPayload("ops")),
      true,
    );
  });

  it("dispatches reviews for gp-pi PRs", () => {
    assert.equal(shouldDispatch("pull_request", prPayload("gp-pi")), true);
    assert.equal(
      shouldDispatchReReview("issue_comment", commentPayload("gp-pi")),
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

const reconsiderPayload = (overrides: {
  body?: string;
  type?: string;
  association?: string;
  repo?: string;
} = {}) => {
  const base = commentPayload(overrides.repo ?? "ops");
  return {
    ...base,
    comment: {
      id: 2,
      body: overrides.body ?? "delegate reconsider",
      user: { login: "dev", type: overrides.type ?? "User" },
      author_association: overrides.association ?? "MEMBER",
    },
  };
};

describe("reconsider trigger", () => {
  it("dispatches for a person with write access", () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      assert.equal(
        shouldDispatchReconsider("issue_comment", reconsiderPayload({ association })),
        true,
      );
    }
  });

  it("does not dispatch for outside commenters or bots", () => {
    for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"]) {
      assert.equal(
        shouldDispatchReconsider("issue_comment", reconsiderPayload({ association })),
        false,
      );
    }
    assert.equal(
      shouldDispatchReconsider("issue_comment", reconsiderPayload({ type: "Bot" })),
      false,
    );
  });

  it("fires only on its own line and does not also fire a re-review", () => {
    assert.equal(
      shouldDispatchReconsider("issue_comment", reconsiderPayload({ body: "please delegate reconsider this" })),
      false,
    );
    assert.equal(
      shouldDispatchReconsider("issue_comment", reconsiderPayload({ body: "Tests pass.\n\nDelegate Reconsider\n" })),
      true,
    );
    assert.equal(shouldDispatchReReview("issue_comment", reconsiderPayload()), false);
  });

  it("stays inside the review scope", () => {
    assert.equal(
      shouldDispatchReconsider("issue_comment", reconsiderPayload({ repo: "not-a-repo" })),
      false,
    );
  });
});
