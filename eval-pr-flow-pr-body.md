The eval tooling existed only as a CLI you ran by hand in a local worktree. Results had nowhere to land: you would judge a branch against main, get a markdown table in your terminal, and have no record on the PR where the reviewer actually decides whether to merge.

The PR is the right place. When someone comments `delegate eval` (or `delegate eval 20` for N cases), the workflow:

1. Snapshots the N most recent completed production review cases from S3 — cases where the bot actually approved or commented, so the baseline reflects real behavior.
2. Uses what production posted as one side, requiring no replay on that side.
3. Replays the cases using the agent code from the PR head — the thing under review — at concurrency 4.
4. Judges the two sides pairwise at concurrency 6, keeping output in record order.
5. Posts a single PR comment: a short plain-English summary under 250 words with the sign-test p-value, replay cost, and failure count; per-case table and per-case transcripts inside drop-downs so the comment doesn't dominate the thread.
6. Upserts the comment (PATCH if one already exists, POST otherwise) so re-running replaces rather than appends.
7. Uploads the full eval directory as a workflow artifact.

The judge holds constant on main — the same rubric, model, and tooling — while the PR supplies the agent. This isolates what changes: the agent code on the PR branch.

The IAM role is narrow by design: S3 GetObject/GetObjectVersion on `delegate-reviews/*` and ListBucket on `delegate-reviews`. Nothing else. The trust pins to `delegate-eval.yml` on `main`, so the role cannot be assumed by any other workflow file, and not by a PR run.

Two repo settings are needed before the first run: variable `DELEGATE_EVAL_APP_ID` and secret `DELEGATE_EVAL_APP_PRIVATE_KEY` (a GitHub App with `contents:read` on reviewed repos, used so `gh repo clone` works during replay without putting a PAT in the workflow environment). `ANTHROPIC_API_KEY` is already present.
