/**
 * The keys the `DELEGATES` secret is expected to hold.
 *
 * This is the source of truth for the `secrets` list on the `agent` container.
 * It is declared in the repo rather than read from the live secret so that a
 * `pulumi preview` never needs `secretsmanager:GetSecretValue`; see
 * `docs/pr-previews.md`, step 3. `delegate/.env.example` mirrors this list, and
 * adding or removing a key is now a reviewed change here instead of a silent
 * edit to the secret that changes the task definition on the next deploy.
 *
 * `check-secret-keys.ts` checks the live secret against this list on apply, and
 * `index.ts` passes it to `createWorker`.
 */
export const DELEGATE_SECRET_KEYS = [
  // Anthropic
  "ANTHROPIC_API_KEY",

  // Slack
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",

  // GitHub App (delegate[bot])
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",

  // GitHub App (reviewer[bot]) — a separate App so pr-reviewer's approvals
  // come from a different identity than delegate[bot]. Read by
  // `worker/github-auth.ts`; without it pr-reviewer runs comment-only.
  "REVIEWER_APP_PRIVATE_KEY",

  // ClickUp. `CLICKUP_API_TOKEN` is what the worker reads. `CLICKUP_TOKEN` is
  // not referenced in this repo.
  "CLICKUP_API_TOKEN",
  "CLICKUP_TOKEN",

  // Observability. `GRAFANA_WEBHOOK_SECRET` is not referenced in this repo.
  "DATABRICKS_TOKEN",
  "GRAFANA_SERVICE_ACCOUNT_TOKEN",
  "GRAFANA_WEBHOOK_SECRET",
  "SENTRY_AUTH_TOKEN",

  // Not referenced in this repo. `GITHUB_TOKEN` is overwritten at boot by
  // `setupGitHubAuth`. All of these were supplied by the live secret, so they
  // stay to keep the task definition unchanged.
  "GITHUB_TOKEN",
  "WORKFLOW_USERS",
] as const;

/** Keys declared here but absent from the live secret, and vice versa. */
export interface DelegateSecretKeyDiff {
  missing: string[];
  extra: string[];
}

/**
 * Compare the keys actually in the live secret against the declared list.
 *
 * Pure so it can be tested without AWS; `check-secret-keys.ts` turns the result
 * into an exit code.
 */
export const diffDelegateSecretKeys = (
  actual: readonly string[]
): DelegateSecretKeyDiff => {
  const declared = new Set<string>(DELEGATE_SECRET_KEYS);
  const present = new Set(actual);

  return {
    missing: DELEGATE_SECRET_KEYS.filter((key) => !present.has(key)),
    extra: actual.filter((key) => !declared.has(key)),
  };
};
