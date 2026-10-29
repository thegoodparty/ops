/**
 * The mint's decisions, with no AWS SDK and no `fetch` in them.
 *
 * Step 3 of `docs/bifrost-virtual-keys.md`; decisions 1, 2 and 4. The handler
 * (`vk-mint-handler.ts`) is the adapter layer — it reads the caller out of the
 * Function URL event, assumes the reader role, reads the template and the
 * setup token, and speaks HTTP to Bifrost. Everything a test can usefully
 * disagree with lives here, so the idempotency rules are checked without
 * mocking an SDK:
 *
 * - **The caller is the verified ARN and nothing else** (decision 2). The
 *   session name is the email; the request body is never read. The role must be
 *   an `AWSReservedSSO_WorkbenchAccess_*` role in the workbench account,
 *   because any other role in the account can choose its own session name.
 * - **Membership is checked on every call** (decision 1): the email is resolved
 *   to a user id and intersected with the `Engineers` group's members. Not a
 *   member is a `403`; a directory read that fails is a `503`. Neither mints.
 * - **The search API is a case-insensitive substring**, so a result set is
 *   filtered for the exact name here. `search=jeff@goodparty.org` also returns
 *   `xjeff@goodparty.org`, and handing back the wrong person's key would be the
 *   one failure this design must not have.
 * - **Names are unique, so idempotency survives a race** (decision 4): a losing
 *   create is a `409`, and the loser re-reads and returns the winner's key.
 * - **An inactive key keeps its name**, so a returning member is a reactivation
 *   in one `PUT` that also clears the janitor's deletion timer: `expires_at`
 *   empty and `delete_after_expire` null. An expiry in the past rejects a key
 *   whatever `is_active` says, and the deletion would take the spend history
 *   the reactivation exists to keep.
 */

import { WORKBENCH_ACCOUNT_ID } from "../../utils/accounts";

/**
 * The Identity Center group that decides who may hold a key (decision 1). It
 * is the group whose members hold `WorkbenchAccess` in the workbench account
 * and the one `engineering@goodparty.org` is mirrored into every fifteen
 * minutes.
 *
 * A literal because `deploy/components/identity-center.ts` does not export its
 * group map — `deploy/components/bifrost-vk-reader.ts` carries the same id in
 * its policy literal for the same reason, and
 * `deploy-workbench/bifrost-vk-mint.test.ts` reads that file so the two cannot
 * drift silently.
 */
export const ENGINEERS_GROUP_ID = "383193a0-7001-70d9-a321-ffe6d8af7378";

/** The SSO role prefix a caller's ARN must name, in the workbench account. */
export const WORKBENCH_ACCESS_ROLE_PREFIX = "AWSReservedSSO_WorkbenchAccess_";

/** One page of the gateway's list response, as far as the mint reads it. */
export type VirtualKey = {
  id: string;
  name: string;
  /**
   * The plaintext secret. `TableVirtualKey.MarshalJSON` at `transports/v2.3.0`
   * emits the resolved value, which is what lets the mint return an existing
   * key without keeping a copy anywhere (decision 4).
   */
  value?: string | null;
  is_active?: boolean | null;
  /** RFC3339, or empty/absent for "no expiry". */
  expires_at?: string | null;
  delete_after_expire?: boolean | null;
  description?: string | null;
};

export type KeyPage = {
  keys: VirtualKey[];
  /** The gateway's `total_count`; absent on a response that does not carry it. */
  totalCount?: number;
};

export type KeyQuery = { search: string; limit: number; offset: number };

/**
 * The gateway, as the mint uses it. `create` throws `KeyNameConflict` on a
 * `409`, and the adapter turns every other non-2xx into a `GatewayFailure`
 * whose message carries the status and never the response body.
 */
export type VirtualKeyGateway = {
  list: (query: KeyQuery) => Promise<KeyPage>;
  create: (body: Record<string, unknown>) => Promise<VirtualKey>;
  update: (id: string, body: Record<string, unknown>) => Promise<VirtualKey>;
};

/** The default key shape, read from the SSM parameter that stores the template. */
export type VirtualKeyTemplate = {
  description?: string;
  is_active?: boolean;
  provider_configs?: Array<{
    provider: string;
    allowed_models?: string[];
    key_ids?: string[];
  }>;
};

/**
 * Why a mint did not produce a key. The status is the HTTP status the function
 * returns, so the mapping is data rather than a branch in the handler.
 */
export type MintFailureCode =
  | "not-a-member"
  | "membership-unavailable"
  | "template-unavailable"
  | "gateway-unavailable"
  | "key-not-returned";

const FAILURE_STATUS: Record<MintFailureCode, number> = {
  "not-a-member": 403,
  // Fail closed on a directory read (decision 1): "I could not tell whether
  // this person is a member" is never "mint anyway".
  "membership-unavailable": 503,
  // A missing template or setup token is a deployment fault, not the caller's.
  "template-unavailable": 500,
  // The gateway refused or could not be reached; nothing was minted.
  "gateway-unavailable": 502,
  // The create lost a race and the winner's key could not be read back. Rare,
  // and the honest answer is that no key was returned.
  "key-not-returned": 502,
};

export class MintFailure extends Error {
  readonly status: number;

  constructor(
    readonly code: MintFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "MintFailure";
    this.status = FAILURE_STATUS[code];
  }
}

/** A create that lost the unique-name race. The caller re-reads (decision 4). */
export class KeyNameConflict extends Error {
  constructor() {
    super("a virtual key with this name already exists");
    this.name = "KeyNameConflict";
  }
}

/** A gateway response that was not a `2xx`, carrying no body. */
export class GatewayFailure extends Error {
  constructor(readonly status: number) {
    super(`Bifrost answered ${status}`);
    this.name = "GatewayFailure";
  }
}

/**
 * Who is calling, as AWS verified it. `email` is the assumed-role session name
 * lowercased; `roleArn` is kept for the log line so a refusal says which role
 * was refused without saying anything about the request.
 */
export type Caller = { email: string; roleArn: string; roleName: string };

const ASSUMED_ROLE_ARN =
  /^arn:aws:sts::(\d{12}):assumed-role\/([^/]+)\/([^/]+)$/;

/**
 * Reads the caller out of a Function URL event (payload format 2.0).
 *
 * `requestContext.authorizer.iam.userArn` is data AWS vouches for; nothing in
 * the request body or headers is consulted, which is the whole point of the
 * IAM-authenticated URL (decision 2). `undefined` means "refuse": a wrong
 * account, a role that is not `WorkbenchAccess`, an ARN that is not an
 * assumed-role ARN, or no authorizer at all. Direct `lambda:Invoke` delivers no
 * authorizer, so it lands here too.
 */
export const workbenchAccessCaller = (event: unknown): Caller | undefined => {
  if (typeof event !== "object" || event === null) return undefined;
  const requestContext = (event as { requestContext?: unknown }).requestContext;
  if (typeof requestContext !== "object" || requestContext === null) {
    return undefined;
  }
  const authorizer = (requestContext as { authorizer?: unknown }).authorizer;
  if (typeof authorizer !== "object" || authorizer === null) return undefined;
  const iam = (authorizer as { iam?: unknown }).iam;
  if (typeof iam !== "object" || iam === null) return undefined;
  const userArn = (iam as { userArn?: unknown }).userArn;
  if (typeof userArn !== "string") return undefined;

  const match = ASSUMED_ROLE_ARN.exec(userArn.trim());
  if (!match) return undefined;
  const [, accountId, roleName, sessionName] = match;
  if (accountId !== WORKBENCH_ACCOUNT_ID) return undefined;
  if (!roleName.startsWith(WORKBENCH_ACCESS_ROLE_PREFIX)) return undefined;

  const email = sessionName.trim().toLowerCase();
  // A session name with whitespace or another slash is not one this deployment
  // issues; refusing it keeps a malformed ARN from becoming a key name.
  if (!email || /\s/.test(email)) return undefined;

  return { email, roleArn: userArn, roleName };
};

/**
 * The directory reads the membership check makes, already scoped to the
 * `Engineers` group by the adapter that builds it under the reader role.
 */
export type MembershipDirectory = {
  /** `GetUserId` on `emails.value`; `null` when no such user exists. */
  getUserId: (email: string) => Promise<string | null>;
  /** Every page of `ListGroupMemberships` on the group, as user ids. */
  listMemberUserIds: () => Promise<readonly string[]>;
};

/**
 * Decision 1's second half: is this email in `Engineers` right now?
 *
 * The session name proves who the caller is, not that they still belong: a
 * `WorkbenchAccess` session lasts up to 12 hours, and a session that could
 * re-mint would undo the janitor's deactivation. A resolved user that is not in
 * the member set is a `403`; a read that throws is a `503`, which is the fail-
 * closed direction. An empty group therefore admits nobody, which is the same
 * guard the janitor applies to a mass read.
 */
export const requireEngineer = async (
  directory: MembershipDirectory,
  email: string,
): Promise<string> => {
  let userId: string | null;
  try {
    userId = await directory.getUserId(email);
  } catch {
    throw new MintFailure(
      "membership-unavailable",
      "could not resolve the caller's directory user",
    );
  }
  if (!userId) {
    throw new MintFailure("not-a-member", "the caller is not in Engineers");
  }

  let members: readonly string[];
  try {
    members = await directory.listMemberUserIds();
  } catch {
    throw new MintFailure(
      "membership-unavailable",
      "could not read Engineers' memberships",
    );
  }
  if (!members.includes(userId)) {
    throw new MintFailure("not-a-member", "the caller is not in Engineers");
  }
  return userId;
};

/**
 * How many keys one page of the search asks for, and the most pages the mint
 * will walk. `search` is a substring match, so a page can hold nothing but
 * `xjeff@...`; the walk is bounded so a pathological result set fails rather
 * than looping, and 20 pages of 100 is far more than one person's own matches.
 */
export const KEY_PAGE_SIZE = 100;
export const MAX_KEY_PAGES = 20;

/** The exact-name filter. Lowercased both sides; equality, never `includes`. */
export const findExactKey = (
  keys: readonly VirtualKey[],
  email: string,
): VirtualKey | undefined =>
  keys.find((key) => key.name.trim().toLowerCase() === email);

/**
 * Walks the search result set until the exact name appears or the set is
 * exhausted. The gateway's `total_count` decides when to stop, so an exact
 * match on a later page is still found; a response without `total_count` is
 * treated as one page, which is what the observed response carried.
 */
const listExactKey = async (
  gateway: VirtualKeyGateway,
  email: string,
): Promise<VirtualKey | undefined> => {
  let offset = 0;
  for (let page = 0; page < MAX_KEY_PAGES; page++) {
    const result = await gateway.list({
      search: email,
      limit: KEY_PAGE_SIZE,
      offset,
    });
    const match = findExactKey(result.keys, email);
    if (match) return match;

    const received = offset + result.keys.length;
    const total = result.totalCount ?? received;
    if (result.keys.length === 0 || received >= total) return undefined;
    offset = received;
  }
  throw new MintFailure(
    "gateway-unavailable",
    "the search result set did not end within the mint's page budget",
  );
};

/**
 * The reactivation `PUT` (decision 4), in full: active, no expiry, and the
 * deletion timer back to inheriting `client.delete_expired_virtual_keys`.
 *
 * One body, because the three fields are one decision. `expires_at: ""` is how
 * the update path spells "clear it", and `delete_after_expire: null` is the
 * tri-state's "back to inheriting" — omitting it would leave the janitor's
 * `true` in place, so a reactivated key would still be deleted on schedule.
 */
export const REACTIVATION_BODY = {
  is_active: true,
  expires_at: "",
  delete_after_expire: null,
} as const;

/** Whether an existing key has to be reactivated before it can be returned. */
export const needsReactivation = (key: VirtualKey): boolean =>
  key.is_active !== true ||
  (typeof key.expires_at === "string" && key.expires_at.trim() !== "");

export type MintAction = "existing" | "reactivated" | "created";

export type MintResult = { key: string; email: string; action: MintAction };

const requireKeyValue = (key: VirtualKey): string => {
  const value = key.value;
  if (typeof value !== "string" || value.length === 0) {
    throw new MintFailure("key-not-returned", "the gateway returned no key value");
  }
  return value;
};

/**
 * Returns an existing key, reactivating it first when it is inactive or still
 * carries an expiry. The reactivation is the same call a returning member
 * needs; it only ever runs for a caller the membership check has just admitted,
 * so a deactivated key is never a way back in for somebody who has left.
 */
const settleExisting = async (
  gateway: VirtualKeyGateway,
  email: string,
  key: VirtualKey,
): Promise<MintResult> => {
  if (!needsReactivation(key)) {
    return { key: requireKeyValue(key), email, action: "existing" };
  }
  const updated = await gateway.update(key.id, { ...REACTIVATION_BODY });
  return { key: requireKeyValue(updated), email, action: "reactivated" };
};

/**
 * Decision 4's invariant, in one function: for every person there is at most
 * one Lambda-managed key, and calling this twice returns the same key.
 *
 * The template supplies the shape (the marker, the provider allowlists, "no
 * budgets"); the email supplies the name. Nothing else in the body is read.
 */
export const mintVirtualKey = async (args: {
  gateway: VirtualKeyGateway;
  template: VirtualKeyTemplate;
  email: string;
}): Promise<MintResult> => {
  const { gateway, template, email } = args;

  const existing = await listExactKey(gateway, email);
  if (existing) return settleExisting(gateway, email, existing);

  let created: VirtualKey;
  try {
    created = await gateway.create({ ...template, name: email });
  } catch (error) {
    if (!(error instanceof KeyNameConflict)) throw error;
    // Another call won the unique-name race. Its key is the answer; re-reading
    // is what makes the loser's create safe to have attempted.
    const winner = await listExactKey(gateway, email);
    if (!winner) {
      throw new MintFailure(
        "key-not-returned",
        "a concurrent create won the name and the key could not be read back",
      );
    }
    return settleExisting(gateway, email, winner);
  }
  return { key: requireKeyValue(created), email, action: "created" };
};
