/**
 * Whether a string is the shape of the key name this design resolves.
 *
 * Decision 4 of `docs/bifrost-virtual-keys.md` makes the name "the lowercase
 * email": the string the Identity Store holds as the user's `userName` and the
 * one `GetUserId` resolves on `emails.value`. Open item 6 is the identity where
 * those two diverge — a `userName` that is not an email mints a key whose name
 * is not an address at all — and the janitor cannot tell that person from a
 * departed one by looking, because `ListGroupMemberships` returns user ids and
 * neither job is granted `DescribeUser`.
 *
 * So the guard is the shape of the name, and it is deliberately conservative. A
 * marker-bearing key whose name is *not* email-shaped is logged and skipped,
 * never deactivated: the name is not the identity string this design resolves,
 * and turning a shape mismatch into a revocation would take a working person's
 * only key on a guess. A name that *is* email-shaped and resolves to no user is a
 * different case — a departed person whose Identity Center user is gone — and
 * that one is deactivated, in the fail-closed direction decision 6 requires.
 *
 * What this cannot catch, stated so nobody assumes it does: an email-shaped
 * `userName` that is a real address but not *the person's* email resolves to no
 * user and is deactivated, exactly like a departed person. That residual is why
 * the run log names every deactivation with its reason.
 *
 * It lives in its own module because both sides of the reconciler need it —
 * `vk-janitor-core.ts` to decide which keys it may act on, and
 * `governance-desired-state.ts` to refuse an overrides document keyed by
 * something that can never match a key — and the second imports the first. One
 * copy here, re-exported by the janitor's core for the callers that already
 * import it from there, keeps those two modules from importing each other.
 */
export const isEmailShaped = (value: string): boolean =>
  /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
