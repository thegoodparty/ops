// WRITE_REPOS is the allowlist of repos the bot is permitted to push to /
// open PRs against. It is the single source of truth — `task-execution-agent`
// interpolates this set into its system prompt at module-load time, so the
// list shown to the LLM and the list checked at runtime cannot drift.
//
// Distinct from `lambdas/github.ts:REVIEW_REPOS` (auto-PR-review trigger
// scope). Same initial members, but kept separate so write scope can grow
// without expanding the review-trigger scope. Update both lists when adding
// a repo.
//
// Enforcement posture (v1): the gate is prompt-level — the agent is
// instructed to refuse pushes to any repo not in the list. There is no
// runtime tool-use hook that physically blocks a `git push`. To add one,
// wire `assertWritableRepo` into a `PreToolUse` hook in `framework/agent.ts`
// that inspects `Bash` commands matching `gh repo clone thegoodparty/<name>`
// and denies if the name isn't writable.
export const WRITE_REPOS = new Set([
  "gp-api",
  "gp-webapp",
  "people-api",
  "election-api",
  "runbooks",
  "gp-ai-projects",
  "ai-rules",
]);

export const isWritableRepo = (name: string): boolean => WRITE_REPOS.has(name);

export const assertWritableRepo = (name: string): void => {
  if (!WRITE_REPOS.has(name)) {
    throw new Error(
      `Repo ${name} is not in WRITE_REPOS allowlist. Allowed: ${[...WRITE_REPOS].join(", ")}`,
    );
  }
};
