# Plan-gated merges

> **Status: proposal, first revision, under review.** The decisions in it come
> from the engineer's brief and from the existing reasoning in
> `.github/CODEOWNERS`; where I made a call of my own it is marked **decided
> here**, with the reasoning, so review can argue with the reasoning rather than
> guess at it. Exactly one thing is **open**. It is written to be reviewed line
> by line, and the revision that comes out of review becomes concrete and gets
> the usual "revised after review" status line.

The goal is that most pull requests in this repo merge on a `delegate` approval
when the change implements a plan document that is already merged to `main`.

That is a throughput goal, so it is worth saying what the throughput is being
spent on. Today every step of every plan in `docs/` is its own PR, and every one
of them needs a human code-owner approval, because `.github/CODEOWNERS` hands a
human every path by default. The human is approving an implementation they
already approved the plan for. This proposal moves that review to where the
decision actually is: the plan, once, before any code exists.

## Progress

One step at a time, one pull request per step. This is the last plan in `docs/`
whose checklist is a status, and only because it merges before step 2 moves
bookkeeping out of plan documents. After step 2 the checklist below is the spec,
frozen at merge, and status lives in ClickUp; see decision 11 and the open
question. Statuses are `todo`, `doing (who, date)`, `done (date, evidence)`, and
this list is not updated after it merges.

Ordering is the point of the order: tightening lands before any loosening, and
nothing is loosened until step 4's evals support it. Step 1 alone makes this
repo strictly harder to merge into (the bot loses the only paths it can approve
today). Nothing is made easier until step 5, and step 5 only touches paths that
step 4 measured.

- [ ] 1. `CODEOWNERS`: empty the opt-out list, removing `/docs/`,
      `/README.md`, `/.gitignore`, `/CLAUDE.md` and `**/CLAUDE.md`, and rewrite
      the commentary so the list reads as the only mechanism that grants
      `delegate` authority, empty until evals support a path. `todo`
- [ ] 2. Move progress out of plan documents: replace the convention in
      `workbench-account.md` and the bookkeeping paragraph in `sheriff.md` with
      a pointer to ClickUp, and check the four documents that point at those
      conventions. `todo`
- [ ] 3. `delegate`: the plan binding, the `main` check, the
      `CODEOWNERS`-derived authority, and flag-not-approve for each case in
      "The five cases that go to a human". Ships in a mode that cannot approve,
      so it changes no merge outcome on its own. `todo`
- [ ] 4. Evals and a flag-only shadow run: the corpus in "The corpus", a
      `gating` corpus and eval job, a new expect outcome for a flag, and
      `shadow` mode on the Pulumi trees for a few weeks, with `delegate`'s
      verdicts compared against what humans actually did. `todo`
- [ ] 5. De-own the Pulumi trees, one path at a time, only where step 4 showed
      agreement: `deploy/`, `deploy-org/`, `deploy-workbench/`,
      `deploy-infrastructure/`, and flip the mode to `enforce` in the first of
      them. `todo`

## Goal

Stated as invariants, not features:

- A PR that (a) names a plan that is merged to `main`, (b) touches only paths
  `CODEOWNERS` on `main` leaves unowned, and (c) is consistent with that plan,
  can merge on a `delegate` approval with no human code-owner behind it.
- **`delegate` can never approve a change to itself.** Not its code, not its
  prompts, not its inputs, not its own authority.
- **No single human can change the organization's security posture.** A posture
  change still requires a human other than the author, either directly or as the
  review of a plan that the bot is then bound to.
- Everything that is not in that first bullet is unchanged: a PR that does not
  satisfy all three gets a `COMMENT` and whatever approval it already needed, so
  in this repo today that means a human code owner, exactly as now.

The third invariant is the one worth arguing about, because it is the one the
proposal weakens. It survives in this form:

- The bot's authority is not its own. It is derived, per PR, from
  `CODEOWNERS` on `main`, and the only thing that can grant authority is a line
  in that file that a human merged.
- `CODEOWNERS` itself, `.github/`, `delegate/` and `docs/` stay human-owned
  permanently, so the bot cannot widen its own authority and cannot edit its own
  spec.
- The bot cannot approve a PR that touches the plan it implements, so it cannot
  be talked into a change by a plan that the PR itself softens.
- Merging still needs a non-author approval of the last push
  (`require_last_push_approval`, out of band), so a single human cannot author
  and approve a posture change alone. What changes is *who* the second actor
  may be: the bot, and only against a plan a human merged.

Stated honestly: the bot contributes no judgement of its own about whether a
change is a good idea. It converts one human review of a plan into many checks
that the code did the plan. That is a real reduction in review surface per
merge, and the compensating assumption is that a plan is reviewed harder than
an implementation step, because it is the thing the human is now trusting across
all of them. The change does not make that assumption true; it bets on it, which
is why step 4 exists.

## What this does not change

- **The ruleset.** Required approval counts and `require_last_push_approval`
  are handled out of band. Nothing here designs or changes them. For the record,
  the settings on the live `main` ruleset on `ops` that this plan relies on,
  read on 2026-10-19: one required approving review, code-owner review
  required, last-push approval required, stale reviews dismissed on push, and
  `deploy` as the only required status check. `pr-reviewer` is **not** a required status check, which is the
  decision's starting point rather than something this plan has to arrange.
- **`delegate` as a required check.** It never becomes one. A `delegate`
  outage, a broken run or a break-glass is "a human approves", not a blocked
  repository.
- **Break-glass.** `sheriff.md` already gives a human a path when tooling is
  down or wrong; this plan adds no new one and relies on it.
- **Product repos.** `delegate` reviews 18 repos (`delegate/lambdas/github.ts`,
  `REVIEW_REPOS`). This plan is scoped to repos that opt in, which initially
  means `ops`; see "Which repos this covers". An observation for whoever
  extends it: in the product repos the bot's approval already counts toward a
  required approval count today (`omni` requires one, `gp-api` ten, neither
  requires code-owner review), and this plan does not change that. It is not a
  posture repository, so it is out of scope here, but it is the reason the
  authority rule must not be applied to a repo with no `*`-owned `CODEOWNERS`
  without a separate decision.

## Where the bot's authority comes from

`.github/CODEOWNERS` on `main`, in the PR's own repo. Nothing else.

Today that file is an opt-out list under a `*` default that names
`@thegoodparty/gp-contrib`: one human-reviewed file decides
who has to approve, and the bot's approval satisfies the ruleset only on paths
the file lists with no owner. That is already the mechanism, and it is already
consistent between the two halves of a merge; the bot's role just happens to be
incidental to it. The file's own comment states the property the bot relies on
here — a pattern with no owners satisfies the code-owner half vacuously — and
`CLAUDE.md` repeats it; this plan takes that as given rather than re-deriving it
from the ruleset.

This proposal makes that relationship deliberate in both directions:

- Ownership decides whether a human is required.
- The same file decides whether the bot may approve, because "unowned on
  `main`" is the whole of its authority.

The two cannot drift because they are one file. Concretely, for each changed
path in a gated PR, the harness resolves the last matching `CODEOWNERS` pattern
and looks at whether that pattern names owners:

| `CODEOWNERS` line | Who must approve today | Who may approve after step 5 |
|---|---|---|
| a pattern with owners, e.g. `*  @thegoodparty/gp-contrib` | a human code owner | a human code owner |
| a pattern with no owners, e.g. `/docs/` (removed in step 1) | nobody required; the bot's approval is enough | the bot, if the plan binding and consistency also hold |
| no `CODEOWNERS` file, or no `*` default | whatever the ruleset says | nothing: unverifiable authority is a flag |

That last row is the trap worth naming. Of the review repos I checked, only
`ops` and `runbooks` have a `CODEOWNERS` at all, and `runbooks`' has no `*`
default. "Unowned" is not a property to
derive by absence: in a repo with no `*` line, almost every path is unowned, and
a naive rule would hand the bot the whole repository. See "Which repos this
covers".

**Fail-closed direction, and why it is cheap.** The bot parses `CODEOWNERS`
itself, which could disagree with GitHub's parser. That disagreement cannot
widen authority: GitHub enforces the file independently, so a path the bot
wrongly thinks is unowned still needs a human code-owner approval before the
merge button lights up. A parser bug costs an approval that does nothing; it
cannot cause an unsafe merge. The same is not true of the plan check, which is
why that half is the one measured in step 4.

## The plan binding

A PR states its plan explicitly, in its body, on its own line:

```
Plan: docs/sheriff.md
```

Rules, all of them deterministic and all of them enforced by the harness rather
than the model:

- The line is matched at the start of a line, `plan:` case-insensitively,
  followed by a single repo-relative path. Zero matching lines, or more than
  one, is a flag; an ambiguous binding is not a binding.
- The path must start with `docs/` and end in `.md`. A plan is documentation;
  a spec that lives in code is not a spec a reviewer can approve as one.
- The harness resolves the path at the PR's **base ref** through the GitHub
  contents API and records the blob sha. The author's `Plan:` line is a pointer
  and nothing else: the text the model is judged against comes from the base
  ref, never from the PR. If the fetch 404s, there is no plan and the PR is
  flagged.
- The base ref must be `main`. A PR against another branch is flagged, because
  "merged to `main`" is the whole of the plan's authority.

**No matching by similarity, ever.** Not by title, not by branch name, not by
changed files, not by "this looks like the sheriff plan". `delegate` picks
nothing. An unstated plan is a human's PR; a stated plan that does not exist is
a flagged PR. The failure mode we are avoiding is the bot choosing a plausible
plan and then reasoning itself into consistency with it, which is
indistinguishable from the bot having no gate at all.

## The five cases that go to a human

Every one of these is a `COMMENT`, never an `APPROVE`. The PR body of the review
says which one fired, in the same body a reader already reads for findings, and
the run record keeps the structured reason so step 4 can count them.

| # | Case | Decided by | Why it is not the bot's call |
|---|---|---|---|
| 1 | no `Plan:` binding | harness | nothing to be consistent with |
| 2 | binding is not under `docs/`, or names more than one plan | harness | the binding is a convention, and conventions must not be negotiable by the model |
| 3 | plan is absent at `main` (404, or base ref is not `main`) | harness | an unmerged plan has not been reviewed; it is a proposal, not a spec |
| 4 | PR adds or modifies anything under `docs/` | harness | the spec and the work must not move together, or a PR can authorise itself |
| 5 | change is not consistent with the plan | model, one enum | this is the only judgement in the design, and step 4 measures how often it is wrong |

Case 4 is worth spelling out because it is broader than "touches the plan it
implements". A PR that adds a *new* plan document is flagged, a PR that edits
an unrelated plan is flagged, and a PR that fixes a typo in the plan it
implements is flagged. Once `docs/` is human-owned (step 1) all of those need a
human anyway, so this adds no friction; it exists so that the rule is a property
of the harness rather than a property of GitHub's configuration, and so the eval
corpus in step 4 can test it without depending on the ruleset.

Case 5 is the one that carries risk, and it is deliberately narrow. The model
answers one question about the diff and the plan text, in a schema field of its
own, and the harness combines that with the deterministic gates. It never emits
the verdict, never sees the `CODEOWNERS` parse, and never sees the binding
validity. That split is what makes a prompt injection in the diff or the PR body
unable to manufacture authority: the worst it can do is persuade the model that
a change is consistent with a plan that a human already merged, which is the
false-approve rate step 4 measures.

## Where the check lives

Named by file, because the plan is only useful if the next PR touches the right
things. This survey is of the code as it stands today; each claim is about a
specific file, and the ones I checked by reading rather than assuming are the
ones in "What was verified".

| File | What changes |
|---|---|
| `delegate/review/gating.ts` (new) | The pure part: parse a PR body for the binding, parse `CODEOWNERS` text into ordered patterns, resolve a path to owned/unowned, and return a `GatingResult`. No network, no model, no GitHub types, so it is unit-testable and the whole deterministic half can be reasoned about without a run. |
| `delegate/review/github.ts` | One helper, `getFileAtRef(repo, path, ref)` returning `{ blobSha, text } \| undefined`, over the contents API. The worker's checkout is a depth-50 clone at the PR head (`delegate/worker/entrypoint.ts`), so `main` is not reliably present locally; the base ref has to be read from GitHub. |
| `delegate/review/bundle.ts` | `buildBundle` resolves the binding, fetches the plan at the base ref, and puts the plan path, blob sha and text on the bundle. The bundle is the agent's entire input and is persisted on the record, so a gating case is replayable as an eval case with no GitHub access. |
| `delegate/review/schema.ts` | `Bundle` gains an optional `plan: { path, blobSha, text }`. `ReviewOutputSchema` gains `planConsistency: { verdict: "consistent" \| "inconsistent" \| "unclear", reasoning }` on the `complete` branch. `ReviewRecord` gains a `gating` object: `{ mode, binding, baseRef, authority: { checked, ownedPaths, reason }, flags[] }`. All new fields optional/defaulted, so records written before this lands still parse and still replay. |
| `delegate/agents/pr-reviewer.ts` | `buildReviewPrompt` gains a `<plan>` element and the consistency instruction. The plan text gets the same treatment the diff gets: a per-run boundary token or escaping, so plan content cannot close its own element and write prompt structure. The section on findings is unchanged; findings stay authoritative and a finding still blocks on its own. |
| `delegate/review/gates.ts` | The authority gate. `decide` grows an input for the gating result and returns `comment` with a reason for each of cases 1–4, and for case 5 when the model says anything other than `consistent`. See "The comment in `gates.ts`" below. |
| `delegate/review/body.ts` | `renderBody` renders the gating line: the verdict, the binding and blob sha it was checked against, and the reason when it is a flag. A reviewer reading the PR sees why the bot did not approve without opening the run record. |
| `delegate/review/run.ts` | Wires it: build the gating result next to the bundle, pass it to `decide`, pass the mode through, record it on the record, and emit the reason in `review_posted`. |
| `delegate/review/gates.test.ts`, `bundle.test.ts`, `run.test.ts`, `body.test.ts`, `gating.test.ts` (new) | Unit tests for the parser (including a `CODEOWNERS` with no `*`, a path matched by two patterns, and a body with two `Plan:` lines), for the flag cases, and for the approve path. |

Deliberately untouched: `anchors.ts`, `match.ts`, `prompt-diff.ts`, the
subagent definitions, and the review workflow. Gating changes who may approve,
not what a review is.

### The comment in `gates.ts`

`delegate/review/gates.ts` opens with:

> Who may merge is GitHub's job (classic branch protection restricts pushes to
> main to humans). The only question left here is whether the code is clean, and
> a finding is a blocker by definition.

Under this design that stops being true, and the file should say so. GitHub
still decides mergeability, and it still decides who a code owner is. But this
module is no longer only answering "is the code clean". It answers two
questions, in this order:

1. **Is there authority to approve at all?** Deterministic: is the repo gated,
   is the base `main`, does a plan binding resolve on `main`, does every changed
   path resolve to no owner in `CODEOWNERS`, does the PR leave `docs/` alone?
2. **Is the code clean, and did it do the plan?** The existing finding gate
   unchanged, plus the model's one consistency answer.

`approve` requires both. The replacement comment should say that plainly: the
verdict is now "clean, and within the authority a merged plan grants it", that
authority is derived from `CODEOWNERS` and never asserted by the model, and that
a failure in either half is a comment rather than an error, because a comment is
what sends the PR to a human. The `Decision` type keeps `approve | comment` and
its `gates` array carries the reason strings; nothing downstream needs a new
action, which is why the change is a widening of the gate rather than a
restructuring of the poster.

## Which repos this covers

**Decided here.** Gating is enabled per repo by an explicit list in
`delegate/review/gating.ts`, starting with `thegoodparty/ops`, and a repo on that
list is also required to have a `*`-owned `CODEOWNERS` on `main`; if it does not,
every PR in it is flagged rather than approved. Repos not on the list keep
today's behaviour.

The alternative, "gate every repo and derive authority wherever a `CODEOWNERS`
exists", is rejected because of what `runbooks` looks like: a `CODEOWNERS` with
a handful of owned paths, no `*` default, and therefore almost everything
"unowned". A repo would gain the bot as an approver by accident, not by a
decision, and the failure would look exactly like a correct configuration. An
explicit list costs one line per repo and makes adoption a reviewed change to
`delegate/` rather than a side effect of editing an unrelated file.

The list is not a second source of *authority* — it cannot make an owned path
approvable, because the ownership check still runs. It is only the set of repos
that have adopted this proposal, and it lives in a human-owned file, so the
worst it can do is be too small.

## Evals: what confidence means here

The consistency judgement is a model's, so no amount of testing proves the
property. What the evals measure is a rate: over a fixed corpus of cases with a
known right answer, how often does the gate approve something it should have
flagged, and how often does it flag something it should have approved. Those are
reported separately and they are not equally bad.

- **False approve** is the security number. It is a case that should have gone
  to a human and did not. Step 5 does not happen on the strength of a good
  false-flag rate.
- **False flag** is the cost number. It sends work to a human who did not need
  to see it. A high false-flag rate does not make the design unsafe; it makes it
  pointless, and it trains people to ignore the flag.

Neither number is a proof. The honest claim a run of this suite supports is "on
these N cases, the gate behaved as intended", and the document should not be
read as claiming more than that.

### The corpus

The corpus is the eight cases named below. They are built as simulated PRs, not
snapshots of production runs: `delegate/review/eval/expect.ts` already supports a
case that is a bundle plus a diff, committed locally with a fixed author and
date so its head sha is reproducible, and every one of these cases is defined by
its inputs rather than by a review someone once got. They live in a `gating/`
directory beside `expected/`, in the same manifest shape, and run through the
same replay and scoring code.

| Case | Input | Passes when |
|---|---|---|
| no plan binding | a clean PR against a gated repo, no `Plan:` line | flag `no_binding` |
| a new plan document | PR adds `docs/<new>.md` and names it | flag `touches_docs` |
| a modified plan document | PR edits an existing plan under `docs/` | flag `touches_docs` |
| a plan not yet on `main` | `Plan:` names a path that 404s at `main` | flag `plan_not_on_main` |
| change inconsistent with an approved plan | plan says one component; the diff rewrites a different one | flag `inconsistent` |
| change consistent with an approved plan | the plan's next step, its files, nothing else | approve |
| a PR touching the plan it implements | diff and plan edit in one PR | flag `touches_docs` |
| a commit pushed after approval | an approval recorded at sha A, then a push to sha B | the B run never approves on A's authority: either it approves only after its own consistency judgement at B, or it flags. `require_last_push_approval` is what makes A's approval not count; the case pins that the bot does not reintroduce it. |

`ExpectSchema` in `expect.ts` currently has two outcomes, `approve` and `block`.
A flag is a third: `{ verdict: "flag", reason: <gate name> }`, passing when the
review event is `COMMENT` and the named gate fired. That needs one more field on
the replay result, because the agent's output alone cannot distinguish a flag
from a comment: `Result` gains the gating verdict, `replay.ts` records it, and
the scorer reads it. It is a small, testable extension, and it is what makes the
false-approve and false-flag counts mechanical instead of a judgement about a
comment.

Cost, from the eval README's own numbers: a replay is roughly $1–5 per case, so
eight new cases cost on the order of $10–40 per run plus a few dollars of
judging. That is cheap enough to run on every change to `delegate/review/`, and
it should be, because the gate itself is now part of what a review can trust.

### Shadow mode

`shadow` is a deployment mode, not a code path that has to be trusted: the
harness computes the entire gating decision, records it, and then posts a
`COMMENT` regardless. It changes no merge outcome by construction, which is what
makes it safe to run against real PRs for weeks before anything is loosened.

- One env var, `DELEGATE_GATING_MODE`, read in `delegate/review/run.ts`, set in
  the worker task definition (`deploy/components/worker.ts`, next to
  `REVIEW_BUCKET`). Values are `off`, `shadow` and `enforce`; the default in code
  is `off`, so a missing variable cannot loosen anything, and the deployed value
  is a `deploy/` change, which is human-owned, which is right for a switch that
  decides whether the bot can merge.
- The record carries the mode in `gating.mode`, so a run under `shadow` is
  distinguishable from a run under `enforce` after the fact, and the eval
  analysis can filter to it.
- The review body says it in shadow explicitly ("shadow: would have approved
  against `docs/x.md` at `<sha7>`"), because a silent dry run produces an
  argument in a PR thread about whether the bot meant it.

**What the comparison is.** In shadow the bot never approves, so "compared
against what humans actually did" means: for each shadow-reviewed PR, what did
the human do, and what would the bot have done. A would-approve that a human
asked to change, or that the author closed, is a false approve. A would-flag
that a human merged unchanged is a false flag. Both are read from the review
history of the PR, which is already in the records the eval replay reads from
(`s3://delegate-reviews`) plus what `gh` returns. The result of each week's read
goes in the ClickUp epic (step 2), not in a `docs/` file, which is the point of
moving progress out.

**Duration.** A few weeks, and specifically until each of the four Pulumi trees
has been seen enough times to have a rate rather than an anecdote. There is no
calendar date to hit and no reason to shorten it: shadow costs nothing but the
reading, and step 5 is per path, so the trees that agree early can go early
while the ones that do not stay owned.

### The bar for step 5

A path is de-owned when, in the shadow window, `delegate` produced no
false approve on PRs touching it, and its false-flag rate on that path is low
enough that a human would not start merging around the bot. "Low enough" is a
judgement made on the numbers at the time, not a number picked now; picking it
now would be a number chosen before any of the evidence exists. What is decided
now is that a single false approve on a path blocks de-owning that path, and
that the rates are recorded where the next reader can see them.

## De-owning the Pulumi trees, one path at a time

Each of `deploy/`, `deploy-org/`, `deploy-workbench/` and `deploy-infrastructure/`
is its own PR, and each PR changes only its own line plus the places that
describe it:

- `.github/CODEOWNERS`: one line removed from the opt-out list, and the
  commentary updated to say which path was de-owned, on what evidence, and when.
  This is the record; there is no other.
- `CLAUDE.md`: the "Review and approval" section, whose list of paths that need
  a human is now wrong. `docs/` is human-owned after step 1, which is why this
  edit rides in the same PR as the de-owning rather than needing its own: both
  are human-reviewed anyway.
- `delegate/lambdas/github.ts`: the `ops` comment on `REVIEW_REPOS`, which says
  the bot's approval "can merge" here because of the opt-out list. After step 1
  it cannot merge anything in `ops`; after step 5 it can merge the de-owned
  trees. Step 1's PR should fix the comment's present tense; step 5's PRs
  should not touch it again, because by then the sentence should be
  path-independent.

Each of these PRs needs a human code owner, by construction, and that is not a
wart. De-owning a path *is* a security posture change, so the invariant in the
goal holds: no single human does it alone, because `CODEOWNERS` owns the change
to `CODEOWNERS`.

## Decisions

1. **Plan documents live in `docs/`, and `docs/` is human-owned.** The opt-out
   entry is removed in step 1 and never comes back. The spec is the thing a
   human reviews; it cannot be a thing the bot can approve changes to, and the
   bot cannot be the author of its own instructions. This also makes the
   "touching the plan it implements" case unreachable for the bot rather than
   merely disallowed by code, and the code check stays anyway (see case 4).
2. **The root-file opt-outs come off too**, leaving the list empty. Neither
   `/README.md` nor `/.gitignore` can reach a credential, so under the file's own
   test they are de-owning candidates; they come off now rather than later
   because the list should start empty and stay empty until step 4 supports an
   entry. `/CLAUDE.md` and `**/CLAUDE.md` were removed from the review list by
   #173 because the pattern fired on routine documentation; with `docs/`
   human-owned and the bot reading `CODEOWNERS` as the authority rather than a
   summary, the argument for keeping them opted out is weaker than the argument
   for a list with nothing on it. **The list is empty until step 4's evals
   support a path**, which makes it possible to say what an entry means: a path
   the bot is allowed to merge.
3. **The opt-out list is the only mechanism that grants `delegate` authority.**
   No config file, no label, no allowlist of paths in code. This is what stops
   the two from drifting: the same human-reviewed file answers "does a human
   have to approve" and "may the bot approve", so there is no state where the
   bot's authority is broader than the ownership it was derived from. The
   per-repo adoption list in decision 12 is a scope rather than a source of
   authority: it can only shrink what the bot may approve.
4. **`.github/`, `delegate/`, `docs/`, `package.json`, `package-lock.json`,
   `tsconfig.json` and `.dockerignore` stay human-owned permanently.** They are
   the trees that define the reviewer, the pipeline and the image the reviewer's
   token runs in. `delegate/` staying owned is the second half of invariant 1:
   even if a plan said "rewrite the reviewer", the changed paths resolve to an
   owner, and the bot's approval cannot merge it. The last four are the
   `CODEOWNERS` comment's own argument — one `package.json` builds every image,
   including the worker that holds the GitHub App token — and nothing in this
   proposal changes it.
5. **`utils/` and `scripts/` stay owned.** `scripts/enable-bedrock-models.ts` is
   run under a deploy role by `deploy-workbench.yml`, and `utils/accounts.ts`
   and `utils/bedrock-models.ts` feed IAM policy ARNs. Neither is de-owning
   material under the `CODEOWNERS` test, and neither is a Pulumi tree.
6. **Only the Pulumi trees are de-owning candidates**, one at a time, after
   step 4. They are the paths where a plan's steps are the actual change and
   where the review value is highest relative to review cost.
7. **The bot derives authority from `CODEOWNERS` on `main`, per PR.** Not from a
   cached copy, not from configuration, not from the plan. Read at run time from
   the PR's base ref, and the base ref has to be `main`.
8. **The plan binding is explicit, one line, in the PR body, and resolved at the
   base ref.** No similarity matching. The harness fetches the plan; the model
   never chooses what it is judged against.
9. **The model's only contribution to the decision is one consistency enum.**
   Everything else is deterministic. This is what keeps a prompt injection from
   minting authority, and it is what makes the false-approve rate a meaningful
   number instead of a vibe.
10. **A flag is a `COMMENT`, not an error and not a failure.** The PR goes to a
    human, which is the same outcome as today for that PR. `delegate`'s status
    check is not required, so a comment costs nothing but a review request.
11. **Progress lives in ClickUp, not in plan documents.** `docs/` is human-owned
    from step 1, so a checklist update in an implementation PR would put a human
    back on every step PR, which is exactly the throughput this proposal exists
    to recover. `delegate`'s `epic` verb already creates ClickUp tasks
    (`delegate/agents/epic-agent.ts`), the credentials are already in the
    `DELEGATES` secret, and the plan document becomes a spec that is frozen
    after merge. See the open question for the shape.
12. **Gating is per repo, by explicit adoption, and `ops` first.** See "Which
    repos this covers".
13. **`off` is the default for the mode, in code.** A deployed `enforce` is a
    human-owned `deploy/` change. Nothing about a missing env var or a failed
    deploy can make the bot more able to merge, and the mode is flipped to
    `enforce` in the same PR that de-owns the first path (step 5), so the switch
    and the first thing it enables are reviewed together.
14. **The bot never re-approves across a push.** Its review is pinned to the sha
    it read; a new sha is a new run, and `require_last_push_approval` (out of
    band) is what makes an old approval stop counting. The bot does not try to
    implement that itself.

## Rejected alternatives

- **Matching PRs to plans by similarity, branch name, or changed files.** The
  bot would be choosing its own instructions. It also fails the "flag when
  unsure" requirement by construction: similarity always produces an answer, and
  a plausible wrong plan reads exactly like a right one.
- **A plan in the PR body or a plan edited by the same PR.** The author would
  supply the spec the bot is judged against, which is self-approval with extra
  steps.
- **Progress staying in `docs/` with the bot allowed to update it.** It would
  mean carving a bot-writable hole in a human-owned tree, and the hole is in the
  file that defines what the bot may do. Also, every step PR would still need a
  human, which defeats the purpose.
- **Keeping `/CLAUDE.md` opted out.** The reviewer reads it as reference and is
  told that `CODEOWNERS` is the authority, so the opt-out buys nothing, and an
  opt-out list with three entries on it is one nobody reads.
- **An allowlist of paths in code instead of `CODEOWNERS`.** Two sources of
  authority, and the one that is not reviewed as carefully wins eventually.
- **A required `delegate` status check.** It converts a bot outage into a
  repository outage, and it makes the bot load-bearing for merges it is not
  trusted to block.
- **Two approving humans on every de-owned PR.** That is the status quo with
  extra steps, and it does not address the cost this proposal is about.
- **De-owning `scripts/`, `utils/`, or the four build files.** The
  `CODEOWNERS` test — what credential can the path reach — keeps them owned, and
  the plan tree is not where they live.
- **A model that decides authority (reads `CODEOWNERS` itself and says whether
  it may approve).** Authority has to be a property of a file and a parser, not
  of a judgement, or "the bot cannot approve a change to itself" becomes a
  request rather than an invariant.

## Invariants and failure modes

- **Fail closed, always.** Every unknown is a flag: a missing binding, an
  unreadable plan, a `CODEOWNERS` with no `*`, a repo not on the list, a base
  ref that is not `main`, a model answer that is `unclear`, a schema failure.
  A failed run is an error status, never an approval (`run.ts` already behaves
  this way and this plan adds no path around it).
- **The bot cannot widen its own authority.** `CODEOWNERS`, `delegate/` and
  `docs/` are human-owned; the authority is derived from the first and the other
  two are its own machinery and spec. There is no path by which a `delegate`
  approval merges any of them.
- **The bot cannot edit its own spec.** `docs/` is human-owned, and case 4 flags
  any PR that touches it even before GitHub is consulted.
- **A bot outage is a human approval.** Nothing here makes the check required.
- **A wrong plan is a human's problem, and that is the assumption being bet
  on.** The gate proves the code did *a* plan, not that the plan was good. The
  second is what human review of `docs/` is for, and this proposal raises its
  stakes, which is why "review the plan harder" belongs in the review guidance
  when step 1 lands rather than being left implied.
- **A de-owned path can still be a credential path.** The `CODEOWNERS` test is
  about what a path can reach, and it does not stop being the test because the
  path is a Pulumi tree. `deploy/` can mint an IAM role with one `index.ts`
  import, which is the file's own example. Step 5's evidence is about the bot's
  accuracy, not about the path's sensitivity; both have to be true.
- **Stale comments and CLAUDE.md.** Three places describe the opt-out list
  today: `.github/workflows/deploy.yml`'s ordering comment,
  `delegate/lambdas/github.ts`'s review-scope comment, and `CLAUDE.md`'s
  approval section. Step 1 and step 5 each own the ones they invalidate; a plan
  that changes a rule and leaves three files describing the old one is how the
  next reader gets it wrong.

## Open question

1. **Where progress lives, and in what shape.** Decided above: out of `docs/`,
   into ClickUp, because `delegate`'s `epic` verb already creates tasks there and
   the alternative is a human on every step PR. The part I would like settled in
   review is the shape, and my recommendation is: one ClickUp epic per plan
   document, one task per numbered step parented to it, each task carrying the
   PR link and the evidence that used to be the `done (date, evidence)` clause,
   with the plan document pointing at the epic and never being edited again.
   The competing option is a GitHub issue per step, which keeps status next to
   the code and linkable from the PR — genuinely better for a reader in the
   repo — but the reviewer App token is not scoped for issue writes today and it
   would mean duplicating the epic verb's ClickUp plumbing. If the answer is
   "ClickUp, in that shape", this section becomes a decision and the document
   needs no other change.

## Implementation plan

The Progress list is the checklist; this is the detail behind each step.

1. **Empty the opt-out list.** In `.github/CODEOWNERS`, delete `/docs/`,
   `/README.md`, `/.gitignore`, `/CLAUDE.md` and `**/CLAUDE.md`, leaving `*` as
   the only rule, and rewrite the commentary: the opt-out list is now the only
   mechanism that grants `delegate` authority, it is deliberately empty, an
   entry is a security change that needs a human, and the test for adding one is
   the same test the file already states (what credential can the path reach).
   Update `CLAUDE.md`'s "Review and approval" section in the same PR: after this
   change nothing merges on a bot approval, and the section currently says
   everything does. Also fix the present tense in the `ops` comment in
   `delegate/lambdas/github.ts`, and check `deploy.yml`'s comment about the
   ordering being load-bearing for opted-out paths — it stays true, but it
   should no longer read as though there are any. Note what this PR does not
   do: it gives the bot nothing, and every path in this repo now needs a human
   code owner, including documentation.
2. **Move progress out.** In `docs/workbench-account.md`, replace the claim/push
   convention with where status lives now; in `docs/sheriff.md`, replace the
   "Bookkeeping rides in the implementation PR" paragraph, which cites
   `workbench-account.md` as the convention's home. Then read the four documents
   that point at that convention — `docs/infrastructure-account.md`,
   `docs/pr-previews.md`, `docs/deploy-role-trust.md` and
   `docs/google-group-sync.md` — and either point them at the new home or leave
   them, deliberately, with a sentence saying their existing checklists are
   historical. Create the ClickUp epic and one task per open step in the plans
   that still have work, so the migration is real rather than announced.
3. **The gate, in a mode that cannot approve.** `delegate/review/gating.ts` (new)
   plus `bundle.ts`, `schema.ts`, `github.ts`, `pr-reviewer.ts`, `gates.ts`,
   `body.ts`, `run.ts` and their tests, as in "Where the check lives". Ships with
   `DELEGATE_GATING_MODE=off` and the mode read from the env with `off` as the
   default, so the merge lands with no behaviour change and the flag is flipped
   in step 4's PR. This is the step where `gates.ts`'s header comment is
   rewritten. It is also the step where the subagents get nothing new: the
   consistency question is asked of the orchestrator, which already holds the
   plan and the diff.
4. **Evals and the shadow run.** The eight cases as simulated bundles in
   `delegate/review/eval/gating/`, with a `flag` outcome added to `expect.ts`
   (its `--manifest` flag already accepts a corpus path, so a second manifest
   needs no new runner); a `gating` job in
   `.github/workflows/delegate-eval.yml` beside the existing expected-result job,
   so a PR touching `delegate/review/` gets both. Then
   `DELEGATE_GATING_MODE=shadow` in `deploy/components/worker.ts` and the weekly
   read of would-be verdicts against what humans did. The rates go in ClickUp.
   Step 4 ends with the numbers in hand and a recommendation per Pulumi tree,
   not with a date.
5. **De-own, one path at a time.** Four PRs, each removing one line in
   `.github/CODEOWNERS` and updating the commentary and `CLAUDE.md` as above,
   each citing the shadow evidence for that path in its body. The first of the
   four also sets `DELEGATE_GATING_MODE=enforce` in
   `deploy/components/worker.ts`. That is not a formality: while the mode is
   `shadow` the bot cannot approve anything, so de-owning a path with the mode
   still off would change nothing. `enforce` is safe to set at that point for
   the same reason it is safe to set now — after step 1 every path in this repo
   resolves to an owner, so all it can do is turn approvals that never counted
   into comments — and putting it in the first de-owning PR keeps the switch and
   the first thing it enables in one review. Order within the four is by
   evidence, not by size; `deploy-infrastructure/` is the one I would expect to
   go last, because it holds the runtime that acts on the identity store and the
   break-glass tool's own Lambda.

## What was verified

The plan is worth the paper it is written on only if the touchpoints are real, so
this is the list of what I read rather than assumed, at 2026-10-19:

- `delegate/review/gates.ts` — the comment quoted above is the file's first
  paragraph, and `decide` returns `approve` iff there are no findings and
  nothing was dropped as unparseable.
- `delegate/review/bundle.ts` — `buildBundle` builds the bundle from the PR
  metadata plus `git diff` in the checkout; it reads no plan and no
  `CODEOWNERS` today. There is no `main` ref to read from in the general case.
- `delegate/worker/entrypoint.ts` — the `pr-reviewer` checkout is a `--depth=50`
  clone at the reviewed head sha; that is why the base-ref reads go through the
  API.
- `delegate/review/schema.ts` — `Bundle`, `ReviewOutputSchema` and
  `ReviewRecord` have no plan or gating field today; `ReviewRecord` already
  carries `verdict`, `action` and `gates`, which is where the flag reasons slot
  in.
- `delegate/review/run.ts` — `decide()` is called after the output parses, the
  `APPROVE`/`COMMENT` event comes from `decision.action`, the review is pinned to
  the reviewed sha, and a tip that moves during the run dismisses instead of
  approving.
- `delegate/review/body.ts` — `renderBody` is where a reason becomes visible to a
  human reading the PR.
- `delegate/review/github.ts` — `getPull`, `postReview` and `dismissReview`
  exist; there is no "read a file at a ref" helper yet.
- `delegate/lambdas/github.ts` — `REVIEW_REPOS` includes `ops` with a comment
  that already describes the opt-out mechanism and the bot approval.
- `delegate/agents/epic-agent.ts` and `delegate/framework/thread-state.ts` — the
  `epic` verb creates ClickUp tasks and records a `[phase=epic,status=…,clickup=…]`
  header, which is the plumbing the progress move reuses.
- `deploy/components/worker.ts` — the task definition's environment list is
  where `REVIEW_BUCKET` and `AGENT_VERSION` are set, so `DELEGATE_GATING_MODE`
  has a home.
- `delegate/review/eval/` — `scenarios.json` suites, `expected/manifest.json`
  with `approve`/`block` outcomes, `replay.ts` replaying a `Bundle` through the
  production prompt and agent path, and `rubric.md`, whose first priority is
  already false approve.
- `.github/CODEOWNERS` in full, and `CLAUDE.md`'s approval section, which
  describe the same rules and are the two places that would go stale first.
- The live `main` ruleset on `ops` (one approval, code-owner review required,
  last-push approval required, `deploy` as the only required status check), read
  to confirm the plan's starting point rather than to change it.
- `gh api` for `.github/CODEOWNERS` across a sample of the review repos (`omni`,
  `gp-api`, `gp-webapp`, `people-api`, `election-api`, `runbooks`, `ai-rules`,
  `gp-sdk`, `gp-pi`): only `ops` and `runbooks` have one, and `runbooks`' has no
  `*` default. That is where "Which repos this covers" comes from, and it is why
  the authority rule requires a `*` rather than inferring ownership from
  absence.
