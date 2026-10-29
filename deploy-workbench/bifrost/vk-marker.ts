/**
 * The one description marker that identifies a virtual key as Lambda-managed.
 *
 * Decision 5 of `docs/bifrost-virtual-keys.md` leaves the exact string to the
 * implementer but requires it to be "in one constant, matched by both
 * Lambdas": a key carrying this marker is the janitor's only input (step 5),
 * and that is what keeps a hand-made key — a test key, an experiment, one a
 * human created in the dashboard — out of reach of a job that deactivates
 * things. Three copies of the string would drift, and the drift would be
 * silent in the worst direction: a key the mint created but the janitor no
 * longer recognises is a key that outlives the person's membership.
 *
 * So it lives here, beside the template and the handler, and the template test,
 * the mint handler (step 3) and the janitor (step 5) all import it. The
 * template's own description is `VK_DESCRIPTION` below, which the template
 * test asserts, so the JSON file and this constant cannot disagree either.
 */
export const VK_DESCRIPTION_MARKER = "lambda-managed";

/**
 * The full description a minted key carries: the marker first, then what the
 * key is. The marker has to be a prefix because the janitor matches on
 * `startsWith`; the rest is for a human reading the dashboard.
 */
export const VK_DESCRIPTION = `${VK_DESCRIPTION_MARKER} per-user key, minted from Identity Center membership`;

/**
 * Whether a key's description marks it as one the janitor may deactivate.
 *
 * Deliberately a prefix test and not equality: a later template may append to
 * the description, and the marker is the stable part. A key with no
 * description, an empty one, or a description that merely contains the words
 * somewhere is not managed — only a key that starts with the marker is.
 */
export const isManagedKeyDescription = (
  description: string | null | undefined,
): boolean =>
  typeof description === "string" &&
  description.startsWith(VK_DESCRIPTION_MARKER);
