/**
 * AWS account ids, in one place.
 *
 * One constant per account, imported by every policy, provider and script
 * that names an account. They are immutable for the life of the account, so
 * a redeclaration per file buys nothing and drifts: the previous copies each
 * carried a "Matches <the other file>" comment, which is a manual check
 * standing in for `tsc`.
 *
 * These are module constants rather than a Pulumi `StackReference`. The
 * reasoning is under "Cross-project dependencies" in
 * `docs/workbench-account.md`: a stack reference would buy propagation that
 * can never fire, at the cost of backend read access and the state passphrase
 * in every consuming project.
 *
 * Deliberately not exhaustive. The literal occurrences of the management
 * account id inside `deploy/components/ci-roles/policies.ts` are a verbatim
 * capture of an AWS-adopted policy, where interpolation would trade its
 * "captured from AWS" audit property for tidiness; `bugboss.ts` and
 * `ci-roles.ts` keep local `ACCOUNT_ID`s on the same grounds. This module
 * exists to stop the workbench id being declared in four files, not to sweep
 * every 12-digit string in the repo.
 */

/** The organization management account. Production also runs here. */
export const MANAGEMENT_ACCOUNT_ID = "333022194791";

/** The workbench account. Step 6 of `docs/workbench-account.md`. */
export const WORKBENCH_ACCOUNT_ID = "024901689212";
