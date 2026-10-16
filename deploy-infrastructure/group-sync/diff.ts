/**
 * The pure diff for the group sync, section 5 of `docs/google-group-sync.md`.
 *
 * No AWS, no Google, no clock and no I/O: same inputs, same diff. That is what
 * makes the correctness of the job reviewable without infrastructure, and it
 * is why the plan puts the diff here rather than inside the handler. The
 * handler (step 3) only materializes the user ids `add` leaves null and turns
 * the result into API calls.
 */

export type SourceMember = {
  /** Lowercased source email. */
  email: string;
  /** The Identity Store user id, or null when the user does not exist yet. */
  userId: string | null;
};

export type TargetMembership = {
  userId: string;
  membershipId: string;
};

export type Diff = {
  /** Source emails with no Identity Store user yet. */
  toCreate: string[];
  /** Source members absent from the target; `userId` is null for a to-create. */
  add: SourceMember[];
  /** Target memberships whose user is not in the source. */
  remove: TargetMembership[];
};

/**
 * The plan's function, verbatim. `add` includes the to-create members because
 * they are not in the target either; the handler materializes their user ids
 * after creation. `remove` is by `membershipId`, which is what
 * `DeleteGroupMembership` takes, and never by user id.
 */
export const diff = (
  source: SourceMember[],
  target: TargetMembership[],
): Diff => {
  const targetIds = new Set(target.map((m) => m.userId));
  const sourceIds = new Set(
    source.flatMap((m) => (m.userId ? [m.userId] : [])),
  );
  return {
    toCreate: source.filter((m) => !m.userId).map((m) => m.email),
    add: source.filter((m) => !m.userId || !targetIds.has(m.userId)),
    remove: target.filter((m) => !sourceIds.has(m.userId)),
  };
};
