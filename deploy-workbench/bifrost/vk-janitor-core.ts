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
 *   a deletion timer is left alone, or a run every five minutes would push the
 *   window forward every tick and nothing would ever be deleted.
 * - **Every read happens before the first write.** A directory or gateway read
 *   that fails partway through a run leaves the gateway untouched rather than
 *   half-reconciled: the run either classifies every managed key or writes
 *   nothing.
 */

import { isManagedKeyDescription } from "./vk-marker";
import { isEmailShaped } from "./key-name";
import type {
  KeyPage,
  MembershipDirectory,
  VirtualKey,
} from "./vk-mint-core";
import {
  governanceBody,
  governanceDesiredState,
  type GovernanceDesiredState,
  type GovernanceOverrides,
  type GovernanceRateLimit,
  type GovernanceTemplate,
  type ReconciledField,
} from "./governance-desired-state";
import type {
  ObservedGovernance,
  ObservedRateLimit,
} from "./vk-governance-observed";

/*
 * The composed desired state, its complete-set body, the fields governance owns
 * and the `inherit` source are all `governance-desired-state.ts`'s, re-exported
 * here because that is where callers already take them from.
 *
 * They moved there in step 5 of `docs/bifrost-reconciler.md`, when the mint
 * became the second caller: a copy of the merge, the narrowing or the body on
 * the mint's side is the defect the step exists to prevent, and the module they
 * moved to is the one that already owned the merge and the validation (step 2).
 * Keeping them here would have made `vk-mint-core.ts` import the janitor's core
 * to create a key, which is the wrong direction — this module is the loop, and
 * the loop is not the desired state.
 */
export {
  RECONCILED_FIELDS,
  composeDesiredState,
  convergenceBody,
  governanceBody,
  governanceDesiredState,
  type ComposedDesiredState,
  type GovernanceTemplate,
  type ProviderConfigsSource,
  type ReconciledField,
} from "./governance-desired-state";

/**
 * Re-exported from `key-name.ts`, which is where it now lives: the governance
 * desired-state module needs the same guard and imports it from there, so
 * keeping the one copy here would make the two modules import each other.
 * Callers that already take it from this module keep working unchanged.
 */
export { isEmailShaped };

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

/**
 * Why a run stopped without reconciling anything.
 *
 * `desired-state-unavailable` is the reconciler's: one of the governance
 * documents could not be read, so the run had nothing to converge *to*. It is a
 * separate code from `gateway-unavailable` because a deploy that wrote a
 * parameter and a gateway that refused a write are different failures to go and
 * look at, and the three-in-a-row alarm (step 6) counts a run either way.
 *
 * Step 4 adds two, for the config half: `config-unavailable` is a read that
 * failed, and `convergence-failed` is a write the gateway refused. Both fail the
 * invocation, which is what turns "the file says one thing and the process does
 * another" into a red deploy rather than a log line nobody opened (decision 5).
 */
export type JanitorFailureCode =
  | "membership-unavailable"
  | "gateway-unavailable"
  | "desired-state-unavailable"
  | "config-unavailable"
  | "convergence-failed";

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
 * set is a partial transition, and completing it once is not the per-tick clock
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

/* =========================================================================
 * Governance convergence
 *
 * Step 3 of `docs/bifrost-reconciler.md`. The same function shape as the
 * revocation loop above, over the same gateway and the same directory, because
 * the plan makes one reconciler with two jobs rather than two functions with two
 * copies of the credential, the network and the directory hop (decision 3).
 *
 * Every rule below is one of the plan's decisions, so the module reads as the
 * decision list rather than as a pipeline:
 *
 * - **Diff before write, and "converged" is a counted number** (decision 6). At
 *   five minutes an unconditional write is 288 `PUT`s per key per day, each one
 *   calling `ReloadVirtualKey` and rebuilding that key's governance. So the run
 *   reads, compares, and writes only what differs, and `changed` is a number the
 *   caller can assert — not a log line a reader has to trust. "Nothing changed"
 *   is an empty request set, not a request that happens to be a no-op.
 * - **The composition is a complete set, never a patch.** `provider_configs` on a
 *   virtual-key update is a replacement set: a supplied entry updates or is
 *   created, and an entry the request omits is *deleted* with its budgets and
 *   rate limit (`governance.go` at the pinned tag, the delete loop and
 *   `collectProviderConfigDeleteIDs`). So every `PUT` carries the whole composed
 *   list, and the diff compares the lists whole. Omitting `key_ids` is the one
 *   narrow exception that leaves associations alone; this module never relies on
 *   it.
 * - **`inherit` is distinct from absent** (decision 9), even where the two
 *   resolve to the same value: `"provider_configs": "inherit"` in an override
 *   says "keep the template's" out loud, and the composed state records which of
 *   the two produced the list so that distinction is assertable rather than
 *   implied.
 * - **`rate_limit` has no default** (decision 12). The field is in the shape and
 *   nothing sets it, so a composed state with no limit carries no `rate_limit`
 *   at all: on the update path an omitted one means "leave the key's alone",
 *   where an empty object means "remove it". The diff compares the field only
 *   when git names one, so a limit set by hand in the dashboard is not drift this
 *   loop fights.
 * - **`calendar_aligned: true`, and budgets by `reset_duration`** (decision 11,
 *   success criterion 3). Budgets carry no ids and the body never carries
 *   `reset_budget_usage`: the update path matches an existing budget by `id`, or
 *   by `reset_duration` when no id is given, and copies `current_usage` and
 *   `last_reset` back from the stored row on every write. That is what makes a
 *   retune keep a person's month.
 * - **It mints nothing** (decision 7). Desired state is computed for keys that
 *   exist, matched by the marker and the name. A roster member with no key
 *   produces no key, and `minted: 0` says so out loud. Granting access is the
 *   mint's, so there is one code path that grants and one that converges.
 * - **Nothing disables itself, and a failure is not swallowed** (decision 15). A
 *   failed read or write throws a `JanitorFailure`, so the invocation fails and
 *   step 6's three-consecutive-failures alarm has something to count.
 *
 * The desired state itself — the merge, the narrowing to the fields governance
 * owns, the `calendar_aligned` default and the complete-set body — lives in
 * `governance-desired-state.ts` and is re-exported below. Step 5 made the mint
 * its second caller, so it cannot live here without the mint importing the
 * janitor's loop to create a key; see that module's header for the argument, and
 * `vk-mint-core.ts` for the create path.
 * ====================================================================== */

/** One budget as either side reports it, for the comparison. */
type BudgetLike = { max_limit?: unknown; reset_duration?: unknown };

/**
 * One provider entry as either side reports it.
 *
 * Deliberately loose rather than the union of the two typed shapes: the desired
 * side has `key_ids` and the observed side has `allow_all_keys`/`keys`, and the
 * conversion below has to read whichever arrived.
 */

/**
 * A budget set as a sorted list of the two fields git owns.
 *
 * The gateway reports `current_usage`, `last_reset` and its override columns
 * alongside them, and none of those is git's to own: comparing them would make
 * every tick see a difference on a number the accounting writes itself, which is
 * the fight the diff exists to avoid. Sorted, because `reset_duration` is the
 * field both sides match on and a row reordering is not a change.
 */
const budgetSetKey = (budgets: readonly BudgetLike[] | undefined): string[] =>
  (budgets ?? [])
    .map((budget) => JSON.stringify([budget.reset_duration, budget.max_limit]))
    .sort();

/**
 * A rate limit as a sorted list of its set (maximum, duration) pairs.
 *
 * A missing or empty limit is the empty string, so "no limit anywhere" and "no
 * limit here" compare equal; the caller only reaches this when a document named
 * one (decision 12).
 */
const rateLimitKey = (
  limit: GovernanceRateLimit | ObservedRateLimit | null | undefined,
): string => {
  if (!limit || typeof limit !== "object") return "";
  const pairs: unknown[][] = [];
  for (const [maximum, duration] of [
    ["token_max_limit", "token_reset_duration"],
    ["request_max_limit", "request_reset_duration"],
  ] as const) {
    const value = (limit as Record<string, unknown>)[maximum];
    if (value === undefined || value === null) continue;
    pairs.push([value, (limit as Record<string, unknown>)[duration] ?? null]);
  }
  return pairs.length === 0 ? "" : JSON.stringify(pairs);
};

/**
 * One provider entry as the diff sees it: the fields a `PUT` can set, with the
 * key association expressed the way the desired state expresses it.
 *
 * The gateway reports the association the other way round — `allow_all_keys`
 * plus a `keys` array of key rows — so it is converted here. Without that,
 * every run would read `key_ids: ["*"]` against "no key_ids" as a difference and
 * rewrite every key every tick, which is precisely the no-op traffic the diff
 * exists to prevent.
 */
type ProviderConfigLike = {
  provider?: unknown;
  allowed_models?: unknown;
  blacklisted_models?: unknown;
  weight?: unknown;
  key_ids?: unknown;
  allow_all_keys?: unknown;
  keys?: unknown;
};

const providerConfigKey = (config: ProviderConfigLike): string => {
  const keyIds = Array.isArray(config.key_ids)
    ? [...(config.key_ids as string[])].sort()
    : config.allow_all_keys === true
      ? ["*"]
      : Array.isArray(config.keys)
        ? (config.keys as Array<{ key_id?: string }>)
            .map((key) => key.key_id ?? "")
            .sort()
        : [];

  return JSON.stringify([
    config.provider ?? null,
    [...((config.allowed_models as string[] | undefined) ?? [])].sort(),
    [...((config.blacklisted_models as string[] | undefined) ?? [])].sort(),
    config.weight ?? null,
    keyIds,
  ]);
};

/** A provider-config set as sorted strings, for the same reasons as budgets. */
const providerConfigSetKey = (
  configs: readonly ProviderConfigLike[] | undefined,
): string[] => (configs ?? []).map(providerConfigKey).sort();

/**
 * The governance fields on which the desired state and the gateway disagree, or
 * an empty list when the key is already converged.
 *
 * Each field is compared as a whole value rather than field by field inside it,
 * because each one is a **replacement set** on the wire: a provider list that
 * differs in one entry is still a different set, and the `PUT` that fixes it
 * carries all of it.
 */
export const differingFields = (
  desired: GovernanceDesiredState,
  observed: ObservedGovernance,
): ReconciledField[] => {
  const differ: ReconciledField[] = [];

  if (
    JSON.stringify(
      providerConfigSetKey(desired.provider_configs),
    ) !==
    JSON.stringify(providerConfigSetKey(observed.provider_configs))
  ) {
    differ.push("provider_configs");
  }

  if (
    JSON.stringify(budgetSetKey(desired.budgets)) !==
    JSON.stringify(budgetSetKey(observed.budgets))
  ) {
    differ.push("budgets");
  }

  // Only when git names one: a limit set by hand is not drift this loop fights,
  // and treating "the gateway has one, git does not" as a difference would
  // remove a limit nobody asked it to remove (decision 12).
  if (
    desired.rate_limit !== undefined &&
    rateLimitKey(desired.rate_limit) !== rateLimitKey(observed.rate_limit)
  ) {
    differ.push("rate_limit");
  }

  if (
    desired.calendar_aligned !== undefined &&
    Boolean(observed.calendar_aligned) !== desired.calendar_aligned
  ) {
    differ.push("calendar_aligned");
  }

  return differ;
};

/** Why a managed key was left alone by convergence. */
export type ReconcileSkipReason =
  /** The name is not the lowercase email this design resolves (open item 6). */
  | "owner-not-an-email"
  /** The key's owner is not in the desired state's member set: the janitor's. */
  | "not-a-member";

/** One key that differed, with the fields that did. */
export type ConvergedKey = { name: string; fields: ReconciledField[] };

export type ReconcileResult = {
  /**
   * `aborted` is the empty-group case: the read succeeded and said "nobody",
   * which is not a reason to write everybody's governance. Nothing was written.
   */
  outcome: "converged" | "aborted";
  abortReason?: "group-empty";
  /** How many members the directory returned. */
  memberCount: number;
  /** How many keys carried the marker at all. */
  managedKeyCount: number;
  /** How many keys the gateway was told about. The honest "changed" number. */
  changed: number;
  /** How many managed keys were already at their desired state. */
  unchanged: number;
  /** The keys written, with the fields that differed. */
  applied: ConvergedKey[];
  /** The keys left alone, with the reason. */
  skipped: Array<{ name: string; reason: ReconcileSkipReason }>;
  /**
   * Always zero, as a number rather than an omission: decision 7 makes it the
   * run's own statement that convergence grants nothing.
   */
  minted: 0;
};

/**
 * Step 3's loop: the desired state, the `GET`, the diff, and one `PUT` per key
 * that differs.
 *
 * `members` is the `Engineers` user id set the loop reads for itself, through
 * the same directory the revocation loop uses: one adapter, one role, one read
 * per run, and the abort-on-empty guard in one shape.
 *
 * A managed key whose owner is not a member is skipped, not converged: taking
 * access away is the revocation loop's job and granting it is the mint's, so
 * this loop has no opinion about a departing person's key. A member with no key
 * produces nothing at all.
 */
export const reconcileGovernance = async (args: {
  gateway: JanitorGateway;
  /** The same directory the revocation loop reads, scoped to `Engineers`. */
  directory: MembershipDirectory;
  template: GovernanceTemplate;
  overrides: GovernanceOverrides;
}): Promise<ReconcileResult> => {
  const { gateway, directory, template, overrides } = args;

  // The member set first, for the same reason the revocation loop reads it
  // first: a failed or empty read is not a reason to write anybody's
  // governance, and neither can be followed by a write.
  let members: readonly string[];
  try {
    members = await directory.listMemberUserIds();
  } catch {
    throw new JanitorFailure(
      "membership-unavailable",
      "could not read Engineers' memberships",
    );
  }

  // The guard both other jobs apply, for the same reason: an empty group is
  // indistinguishable from a failed read at the far end, and the safe reading of
  // "everybody's governance is now the template" is to not write it.
  if (members.length === 0) {
    return {
      outcome: "aborted",
      abortReason: "group-empty",
      memberCount: 0,
      managedKeyCount: 0,
      changed: 0,
      unchanged: 0,
      applied: [],
      skipped: [],
      minted: 0,
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

  const managed = keys.filter((key) => isManagedKeyDescription(key.description));

  // Phase one: every read, no writes. A directory or composition failure leaves
  // the gateway untouched rather than half-converged, the same ordering the
  // revocation loop applies.
  type Verdict =
    | {
        kind: "apply";
        name: string;
        key: VirtualKey;
        body: Record<string, unknown>;
        fields: ReconciledField[];
      }
    | { kind: "skip"; name: string; reason: ReconcileSkipReason }
    | { kind: "unchanged"; name: string };

  const verdicts: Verdict[] = [];
  for (const key of managed) {
    const name = key.name.trim().toLowerCase();

    if (!isEmailShaped(name)) {
      verdicts.push({ kind: "skip", name, reason: "owner-not-an-email" });
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
    if (userId === null || !memberIds.has(userId)) {
      verdicts.push({ kind: "skip", name, reason: "not-a-member" });
      continue;
    }

    const { state } = governanceDesiredState({ template, overrides, email: name });
    const fields = differingFields(state, key);
    if (fields.length === 0) {
      verdicts.push({ kind: "unchanged", name });
      continue;
    }
    verdicts.push({
      kind: "apply",
      name,
      key,
      body: governanceBody(state),
      fields,
    });
  }

  // Phase two: the only writes in the run.
  const result: ReconcileResult = {
    outcome: "converged",
    memberCount: members.length,
    managedKeyCount: managed.length,
    changed: 0,
    unchanged: 0,
    applied: [],
    skipped: [],
    minted: 0,
  };

  for (const verdict of verdicts) {
    if (verdict.kind === "skip") {
      result.skipped.push({ name: verdict.name, reason: verdict.reason });
      continue;
    }
    if (verdict.kind === "unchanged") {
      result.unchanged++;
      continue;
    }
    try {
      await gateway.update(verdict.key.id, verdict.body);
    } catch {
      throw new JanitorFailure(
        "gateway-unavailable",
        `could not converge a key (${verdict.name})`,
      );
    }
    result.applied.push({ name: verdict.name, fields: verdict.fields });
    result.changed++;
  }

  return result;
};
