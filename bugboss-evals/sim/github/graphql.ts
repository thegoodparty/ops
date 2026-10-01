import { buildSchema, graphql, GraphQLError } from "graphql";

import { resolve } from "./git";
import { ApiError, now, type Pull, type Repo, type Run, type Store } from "./store";

/**
 * The GraphQL subset gh 2.96.0 and the Boss send, as a real schema, so a
 * field nobody added fails loudly instead of coming back empty. Sources, at
 * cli/cli v2.96.0: api/queries_repo.go (RepositoryInfo, RepositoryNetwork),
 * pkg/cmd/pr/shared/finder.go (PullRequestByNumber, PullRequestForBranch),
 * api/query_builder.go (the PR fields and the statusCheckRollup fragments),
 * api/queries_pr.go (PullRequestCreate), api/queries_comments.go
 * (CommentCreate), pkg/cmd/pr/checks/checks.go (PullRequestStatusChecks),
 * internal/featuredetection (introspection); the Boss's ROLLUP_QUERY in
 * bugboss/agent/conditions.ts.
 */
const SDL = `
scalar DateTime
scalar URI
scalar GitObjectID
interface Node { id: ID! }
interface Actor { login: String! avatarUrl: URI url: URI }
interface RepositoryOwner { id: ID! login: String! }
type User implements Node & Actor & RepositoryOwner { id: ID! login: String! name: String databaseId: Int avatarUrl: URI url: URI }
type Bot implements Node & Actor { id: ID! login: String! avatarUrl: URI url: URI }
type Organization implements Node & RepositoryOwner { id: ID! login: String! name: String }
type PageInfo { hasNextPage: Boolean! hasPreviousPage: Boolean! endCursor: String startCursor: String }
type Ref { name: String! prefix: String! }
enum RepositoryPermission { ADMIN MAINTAIN WRITE TRIAGE READ }
enum PullRequestState { OPEN CLOSED MERGED }
enum IssueOrderField { CREATED_AT UPDATED_AT COMMENTS }
enum OrderDirection { ASC DESC }
input IssueOrder { field: IssueOrderField! direction: OrderDirection! }
enum MergeableState { MERGEABLE CONFLICTING UNKNOWN }
enum MergeStateStatus { BEHIND BLOCKED CLEAN DIRTY DRAFT HAS_HOOKS UNKNOWN UNSTABLE }
enum PullRequestReviewDecision { APPROVED CHANGES_REQUESTED REVIEW_REQUIRED }
enum PullRequestReviewState { PENDING COMMENTED APPROVED CHANGES_REQUESTED DISMISSED }
enum CommentAuthorAssociation { COLLABORATOR CONTRIBUTOR FIRST_TIMER FIRST_TIME_CONTRIBUTOR MANNEQUIN MEMBER NONE OWNER }
enum ReactionContent { THUMBS_UP THUMBS_DOWN LAUGH HOORAY CONFUSED HEART ROCKET EYES }
enum PatchStatus { ADDED CHANGED COPIED DELETED MODIFIED RENAMED }
enum StatusState { ERROR EXPECTED FAILURE PENDING SUCCESS }
enum CheckStatusState { COMPLETED IN_PROGRESS PENDING QUEUED REQUESTED WAITING }
enum CheckConclusionState { ACTION_REQUIRED CANCELLED FAILURE NEUTRAL SKIPPED STALE STARTUP_FAILURE SUCCESS TIMED_OUT }
enum CheckRunState { ACTION_REQUIRED CANCELLED COMPLETED FAILURE IN_PROGRESS NEUTRAL PENDING QUEUED SKIPPED STALE STARTUP_FAILURE SUCCESS TIMED_OUT WAITING }
type ReactorConnection { totalCount: Int! }
type ReactionGroup { content: ReactionContent! users: ReactorConnection! }
type Repository implements Node {
  id: ID! name: String! nameWithOwner: String! owner: RepositoryOwner! url: URI! description: String
  isPrivate: Boolean! hasIssuesEnabled: Boolean! hasWikiEnabled: Boolean! viewerPermission: RepositoryPermission
  defaultBranchRef: Ref parent: Repository mergeCommitAllowed: Boolean! rebaseMergeAllowed: Boolean! squashMergeAllowed: Boolean!
  pullRequest(number: Int!): PullRequest
  pullRequests(first: Int, last: Int, after: String, before: String, states: [PullRequestState!], headRefName: String, baseRefName: String, labels: [String!], orderBy: IssueOrder): PullRequestConnection!
}
type PullRequestConnection { nodes: [PullRequest] totalCount: Int! pageInfo: PageInfo! }
type PullRequest implements Node {
  id: ID! number: Int! url: URI! title: String! body: String! state: PullRequestState! closed: Boolean! isDraft: Boolean!
  createdAt: DateTime! updatedAt: DateTime! closedAt: DateTime mergedAt: DateTime author: Actor mergedBy: Actor
  baseRefName: String! baseRefOid: GitObjectID! headRefName: String! headRefOid: GitObjectID!
  isCrossRepository: Boolean! headRepositoryOwner: RepositoryOwner headRepository: Repository repository: Repository!
  maintainerCanModify: Boolean! mergeable: MergeableState! mergeStateStatus: MergeStateStatus!
  mergeCommit: Commit potentialMergeCommit: Commit additions: Int! deletions: Int! changedFiles: Int!
  reviewDecision: PullRequestReviewDecision fullDatabaseId: String
  commits(first: Int, last: Int, after: String): PullRequestCommitConnection!
  comments(first: Int, last: Int, after: String): IssueCommentConnection!
  reviews(first: Int, last: Int, after: String): PullRequestReviewConnection
  latestReviews(first: Int, last: Int, after: String): PullRequestReviewConnection
  files(first: Int, last: Int, after: String): PullRequestChangedFileConnection
}
type PullRequestCommit implements Node { id: ID! commit: Commit! }
type PullRequestCommitConnection { nodes: [PullRequestCommit] totalCount: Int! pageInfo: PageInfo! }
type GitActor { name: String email: String date: DateTime user: User }
type GitActorConnection { nodes: [GitActor] totalCount: Int! }
type Commit implements Node {
  id: ID! oid: GitObjectID! url: URI! message: String! messageHeadline: String! messageBody: String!
  committedDate: DateTime! authoredDate: DateTime! authors(first: Int): GitActorConnection! statusCheckRollup: StatusCheckRollup
}
type StatusCheckRollup { state: StatusState! contexts(first: Int, last: Int, after: String): StatusCheckRollupContextConnection! }
union StatusCheckRollupContext = CheckRun | StatusContext
type CheckRunStateCount { state: CheckRunState! count: Int! }
type StatusContextStateCount { state: StatusState! count: Int! }
type StatusCheckRollupContextConnection {
  nodes: [StatusCheckRollupContext] totalCount: Int! pageInfo: PageInfo!
  checkRunCount: Int! checkRunCountsByState: [CheckRunStateCount!] statusContextCount: Int! statusContextCountsByState: [StatusContextStateCount!]
}
type Workflow { name: String! }
type WorkflowRun { databaseId: Int event: String! runNumber: Int! url: URI! workflow: Workflow! }
type CheckSuite { workflowRun: WorkflowRun }
type CheckRun implements Node {
  id: ID! databaseId: Int name: String! status: CheckStatusState! conclusion: CheckConclusionState
  startedAt: DateTime completedAt: DateTime detailsUrl: URI checkSuite: CheckSuite isRequired(pullRequestId: ID, pullRequestNumber: Int): Boolean!
}
type StatusContext implements Node {
  id: ID! context: String! state: StatusState! targetUrl: URI description: String createdAt: DateTime! isRequired(pullRequestId: ID, pullRequestNumber: Int): Boolean!
}
type IssueComment implements Node {
  id: ID! databaseId: Int author: Actor authorAssociation: CommentAuthorAssociation! body: String! createdAt: DateTime!
  includesCreatedEdit: Boolean! isMinimized: Boolean! minimizedReason: String reactionGroups: [ReactionGroup!] url: URI! viewerDidAuthor: Boolean!
}
type IssueCommentConnection { nodes: [IssueComment] totalCount: Int! pageInfo: PageInfo! }
type IssueCommentEdge { cursor: String! node: IssueComment }
type PullRequestReview implements Node {
  id: ID! databaseId: Int author: Actor authorAssociation: CommentAuthorAssociation! body: String! state: PullRequestReviewState!
  submittedAt: DateTime commit: Commit reactionGroups: [ReactionGroup!]
}
type PullRequestReviewConnection { nodes: [PullRequestReview] totalCount: Int! pageInfo: PageInfo! }
type PullRequestChangedFile { path: String! additions: Int! deletions: Int! changeType: PatchStatus! }
type PullRequestChangedFileConnection { nodes: [PullRequestChangedFile] totalCount: Int! pageInfo: PageInfo! }
input CreatePullRequestInput {
  repositoryId: ID! baseRefName: String! headRefName: String! headRepositoryId: ID title: String! body: String
  maintainerCanModify: Boolean draft: Boolean clientMutationId: String
}
type CreatePullRequestPayload { clientMutationId: String pullRequest: PullRequest }
input AddCommentInput { subjectId: ID! body: String! clientMutationId: String }
type AddCommentPayload { clientMutationId: String commentEdge: IssueCommentEdge subject: Node }
type Query { viewer: User! repository(owner: String!, name: String!, followRenames: Boolean): Repository node(id: ID!): Node }
type Mutation {
  createPullRequest(input: CreatePullRequestInput!): CreatePullRequestPayload
  addComment(input: AddCommentInput!): AddCommentPayload
}
`;

const schema = buildSchema(SDL);

export const BOT_LOGIN = "bugboss-gp[bot]";
const bot = { __typename: "Bot", id: "BOT_1", login: BOT_LOGIN, avatarUrl: null, url: `https://github.com/apps/bugboss-gp` };
const viewer = { __typename: "User", id: "U_1", login: BOT_LOGIN, name: null, databaseId: 1, avatarUrl: null, url: null };

const b64 = (s: string) => Buffer.from(s).toString("base64url");
export const repoId = (r: Repo) => `R_${b64(`${r.owner}/${r.name}`)}`;
export const pullId = (r: Repo, p: Pull) => `PR_${b64(`${r.owner}/${r.name}#${p.number}`)}`;

type Paging = { first?: number; last?: number };
const page = <T>(items: T[], { first, last }: Paging = {}) => {
  const nodes = first !== undefined ? items.slice(0, first) : last !== undefined ? items.slice(Math.max(0, items.length - last)) : items;
  return { nodes, totalCount: items.length, pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null } };
};

const ROLLUP_STATE = (run: Run) => (run.status !== "completed" ? "PENDING" : run.conclusion === "success" ? "SUCCESS" : "FAILURE");

const fail = (e: unknown): never => {
  if (e instanceof ApiError) throw new GraphQLError(e.message, { extensions: { type: e.status === 404 ? "NOT_FOUND" : "UNPROCESSABLE" } });
  throw e;
};

export const createGraphQL = (store: Store) => {
  const latestRun = (r: Repo, sha: string) => r.runs.filter((run) => run.sha === sha).sort((a, b) => b.id - a.id)[0];

  const checkRun = (r: Repo, run: Run) => ({
    __typename: "CheckRun",
    id: `CR_${run.id}`,
    databaseId: run.id,
    name: "checks",
    status: run.status.toUpperCase(),
    conclusion: run.conclusion?.toUpperCase() ?? null,
    startedAt: run.run_started_at,
    completedAt: run.status === "completed" ? run.updated_at : null,
    detailsUrl: `https://github.com/${r.owner}/${r.name}/actions/runs/${run.id}/job/${run.id}`,
    checkSuite: { workflowRun: { databaseId: run.id, event: "pull_request", runNumber: run.id, url: `https://github.com/${r.owner}/${r.name}/actions/runs/${run.id}`, workflow: { name: "CI" } } },
    isRequired: () => false,
  });

  const commit = (r: Repo, sha: string) => {
    const c = store.commit(r, sha);
    const [headline, ...rest] = c.message.split("\n");
    return {
      __typename: "Commit",
      id: `C_${c.sha}`,
      oid: c.sha,
      url: `https://github.com/${r.owner}/${r.name}/commit/${c.sha}`,
      message: c.message,
      messageHeadline: headline,
      messageBody: rest.join("\n").trim(),
      committedDate: c.committer.date,
      authoredDate: c.author.date,
      authors: () => page([{ name: c.author.name, email: c.author.email, date: c.author.date, user: null }]),
      statusCheckRollup: () => {
        const run = latestRun(r, c.sha);
        if (!run) return null;
        const state = run.status === "completed" ? (run.conclusion ?? "").toUpperCase() : run.status.toUpperCase();
        return {
          state: ROLLUP_STATE(run),
          contexts: (args: Paging) => ({
            ...page([checkRun(r, run)], args),
            checkRunCount: 1,
            checkRunCountsByState: [{ state, count: 1 }],
            statusContextCount: 0,
            statusContextCountsByState: [],
          }),
        };
      },
    };
  };

  const repository = (r: Repo): Record<string, unknown> => ({
    __typename: "Repository",
    id: repoId(r),
    name: r.name,
    nameWithOwner: `${r.owner}/${r.name}`,
    owner: { __typename: "Organization", id: `O_${b64(r.owner)}`, login: r.owner, name: r.owner },
    url: `https://github.com/${r.owner}/${r.name}`,
    description: null,
    isPrivate: false,
    hasIssuesEnabled: true,
    hasWikiEnabled: false,
    viewerPermission: "WRITE",
    defaultBranchRef: { name: "main", prefix: "refs/heads/" },
    parent: null,
    mergeCommitAllowed: true,
    rebaseMergeAllowed: false,
    squashMergeAllowed: true,
    pullRequest: ({ number }: { number: number }) => {
      const p = r.pulls.find((x) => x.number === number);
      if (!p) throw new GraphQLError(`Could not resolve to a PullRequest with the number of ${number}.`, { extensions: { type: "NOT_FOUND" } });
      return pull(r, p);
    },
    pullRequests: (args: Paging & { states?: string[]; headRefName?: string; baseRefName?: string; orderBy?: { direction: string } }) => {
      const list = r.pulls
        .filter((p) => !args.states?.length || args.states.includes(state(p)))
        .filter((p) => args.headRefName === undefined || p.head === args.headRefName)
        .filter((p) => args.baseRefName === undefined || p.base === args.baseRefName);
      if (args.orderBy?.direction === "DESC") list.reverse();
      return page(list.map((p) => pull(r, p)), args);
    },
  });

  const state = (p: Pull) => (p.merged_at ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED");

  const review = (r: Repo, rv: Pull["reviews"][number]) => ({
    id: `PRR_${rv.id}`,
    databaseId: rv.id,
    author: bot,
    authorAssociation: "NONE",
    body: rv.body,
    state: rv.state,
    submittedAt: rv.submitted_at,
    commit: () => (resolve(r.dir, rv.commit_id) ? commit(r, rv.commit_id) : null),
    reactionGroups: [],
  });

  const comment = (r: Repo, p: Pull, c: Pull["comments"][number]) => ({
    id: `IC_${c.id}`,
    databaseId: c.id,
    author: bot,
    authorAssociation: "NONE",
    body: c.body,
    createdAt: c.created_at,
    includesCreatedEdit: false,
    isMinimized: false,
    minimizedReason: null,
    reactionGroups: [],
    url: `https://github.com/${r.owner}/${r.name}/pull/${p.number}#issuecomment-${c.id}`,
    viewerDidAuthor: true,
  });

  const pull = (r: Repo, p: Pull) => {
    const files = () => store.files(r, store.pullBase(r, p), p.headSha);
    const merge = () => store.mergeability(r, p);
    return {
      __typename: "PullRequest",
      id: pullId(r, p),
      number: p.number,
      url: `https://github.com/${r.owner}/${r.name}/pull/${p.number}`,
      title: p.title,
      body: p.body,
      state: state(p),
      closed: p.state === "closed",
      isDraft: p.draft,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      closedAt: p.closed_at,
      mergedAt: p.merged_at,
      author: bot,
      mergedBy: p.merged_at ? bot : null,
      baseRefName: p.base,
      baseRefOid: () => p.baseAtMerge ?? resolve(r.dir, `refs/heads/${p.base}`),
      headRefName: p.head,
      headRefOid: p.headSha,
      isCrossRepository: false,
      headRepositoryOwner: { __typename: "Organization", id: `O_${b64(r.owner)}`, login: r.owner, name: r.owner },
      headRepository: () => repository(r),
      repository: () => repository(r),
      maintainerCanModify: false,
      mergeable: () => {
        const { mergeable } = merge();
        return mergeable === null ? "UNKNOWN" : mergeable ? "MERGEABLE" : "CONFLICTING";
      },
      mergeStateStatus: () => merge().state.toUpperCase(),
      mergeCommit: () => (p.merge_commit_sha ? commit(r, p.merge_commit_sha) : null),
      potentialMergeCommit: null,
      additions: () => files().reduce((n, f) => n + f.additions, 0),
      deletions: () => files().reduce((n, f) => n + f.deletions, 0),
      changedFiles: () => files().length,
      reviewDecision: null,
      fullDatabaseId: String(p.number),
      commits: (args: Paging) => page(store.commits(r, p).map((sha) => ({ id: `PRC_${sha}`, commit: commit(r, sha) })), args),
      comments: (args: Paging) => page(p.comments.map((c) => comment(r, p, c)), args),
      reviews: (args: Paging) => page(p.reviews.map((rv) => review(r, rv)), args),
      latestReviews: (args: Paging) => page(p.reviews.slice(-1).map((rv) => review(r, rv)), args),
      files: (args: Paging) =>
        page(files().map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status === "added" ? "ADDED" : f.status === "removed" ? "DELETED" : "MODIFIED" })), args),
    };
  };

  const byNodeId = (id: string): { r: Repo; p: Pull } | null => {
    if (!id.startsWith("PR_")) return null;
    const [, full, number] = /^(.+)#(\d+)$/.exec(Buffer.from(id.slice(3), "base64url").toString()) ?? [];
    const r = full ? store.repos.get(full) : undefined;
    const p = r?.pulls.find((x) => x.number === Number(number));
    return r && p ? { r, p } : null;
  };

  const root = {
    viewer,
    repository: ({ owner, name }: { owner: string; name: string }) => {
      const r = store.repos.get(`${owner}/${name}`);
      if (!r) throw new GraphQLError(`Could not resolve to a Repository with the name '${owner}/${name}'.`, { extensions: { type: "NOT_FOUND" } });
      return repository(r);
    },
    node: ({ id }: { id: string }) => {
      const found = byNodeId(id);
      return found ? pull(found.r, found.p) : null;
    },
    createPullRequest: ({ input }: { input: { repositoryId: string; baseRefName: string; headRefName: string; title: string; body?: string; draft?: boolean; clientMutationId?: string } }) => {
      const r = [...store.repos.values()].find((x) => repoId(x) === input.repositoryId);
      if (!r) throw new GraphQLError(`Could not resolve to a node with the global id of '${input.repositoryId}'.`, { extensions: { type: "NOT_FOUND" } });
      try {
        const p = store.createPull(r, { title: input.title, body: input.body, head: input.headRefName, base: input.baseRefName, draft: input.draft });
        return { clientMutationId: input.clientMutationId ?? null, pullRequest: pull(r, p) };
      } catch (e) {
        return fail(e);
      }
    },
    addComment: ({ input }: { input: { subjectId: string; body: string; clientMutationId?: string } }) => {
      const found = byNodeId(input.subjectId);
      if (!found) throw new GraphQLError(`Could not resolve to a node with the global id of '${input.subjectId}'.`, { extensions: { type: "NOT_FOUND" } });
      const at = now();
      const c = { id: store.nextId(), body: input.body, created_at: at, updated_at: at };
      found.p.comments.push(c);
      return { clientMutationId: input.clientMutationId ?? null, commentEdge: { cursor: String(c.id), node: comment(found.r, found.p, c) }, subject: pull(found.r, found.p) };
    },
  };

  return async (body: { query?: string; variables?: Record<string, unknown> | null; operationName?: string | null }) => {
    const result = await graphql({ schema, source: body.query ?? "", rootValue: root, variableValues: body.variables ?? undefined, operationName: body.operationName ?? undefined });
    return {
      ...(result.data === undefined ? {} : { data: result.data }),
      ...(result.errors ? { errors: result.errors.map((e) => ({ ...e.toJSON(), type: e.extensions?.type ?? "INVALID" })) } : {}),
    };
  };
};
