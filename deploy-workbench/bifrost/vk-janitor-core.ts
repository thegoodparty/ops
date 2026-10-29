/**
 * The janitor's decisions, with no AWS SDK and no `fetch` in them.
 *
 * Step 5 of `docs/bifrost-virtual-keys.md`; decision 6, "The janitor: a
 * scheduled reconcile loop". The handler (`vk-janitor-handler.ts`) is the
 * adapter — it assumes the reader role, reads the setup token, speaks HTTP to
 * Bifrost, and writes the log lines. Everything a test can usefully disagree
 * with lives here:
 *
 * - **The member set is read first, and an empty one aborts the run.** "The
 *   group is empty" is indistinguishable from "the read failed" at the far
 *   end, and the safe reading of a mass removal is to not do it — the same
 *   guard, for the same reason, as the mint's live membership check and the
 *   incomplete-read abort in `google-group-sync.md`.
 * - **Only marker-bearing keys are considered.** The marker is the whole
 *   safety property (decision 5): a hand-made key, a test key, one a human
 *   created in the dashboard, is never deactivated by a job.
 * - **Deactivate, never delete and never reactivate.** One `PUT` per departed
 *   owner: `is_active: false`, `expires_at` a retention window out and
 *   `delete_after_expire: true`, so Bifrost's own cleanup deletes the key
 *   rather than the janitor growing a delete path. Getting a key back is a
 *   mint, which also clears that timer (decision 4), so there is one code path
 *   that grants and one that revokes and neither undoes the other.
 * - **The timer is set once, on the transition.** A key already inactive with
 *   a deletion timer is left alone, or an hourly run would push the window
 *   forward every hour and nothing would ever be deleted.
 * - **Every read happens before the first write.** A directory or gateway read
 *   that fails partway through a run leaves the gateway untouched rather than
 *   half-reconciled: the run either classifies every managed key or writes
 *   nothing.
 */

import { isManagedKeyDescription } from "./vk-marker";
import type {
  KeyPage,
  MembershipDirectory,
  VirtualKey,
} from "./vk-mint-core";

/**
 * The retention window before Bifrost deletes a deactivated key, in days.
 *
 * Decision 6: ninety days, matching the gateway's own request-log retention
 * (`client.log_retention_days` is 90 in `bifrost/config.json`), because past
 * that point the request records that make the spend history worth keeping
 * have rolled off anyway. A returning person is a reactivation — a mint, which
 * clears this timer — rather than a resurrection.
 */
export const VK_RETENTION_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The shape of a key name this job is willing to resolve.
 *
 * Decision 4 makes the name "the lowercase email": the string the Identity
 * Store holds as the user's `userName` and the one `GetUserId` resolves on
 * `emails.value`. Open item 6 is the identity where those two diverge — a
 * `userName` that is not an email mints a key whose name is not an address at
 * all — and the janitor cannot tell that person from a departed one by
 * looking, because `ListGroupMemberships` returns user ids and neither job is
 * granted `DescribeUser`.
 *
 * So the guard here is the shape of the name, and it is deliberately
 * conservative. A marker-bearing key whose name is *not* email-shaped is
 * logged and skipped, never deactivated: the name is not the identity string
 * this design resolves, and turning a shape mismatch into a revocation would
 * take a working person's only key on a guess. A name that *is* email-shaped
 * and resolves to no user is a different case — a departed person whose
 * Identity Center user is gone — and that one is deactivated, in the
 * fail-closed direction decision 6 requires. Neither outcome is silent; see
 * `owner-not-an-email` and `owner-unresolved` below.
 *
 * What this cannot catch, stated so nobody assumes it does: an email-shaped
 * `userName` that is a real address but not *the person's* email resolves to
 * no user and is deactivated, exactly like a departed person. That residual is
 * why the run log names every deactivation with its reason.
 */
export const isEmailShaped = (value: string): boolean =>
  /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);

/** One page of the gateway's list response, as far as the janitor reads it. */
export type JanitorKeyQuery = { limit: number; offset: number };

/**
 * The gateway, as the janitor uses it: list without a search term (every key,
 * then the marker filters), and the one update the deactivation needs. The
 * mint's `VirtualKeyGateway` is deliberately not this type: its `list` is a
 * search, and a reconcile that only saw search hits would miss keys.
 */
export type JanitorGateway = {
  list: (query: JanitorKeyQuery) => Promise<KeyPage>;
  update: (id: string, body: Record<string, unknown>) => Promise<VirtualKey>;
};

/** Why a run stopped without reconciling anything. */
export type JanitorFailureCode = "membership-unavailable" | "gateway-unavailable";

export class JanitorFailure extends Error {
  constructor(
    readonly code: JanitorFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "JanitorFailure";
  }
}

/** Why a managed key was deactivated. */
export type DeactivationReason = "not-a-member" | "owner-unresolved";

/** Why a managed key was left alone. */
export type SkipReason = "already-inactive" | "owner-not-an-email";

export type JanitorResult = {
  /**
   * `aborted` is the empty-group case: the read succeeded and said "nobody",
   * which is not a reason to deactivate everybody. Nothing was written.
   */
  outcome: "ok" | "aborted";
  abortReason?: "group-empty";
  /** How many members the directory returned. */
  memberCount: number;
  /** How many keys carried the marker at all. */
  managedKeyCount: number;
  /** Owners left active because they are still members. */
  kept: string[];
  deactivated: Array<{ name: string; reason: DeactivationReason }>;
  skipped: Array<{ name: string; reason: SkipReason }>;
};

/**
 * How many keys one page asks for, and the most pages a run will walk. A
 * hundred pages of a hundred is ten thousand keys, orders of magnitude more
 * than this deployment has; the bound is there so broken pagination fails the
 * run instead of looping, the same way the mint's page budget works.
 *
 * Pagination rather than the list route's `export=true` on purpose: the paged
 * shape is the one step 3 exercises against the deployed gateway, and this job
 * must not be the first caller to depend on an unverified response shape.
 */
export const JANITOR_KEY_PAGE_SIZE = 100;
export const JANITOR_MAX_KEY_PAGES = 100;

/**
 * The deactivation deadline as the gateway takes it: RFC3339 with a `Z`, no
 * fractional seconds. The pinned update path reads `expires_at` as a string and
 * an empty one as "no expiry"; a real timestamp is what starts the retention
 * clock.
 */
export const retentionDeadline = (now: Date): string =>
  new Date(now.getTime() + VK_RETENTION_DAYS * MS_PER_DAY)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

/**
 * Decision 6's one write. All three fields in one call because they are one
 * decision: deactivate, start the retention window, and let Bifrost's cleanup
 * do the deleting.
 */
export const deactivationBody = (
  now: Date,
): { is_active: false; expires_at: string; delete_after_expire: true } => ({
  is_active: false,
  expires_at: retentionDeadline(now),
  delete_after_expire: true,
});

/**
 * Whether a key already carries the janitor's deletion timer. All three parts
 * are required: an inactive key with an expiry but `delete_after_expire` not
 * set is a partial transition, and completing it once is not the hourly clock
 * reset this guard exists to prevent (the next run sees all three and skips).
 */
export const hasDeletionTimer = (key: VirtualKey): boolean =>
  key.is_active === false &&
  typeof key.expires_at === "string" &&
  key.expires_at.trim() !== "" &&
  key.delete_after_expire === true;

const listAllKeys = async (gateway: JanitorGateway): Promise<VirtualKey[]> => {
  const keys: VirtualKey[] = [];
  let offset = 0;
  for (let page = 0; page < JANITOR_MAX_KEY_PAGES; page++) {
    const result = await gateway.list({
      limit: JANITOR_KEY_PAGE_SIZE,
      offset,
    });
    keys.push(...result.keys);

    const received = offset + result.keys.length;
    const total = result.totalCount ?? received;
    if (result.keys.length === 0 || received >= total) return keys;
    offset = received;
  }
  throw new JanitorFailure(
    "gateway-unavailable",
    "the key list did not end within the janitor's page budget",
  );
};

type Verdict =
  | { kind: "kept"; name: string }
  | { kind: "deactivate"; name: string; key: VirtualKey; reason: DeactivationReason }
  | { kind: "skip"; name: string; reason: SkipReason };

/**
 * Decision 6's loop: the group, then the keys, then one write per key whose
 * owner is not in the group.
 *
 * `now` is a parameter rather than `new Date()` so the retention deadline is
 * deterministic in a test, and so one run computes one deadline for every key
 * it touches.
 */
export const reconcileVirtualKeys = async (args: {
  directory: MembershipDirectory;
  gateway: JanitorGateway;
  now: Date;
}): Promise<JanitorResult> => {
  const { directory, gateway, now } = args;

  // The member set first. A failed or empty read is the abort decision 6
  // describes, and neither can be followed by a write.
  let members: readonly string[];
  try {
    members = await directory.listMemberUserIds();
  } catch {
    throw new JanitorFailure(
      "membership-unavailable",
      "could not read Engineers' memberships",
    );
  }
  if (members.length === 0) {
    return {
      outcome: "aborted",
      abortReason: "group-empty",
      memberCount: 0,
      managedKeyCount: 0,
      kept: [],
      deactivated: [],
      skipped: [],
    };
  }
  const memberIds = new Set(members);

  let keys: VirtualKey[];
  try {
    keys = await listAllKeys(gateway);
  } catch (error) {
    if (error instanceof JanitorFailure) throw error;
    throw new JanitorFailure(
      "gateway-unavailable",
      "could not list the gateway's virtual keys",
    );
  }

  // The shared marker test, not a second copy of the string written here:
  // `bifrost/vk-marker.ts` owns the string so the mint and the janitor cannot
  // drift (decision 5). A key without it is not this job's to touch.
  const managed = keys.filter((key) =>
    isManagedKeyDescription(key.description),
  );

  // Phase one: every read, no writes. A directory error here throws before the
  // gateway has been touched, so a run cannot deactivate one key and then die
  // on the next key's owner lookup.
  const verdicts: Verdict[] = [];
  for (const key of managed) {
    const name = key.name.trim().toLowerCase();

    if (!isEmailShaped(name)) {
      verdicts.push({ kind: "skip", name, reason: "owner-not-an-email" });
      continue;
    }
    if (hasDeletionTimer(key)) {
      verdicts.push({ kind: "skip", name, reason: "already-inactive" });
      continue;
    }

    let userId: string | null;
    try {
      userId = await directory.getUserId(name);
    } catch {
      throw new JanitorFailure(
        "membership-unavailable",
        `could not resolve the owner of a managed key (${name})`,
      );
    }

    if (userId !== null && memberIds.has(userId)) {
      verdicts.push({ kind: "kept", name });
    } else {
      verdicts.push({
        kind: "deactivate",
        name,
        key,
        reason: userId === null ? "owner-unresolved" : "not-a-member",
      });
    }
  }

  // Phase two: the only writes in the job.
  const result: JanitorResult = {
    outcome: "ok",
    memberCount: members.length,
    managedKeyCount: managed.length,
    kept: [],
    deactivated: [],
    skipped: [],
  };
  for (const verdict of verdicts) {
    if (verdict.kind === "kept") {
      result.kept.push(verdict.name);
      continue;
    }
    if (verdict.kind === "skip") {
      result.skipped.push({ name: verdict.name, reason: verdict.reason });
      continue;
    }
    try {
      await gateway.update(verdict.key.id, deactivationBody(now));
    } catch {
      // The remaining keys are left as they are. Reporting the failure is worth
      // more than carrying on against a gateway that just refused a write.
      throw new JanitorFailure(
        "gateway-unavailable",
        `could not deactivate a key (${verdict.name})`,
      );
    }
    result.deactivated.push({ name: verdict.name, reason: verdict.reason });
  }
  return result;
};
