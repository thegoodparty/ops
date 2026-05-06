// Distinct from lambdas/github.ts:REVIEW_REPOS (auto-PR-review scope).
// Same initial members but separate so write scope can grow without expanding
// review-trigger scope. Update both lists when adding a repo.
export const WRITE_REPOS = new Set([
  "gp-api",
  "gp-webapp",
  "people-api",
  "election-api",
  "ops",
]);

export const isWritableRepo = (name: string): boolean =>
  WRITE_REPOS.has(name);

export const assertWritableRepo = (name: string): void => {
  if (!WRITE_REPOS.has(name)) {
    throw new Error(
      `Repo ${name} is not in WRITE_REPOS allowlist. Allowed: ${[...WRITE_REPOS].join(", ")}`,
    );
  }
};
