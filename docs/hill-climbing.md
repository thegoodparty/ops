# Hill-climbing the delegate reviewer

How to make the delegate PR reviewer better, one measured prompt change at a time, by asking the Delegate swarm in Slack. A person always reviews and merges the result.

The mechanics live elsewhere: the eval and gate in [`delegate/review/eval/README.md`](../delegate/review/eval/README.md), the loop the swarm follows in [`.claude/skills/hill-climb/SKILL.md`](../.claude/skills/hill-climb/SKILL.md), and the swarm's permissions in [`agent-swarm/README.md`](../agent-swarm/README.md#hill-climb-permissions). This page is the how-to.

## When to climb

- The reviewer blocked a correct PR, or missed a real bug, and the case is in the expected-result suite.
- The last gate's `gate.json` shows a tune case main fails.
- A reviewer change of your own needs evidence before it merges (run the skill locally instead, see the end).

If the PR isn't a case yet, add it first: `npm run -s review:mine` finds candidates, and a human labels them. The swarm never adds or edits cases.

## What it can and can't fix

It can only change prompt text in `delegate/agents/pr-reviewer.ts` and `pr-reviewer-subagents.ts`: the scout, the lenses, the deep-reviewer and the orchestrator. The workflow refuses a branch that changes anything else.

It can't fix:

- A bug only visible by running the code (gp-pi-57 is the example). Relabel or park the case instead.
- Holdout cases. Nobody tuning sees which ones fail, by design. A person decides whether a failing holdout case is mislabeled, belongs in tune, or is a real gap.
- Anything structural: tools, schema, scoring, the gate. Those are a human-authored PR.

## Start a climb

Mention Delegate in a channel it's in. Name the target cases, the budget, and what you know about why they fail:

```
@delegate hill-climb the delegate PR reviewer, budget $200, targets <case-id> and <case-id>. Read .claude/skills/hill-climb/SKILL.md and targets/delegate-pr-reviewer.json from your ops checkout at main first. <one line per case: what goes wrong>. Dispatched runs only, prompt text only, up to 3 ideas, one dispatch at a time, at most one PR, never merge.
```

Name targets yourself. With none, the swarm picks failing tune cases from the newest gate run made since main last changed a reviewer prompt, and skips cases that are flaky on main. Right after a reviewer PR merges there is no such run, so it finds nothing.

The one-line hint per case saves a lot of money. Say whether the scout never raised the problem, or a deep-reviewer raised it and dropped it; a run's `leads` show which.

## What happens

1. Delegate makes a run id (`delegate-pr-reviewer-<date>-<4 chars>`) and a branch `delegate-optimize/<run_id>-<n>` per idea.
2. **Inner loop.** It dispatches `delegate-eval-run.yml` in `inner` mode on the target cases, about $4 per case per run, and amends the idea until the targets pass or it drops the idea.
3. **Gate.** It dispatches `gate` mode: every tune and holdout case, 3 runs each, against main. About $170. It passes only with no regressions, every target 3/3, no holdout regressions, and cost within 10% of main.
4. **PR.** If the gate passes, it opens one PR with the gate table, holdout counts, cost and the ideas it tried. If nothing passes, it reports what it tried and opens nothing.

It works one dispatch at a time, and a climb takes a few hours, mostly the gate.

## Watch, stop, budget

- Progress shows in the Slack thread and in Actions under `delegate-eval-run`.
- To stop, ask Delegate in the thread. The hard stop is cancelling the run in Actions. Nothing merges either way.
- The budget is per run id, enforced by a ledger in S3. The lowest budget ever given for a run id wins, so you can lower it mid-run but not raise it. A new run id is a new budget.
- The ledger covers eval spend only. The swarm's own model use shows in its dashboard.
- One climb at a time. Two would share the lead's task slots with normal Slack work.

## Review the PR

The PR needs a human code owner; neither bot can approve it. Check:

- **The target cases.** Read their full outputs from the PR's `delegate eval` comment: did the review block for the right reason, or just get lucky?
- **Near misses.** A case that went from 3/3 to 2/3 isn't a regression until main has 6 runs of it, so the gate can pass with one. Name it in the PR and decide if it's acceptable.
- **The diff.** Prompt text only, and small. A rule written for one case ("if the file is vk-mint-handler.ts...") is overfitting; push back.

Comment `delegate eval` on the PR to run the full suite in CI if it hasn't run.

## After a merge

- Tell Delegate in the thread that it merged. It doesn't notice merges on its own.
- If the merge changed `.claude/skills/hill-climb/`, ask Delegate to update its copy:

```
@delegate please update the hill-climb skill (id 928c53b3-b565-4ab2-9d9b-270623fc8f63) from the latest thegoodparty/ops main: .claude/skills/hill-climb/SKILL.md and .claude/skills/hill-climb/targets/delegate-pr-reviewer.json. Pull your ops checkout to current main first. Then confirm it's installed on both the lead and the Coder, and reply with the SKILL.md size and md5.
```

  Check its md5 against `git show origin/main:.claude/skills/hill-climb/SKILL.md | md5`. The Coder picks up a new version at its next start.
- A merge that changes the eval code (`delegate/review/`) invalidates main's cached results, so the next gate replays main too and costs more.

## Run it yourself instead

In a Claude Code session in ops, ask for a hill-climb of the delegate reviewer. The same skill runs locally with `npm run -s review:arms` against worktrees, which is faster for trying ideas and never runs holdout. Its PR still needs `delegate eval` in CI for the holdout check. See the README's [Hill-climbing](../delegate/review/eval/README.md#hill-climbing) section.
