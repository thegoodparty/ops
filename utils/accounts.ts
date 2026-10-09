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
 * "captured from AWS" audit property for tidiness; `ci-roles.ts` keeps a
 * local `ACCOUNT_ID` on the same grounds. This module
 * exists to stop the workbench id being declared in four files, not to sweep
 * every 12-digit string in the repo.
 */

/** The organization management account. Production also runs here. */
export const MANAGEMENT_ACCOUNT_ID = "333022194791";

/** The workbench account. Step 6 of `docs/workbench-account.md`. */
export const WORKBENCH_ACCOUNT_ID = "024901689212";

/**
 * The infrastructure account. Step 3 of `docs/infrastructure-account.md`.
 *
 * Read by `deploy-org/policies.ts` for the Infrastructure SCP, by
 * `deploy-infrastructure/` for its provider, and by `identity-center.ts` for
 * the admin assignment, so this one constant stands in for the three copies
 * those consumers would otherwise each carry.
 */
export const INFRASTRUCTURE_ACCOUNT_ID = "394495727159";

/**
 * The management account's Identity Center identity store id.
 *
 * HUMAN INPUT PENDING. The real value cannot be read with the container's
 * `WorkbenchAccess` credentials: `sso:ListInstances` is denied, and the id is
 * not recorded anywhere else in the repo. The placeholder is deliberate, and
 * the `break-glass-grant` inline policy in
 * `deploy/components/break-glass-grant.ts` is inert until the engineer
 * replaces it. The real id is on the Identity Center settings page, or from
 * `aws sso-admin list-instances` with a session that holds
 * `sso:ListInstances`.
 *
 * A literal rather than a Pulumi lookup, for the same reason as the account
 * ids above: the policy references it and there is no Pulumi resource to read
 * it from, so an Output would buy nothing. Recorded here rather than in the
 * policy file so it sits beside the account ids it is scoped with; see
 * "The tool's own privilege" in `docs/break-glass.md`.
 */
export const IDENTITY_STORE_ID = "d-REPLACE-ME";

/**
 * The identity store ARN, in the form
 * `arn:aws:identitystore::<account>:identitystore/<id>`.
 *
 * Note the empty region field: Identity Store is a global service and its ARNs
 * carry no region. Derived here so the policy names the same literal a reader
 * would look up, rather than re-deriving the string at each use.
 */
export const IDENTITY_STORE_ARN = `arn:aws:identitystore::${MANAGEMENT_ACCOUNT_ID}:identitystore/${IDENTITY_STORE_ID}`;
