// Everything the GitHub stand-in has seen and holds, as one JSON-shaped
// object. `GET /__control/state` returns it whole: the orchestrator's gates
// read pushes, refusals, reviews, merges and deploys from here, so a field
// name here is a contract with `sim/gates.ts`.

export interface Actor {
  login: string;
  id: number;
  type: "User" | "Bot";
}

export interface Review {
  id: number;
  nodeId: string;
  user: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  body: string;
  commitId: string;
  submittedAt: string;
}

export interface IssueComment {
  id: number;
  nodeId: string;
  user: string;
  body: string;
  createdAt: string;
}

export interface Pull {
  number: number;
  id: number;
  nodeId: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  headSha: string;
  base: string;
  /** `main` at the time the PR was opened, then at each head update. */
  baseSha: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergedAt: string | null;
  mergedBy: string | null;
  mergeCommitSha: string | null;
  closedAt: string | null;
  user: string;
  createdAt: string;
  updatedAt: string;
  reviews: Review[];
  comments: IssueComment[];
}

export interface Step {
  name: string;
  number: number;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Job {
  id: number;
  runId: number;
  runAttempt: number;
  name: string;
  /** The shell command visible CI ran, or null for a scripted verdict. */
  command: string | null;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  log: string;
  steps: Step[];
  checkRunId: number;
}

export interface WorkflowRun {
  id: number;
  nodeId: string;
  repo: string;
  workflowId: number;
  name: string;
  event: "pull_request" | "push";
  headSha: string;
  headBranch: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  runNumber: number;
  runAttempt: number;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string;
  checkSuiteId: number;
  pullNumbers: number[];
  jobs: Job[];
}

export interface CheckRun {
  id: number;
  nodeId: string;
  repo: string;
  headSha: string;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  runId: number;
  jobId: number;
}

export interface Deploy {
  sha: string;
  runId: number;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface Push {
  repo: string;
  ref: string;
  oldSha: string;
  sha: string;
  user: string;
  at: string;
}

export interface PrereceiveRefusal {
  repo: string;
  ref: string;
  sha: string;
  user: string;
  reason: string;
  at: string;
}

export interface MergeRefusal {
  repo: string;
  number: number;
  user: string;
  reason: string;
  at: string;
}

export interface Unhandled {
  method: string;
  path: string;
  at: string;
}

export interface ScriptedVerdict {
  conclusion: "success" | "failure";
  log?: string;
}

export interface CiControl {
  mode: "run" | "scripted";
  verdicts: ScriptedVerdict[];
  /** How many scripted verdicts have been used; the last one repeats. */
  used: number;
}

export interface Repo {
  fullName: string;
  id: number;
  nodeId: string;
  dir: string;
}

export interface State {
  repos: Repo[];
  pulls: Pull[];
  workflowRuns: WorkflowRun[];
  checkRuns: CheckRun[];
  deploys: Deploy[];
  pushes: Push[];
  prereceiveRefusals: PrereceiveRefusal[];
  mergeRefusals: MergeRefusal[];
  tokensMinted: number;
  ci: CiControl;
  /** The mechanical reviewer has requested changes once already. */
  reviewerRequestedChanges: boolean;
  unhandled: Unhandled[];
  nextId: number;
  nextPullNumber: Record<string, number>;
}

export const emptyState = (ci: CiControl): State => ({
  repos: [],
  pulls: [],
  workflowRuns: [],
  checkRuns: [],
  deploys: [],
  pushes: [],
  prereceiveRefusals: [],
  mergeRefusals: [],
  tokensMinted: 0,
  ci,
  reviewerRequestedChanges: false,
  unhandled: [],
  nextId: 1000,
  nextPullNumber: {},
});
