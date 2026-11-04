/**
 * Config convergence: the live subset of `bifrost/config.json`, diffed against
 * what the running gateway reports, and `PUT` where they disagree.
 *
 * Step 4 of `docs/bifrost-reconciler.md`, and the half of the plan that makes
 * the digest split (step 1) mean something. Step 1 stopped a live-subset edit
 * from registering a new task-definition revision, which removed the restarts
 * but left the edit with nowhere to land unless something applies it to the
 * process that is already running. This is that something, and its caller is
 * the deploy's `RequestResponse` invoke, because the moment that matters is the
 * one where an apply has just reported success.
 *
 * **Only the deploy's invoke, not the schedule.** Decision 16 of the plan bounds
 * config convergence at one deploy, and decision 4 gives the scheduled rule
 * governance and revocation. The handler enforces that (`runConfigConvergence`),
 * so a tick reports `not-run` for this half; here it matters only because it is
 * why this loop does not need to tolerate running against a task that started
 * from the file anyway.
 *
 * ## Why it reads the server's own view before it writes
 *
 * The same reason `bifrost/bootstrap.sh` does, and it is the trap that file
 * documents at length: `PUT /api/config` takes `client_config` as a **value**,
 * and the handler assigns several of its fields unconditionally. A body
 * synthesised from `config.json` therefore drops every setting the store holds
 * that the file does not name. So the write is always `GET /api/config` with the
 * file's live fields overlaid, never a fragment. `PUT /api/providers/{provider}`
 * has the same shape for `network_config` (it is not one of the blocks the
 * handler reads "only when carried"), so that one is merged the same way.
 *
 * A provider key's update is the opposite and is used as such: `decodeKeyUpdate`
 * preserves every field the body omits, so the key `PUT` carries **only** the
 * fields that differ. That is what makes a diff-before-write loop safe here: an
 * omitted `value` keeps the stored credential, which is also the one field this
 * module must never hold (decision 2 of the reconciler plan).
 *
 * ## What it converges, and the one thing it refuses
 *
 * Every leaf `BIFROST_LIVE_PATHS` claims:
 *
 * - `client` → `PUT /api/config`, field by field, merged onto the server's view.
 * - `providers.*.network_config`, `providers.*.prompt_cache` →
 *   `PUT /api/providers/{provider}`.
 * - `providers.*.keys[].name`, `.models`, `.aliases`, `.weight`,
 *   `.blacklisted_models`, `.bedrock_key_config` →
 *   `PUT /api/providers/{provider}/keys/{key_id}`, matched by name.
 * - `$schema` is live and has no runtime effect, so it is named as skipped
 *   rather than pretended to be converged.
 *
 * `governance` is the refusal, and it is worth stating because the plan's split
 * table calls it live. It is live in the sense that `PUT /api/config` accepts
 * `auth_config`. What the file actually holds there is
 * `admin_username: "env.BIFROST_ADMIN_USERNAME"` and
 * `admin_password: "env.BIFROST_ADMIN_PASSWORD"` — `env.` references only the
 * task can resolve, exactly like a provider key's value. A reconciler that
 * wanted to write them would have to hold the admin password, which is the same
 * security decision decision 2 refuses for provider credentials, and for the
 * same reason. The section is provisioned at boot from the file and by the
 * claim container, so it is applied today; this loop names it in `skipped` with
 * `env-reference` rather than silently dropping it.
 *
 * ## Why the diff is a counted number here too
 *
 * Decision 6's argument does not change with the caller. An unconditional
 * rewrite of the client config on every deploy would rewrite the store and
 * republish the configuration for a file that had not moved, and `changed: 0`
 * is what makes "this apply had nothing to converge" a fact a run log can state
 * rather than a reader having to trust.
 *
 * Nothing in this module knows about AWS, `fetch` or a clock: the gateway is an
 * interface, so `config-convergence-core.test.ts` drives it with a fake, the
 * same way `vk-janitor-core.test.ts` drives the governance loop.
 */

import { JanitorFailure } from "./vk-janitor-core";

/**
 * Where a config divergence was found, in the terms the run log and the file
 * use. `applied` entries are one line per section rather than per field: a
 * field's name is the diagnosis, and the section is the write.
 */
export type ConfigSection =
  | "client"
  | `provider:${string}`
  | `key:${string}/${string}`;

/** Why a live part of the file was not written by this loop. */
export type ConfigSkipReason =
  /** The section holds `env.` references only the task can resolve. */
  | "env-reference"
  /** Live per the path list, with no runtime effect to converge. */
  | "no-runtime-effect"
  /** A provider or key the gateway does not have. Convergence never creates. */
  | "not-present";

export type ConfigConvergenceResult = {
  /**
   * `converged` is the only value a run that converged returns: a failed write
   * throws a `JanitorFailure`, so the invocation fails and step 6's alarm has
   * something to count (decision 15). The deploy's poll reads this field, and
   * anything else in it is a run that did not converge.
   *
   * `not-run` is the scheduled tick, which does not converge config at all. See
   * `configConvergenceFor` for why the trigger decides that rather than the loop
   * running everywhere.
   */
  outcome: "converged" | "not-run";
  /** Why the loop did not run, when it did not. */
  reason?: "not-this-trigger";
  /** How many sections the gateway was told about. The honest "changed". */
  changed: number;
  /** How many live sections already matched. */
  unchanged: number;
  applied: Array<{ section: ConfigSection; fields: string[] }>;
  skipped: Array<{ path: string; reason: ConfigSkipReason }>;
};

/** The live client config, as `config.json` declares it. */
export type LiveClientConfig = Record<string, unknown>;

export type LiveProviderConfig = {
  provider: string;
  network_config?: Record<string, unknown>;
  prompt_cache?: Record<string, unknown>;
};

/**
 * One provider key as far as the live subset is concerned: everything the key
 * update can set except `value`, which is boot-only and must never be held here.
 */
export type LiveProviderKey = {
  provider: string;
  name: string;
  fields: {
    name?: string;
    models?: string[];
    blacklisted_models?: string[];
    weight?: number;
    aliases?: Record<string, unknown>;
    bedrock_key_config?: Record<string, unknown>;
  };
};

/** The whole desired state this loop converges. */
export type ConfigDesiredState = {
  client?: LiveClientConfig;
  providers: LiveProviderConfig[];
  keys: LiveProviderKey[];
  skipped: Array<{ path: string; reason: ConfigSkipReason }>;
};

/**
 * The gateway, as config convergence uses it: the reads the diff needs and the
 * three writes it may make.
 *
 * Every method returns the parsed response body, or throws a `GatewayFailure`
 * carrying only a status. `getProvider` answers `null` for a provider the
 * gateway does not have, because convergence does not create providers: adding
 * one is a boot-only change in `config.json` that rolls the task, and minting
 * access is the mint's (decision 7).
 */
export type ConfigGateway = {
  getConfig: () => Promise<Record<string, unknown>>;
  putConfig: (body: Record<string, unknown>) => Promise<void>;
  getProvider: (provider: string) => Promise<Record<string, unknown> | null>;
  putProvider: (provider: string, body: Record<string, unknown>) => Promise<void>;
  listProviderKeys: (provider: string) => Promise<Array<Record<string, unknown>>>;
  putProviderKey: (
    provider: string,
    keyId: string,
    body: Record<string, unknown>,
  ) => Promise<void>;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown): Record<string, unknown> =>
  isPlainObject(value) ? value : {};

/**
 * The sections of the file this loop cannot converge, with the reason. Named
 * here, once, so `liveConfigDesiredState` and the coverage test read the same
 * list and a section that stops being refused is a visible edit rather than a
 * silent omission.
 */
export const UNCONVERGED_LIVE_SECTIONS: ReadonlyArray<{
  path: string;
  reason: ConfigSkipReason;
}> = [
  {
    path: "$schema",
    reason: "no-runtime-effect",
  },
  {
    path: "governance",
    reason: "env-reference",
  },
];

/** The client config fields, in the order the file declares them. */
const clientFields = (client: Record<string, unknown>): LiveClientConfig => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(client)) out[key] = value;
  return out;
};

/**
 * The desired state, from the committed file's text.
 *
 * Parsed rather than read as bytes for the reason step 1's digest parses:
 * whitespace and key order are not configuration, and the question is which
 * values the running process should hold.
 *
 * A provider key is identified by its `name`, which is how the gateway's key
 * list identifies one too, and the association is by provider. A key with no
 * name is skipped rather than guessed at: the update route needs an id, and an
 * unnamed key is a config.json mistake the drift test in `config.test.ts`
 * already governs.
 */
export const liveConfigDesiredState = (
  configText: string,
): ConfigDesiredState => {
  const parsed: unknown = JSON.parse(configText);
  const config = record(parsed);

  const providers: LiveProviderConfig[] = [];
  const keys: LiveProviderKey[] = [];

  for (const [provider, raw] of Object.entries(record(config.providers))) {
    const providerConfig = record(raw);
    const desired: LiveProviderConfig = { provider };
    if (isPlainObject(providerConfig.network_config)) {
      desired.network_config = providerConfig.network_config;
    }
    if (isPlainObject(providerConfig.prompt_cache)) {
      desired.prompt_cache = providerConfig.prompt_cache;
    }
    if (desired.network_config || desired.prompt_cache) providers.push(desired);

    const rawKeys = Array.isArray(providerConfig.keys) ? providerConfig.keys : [];
    for (const entry of rawKeys) {
      const key = record(entry);
      const name = typeof key.name === "string" ? key.name : undefined;
      if (!name) continue;
      const fields: LiveProviderKey["fields"] = { name };
      if (Array.isArray(key.models) && key.models.every((m) => typeof m === "string")) {
        fields.models = key.models as string[];
      }
      if (
        Array.isArray(key.blacklisted_models) &&
        key.blacklisted_models.every((m) => typeof m === "string")
      ) {
        fields.blacklisted_models = key.blacklisted_models as string[];
      }
      if (typeof key.weight === "number") fields.weight = key.weight;
      if (isPlainObject(key.aliases)) fields.aliases = key.aliases;
      if (isPlainObject(key.bedrock_key_config)) {
        fields.bedrock_key_config = key.bedrock_key_config;
      }
      keys.push({ provider, name, fields });
    }
  }

  const desired: ConfigDesiredState = {
    providers,
    keys,
    skipped: [...UNCONVERGED_LIVE_SECTIONS],
  };
  if (isPlainObject(config.client)) desired.client = clientFields(config.client);
  return desired;
};

/** Two values as the config API would report them, for an equality test. */
const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, i) => sameValue(entry, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key, i) => key === bKeys[i] && sameValue(a[key], b[key]));
  }
  return false;
};

/**
 * The client fields the file names that the gateway reports differently.
 *
 * Only the fields the file names are compared, which is the same rule
 * `vk-janitor-core.ts` applies to `rate_limit`: a setting the file does not
 * mention is not drift this loop fights, because removing it would be a change
 * nobody asked for and `PUT /api/config` would be the place it silently
 * happened.
 */
export const differingClientFields = (
  desired: LiveClientConfig,
  observed: unknown,
): string[] => {
  const observedConfig = record(observed);
  return Object.keys(desired)
    .filter((field) => !sameValue(desired[field], observedConfig[field]))
    .sort();
};

/**
 * The provider blocks that differ.
 *
 * Compared whole, because both are replacement blocks on the wire: a supplied
 * `network_config` overwrites the stored one entirely rather than merging field
 * by field.
 */
export const differingProviderFields = (
  desired: LiveProviderConfig,
  observed: Record<string, unknown>,
): string[] => {
  const differ: string[] = [];
  if (
    desired.network_config !== undefined &&
    !sameValue(desired.network_config, stripResponseOnly(record(observed.network_config)))
  ) {
    differ.push("network_config");
  }
  if (
    desired.prompt_cache !== undefined &&
    !sameValue(desired.prompt_cache, record(observed.prompt_cache))
  ) {
    differ.push("prompt_cache");
  }
  return differ;
};

/**
 * `providerNetworkConfigResponse` in Bifrost adds one field the request shape
 * does not take: `extra_headers_secret_vars`, the same headers as readable
 * `SecretVar` objects. Echoing it back would be an unknown field on the update
 * path at best, and it is never a difference worth a write, so it is dropped
 * before the comparison and before the merge.
 */
const stripResponseOnly = (
  networkConfig: Record<string, unknown>,
): Record<string, unknown> => {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(networkConfig)) {
    if (key === "extra_headers_secret_vars") continue;
    copy[key] = value;
  }
  return copy;
};

/**
 * A JSON value with object keys sorted, so two maps that mean the same thing
 * compare equal. Exists for the alias comparison, whose sides are built from
 * different key orders.
 */
const sortObject = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!isPlainObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortObject(value[key]);
  return sorted;
};

/**
 * The comparison form of an alias map, with the fields the file names kept and
 * every other field dropped.
 *
 * Dropping the rest is deliberate and it is the diff's whole job: the gateway
 * carries an alias's resolved `region`/`project` and its provider sub-configs,
 * and none of those is git's to own. Whether an alias the file does not name
 * exists at all is a difference (that is the replacement-set rule), which the
 * key sets handle.
 */
/**
 * One key's aliases as a comparable value.
 *
 * Bifrost accepts and emits two wire shapes for a key's aliases: a bare string
 * (`{"my-model": "provider-model-id"}`) and an object
 * (`{"my-model": {"model_id": ..., ...}}`). The committed file uses the object
 * form; the gateway may emit either, so a bare string is normalised to
 * `{model_id}` here or a key with a string alias would differ on every deploy
 * and be rewritten forever.
 */
const aliasMapKey = (
  aliases: Record<string, unknown>,
  only: readonly string[] | undefined,
): string => {
  const entries: Array<[string, string]> = [];
  for (const [source, value] of Object.entries(aliases)) {
    let comparable: Record<string, unknown> =
      typeof value === "string" ? { model_id: value } : record(sortObject(value));
    if (only) {
      const filtered: Record<string, unknown> = {};
      for (const field of only) {
        if (comparable[field] !== undefined) filtered[field] = comparable[field];
      }
      comparable = filtered;
    }
    entries.push([source, JSON.stringify(comparable)]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
};

/** The fields of one provider key the gateway reports differently. */
export const differingKeyFields = (
  desired: LiveProviderKey,
  observed: Record<string, unknown>,
): string[] => {
  const differ: string[] = [];
  const { fields } = desired;

  if (fields.name !== undefined && fields.name !== observed.name) {
    differ.push("name");
  }
  if (
    fields.models !== undefined &&
    !sameValue(fields.models, observed.models ?? [])
  ) {
    differ.push("models");
  }
  if (
    fields.blacklisted_models !== undefined &&
    !sameValue(fields.blacklisted_models, observed.blacklisted_models ?? [])
  ) {
    differ.push("blacklisted_models");
  }
  if (
    fields.weight !== undefined &&
    !sameValue(fields.weight, observed.weight ?? 0)
  ) {
    differ.push("weight");
  }
  if (fields.aliases !== undefined) {
    const desiredAlias = fields.aliases as Record<string, unknown>;
    // The fields the file names on each entry are the ones compared, so the
    // gateway's resolved extras cannot make this differ every run.
    const only = [
      ...new Set(
        Object.values(desiredAlias).flatMap((entry) =>
          isPlainObject(entry) ? Object.keys(entry) : [],
        ),
      ),
    ].sort();
    if (
      aliasMapKey(desiredAlias, only) !==
      aliasMapKey(record(observed.aliases), only)
    ) {
      differ.push("aliases");
    }
  }
  if (
    fields.bedrock_key_config !== undefined &&
    !sameValue(fields.bedrock_key_config, record(observed.bedrock_key_config))
  ) {
    differ.push("bedrock_key_config");
  }

  return differ;
};

/**
 * The `PUT /api/config` body: the server's own view with the file's live client
 * fields overlaid.
 *
 * Never a fragment. See the header: the handler assigns several client fields
 * unconditionally, so a body carrying only what `config.json` names would clear
 * everything else the store holds.
 */
export const clientConfigBody = (
  observedConfig: Record<string, unknown>,
  desired: LiveClientConfig,
): Record<string, unknown> => ({
  ...observedConfig,
  client_config: { ...record(observedConfig.client_config), ...desired },
});

/**
 * The `PUT /api/providers/{provider}` body: the stored `network_config` with the
 * file's overlaid, the stored concurrency block passed back unchanged (the route
 * refuses a zero one), and `prompt_cache` only when the file names it — that
 * block is one of the "only when carried" ones, so sending it unconditionally
 * would clear a block the file does not mention.
 */
export const providerBody = (
  observedProvider: Record<string, unknown>,
  desired: LiveProviderConfig,
): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  if (desired.network_config !== undefined) {
    body.network_config = {
      ...stripResponseOnly(record(observedProvider.network_config)),
      ...desired.network_config,
    };
  }
  if (isPlainObject(observedProvider.concurrency_and_buffer_size)) {
    body.concurrency_and_buffer_size = observedProvider.concurrency_and_buffer_size;
  }
  if (desired.prompt_cache !== undefined) {
    body.prompt_cache = desired.prompt_cache;
  }
  return body;
};

/**
 * The `PUT /api/providers/{provider}/keys/{key_id}` body: only the fields that
 * differed.
 *
 * The one body in this module that is a patch rather than a replacement, and
 * that is what the route implements (`decodeKeyUpdate`: a field the body leaves
 * out keeps its stored value). It is also what keeps the key's `value` out of
 * the request entirely.
 */
export const providerKeyBody = (
  desired: LiveProviderKey,
  fields: readonly string[],
): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    const value = (desired.fields as Record<string, unknown>)[field];
    if (value !== undefined) body[field] = value;
  }
  return body;
};

/**
 * The result a run reports for a half it did not attempt.
 *
 * Exported so the handler's "the schedule does not converge config" branch is one
 * call rather than an object literal in a `catch`-adjacent block, and so a test
 * can assert the shape the summary reads.
 */
export const configConvergenceNotRun = (): ConfigConvergenceResult => ({
  outcome: "not-run",
  reason: "not-this-trigger",
  changed: 0,
  unchanged: 0,
  applied: [],
  skipped: [],
});

/**
 * The loop: one `GET` and at most one `PUT` per live section, in the order the
 * file declares them.
 *
 * Every read happens before the section's write, and a failed write throws
 * rather than continuing: a gateway that just refused a `PUT` is not a gateway
 * to carry on converging against, which is the same rule both halves of
 * `vk-janitor-core.ts` apply.
 */
export const convergeConfig = async (args: {
  gateway: ConfigGateway;
  desired: ConfigDesiredState;
}): Promise<ConfigConvergenceResult> => {
  const { gateway, desired } = args;
  const result: ConfigConvergenceResult = {
    outcome: "converged",
    changed: 0,
    unchanged: 0,
    applied: [],
    skipped: [...desired.skipped],
  };

  const fail = (what: string): never => {
    throw new JanitorFailure("convergence-failed", what);
  };

  if (desired.client) {
    let observed: Record<string, unknown>;
    try {
      observed = await gateway.getConfig();
    } catch {
      throw new JanitorFailure(
        "config-unavailable",
        "could not read the gateway's config",
      );
    }
    const fields = differingClientFields(desired.client, observed.client_config);
    if (fields.length === 0) {
      result.unchanged++;
    } else {
      try {
        await gateway.putConfig(clientConfigBody(observed, desired.client));
      } catch {
        fail("could not apply the live client config");
      }
      result.applied.push({ section: "client", fields });
      result.changed++;
    }
  }

  for (const provider of desired.providers) {
    let observed: Record<string, unknown> | null;
    try {
      observed = await gateway.getProvider(provider.provider);
    } catch {
      throw new JanitorFailure(
        "config-unavailable",
        `could not read the provider (${provider.provider})`,
      );
    }
    if (observed === null) {
      // Adding a provider needs its key values, which are boot-only, so a
      // provider the running gateway does not have is a boot change and a
      // restart. Named rather than silent: a file that gained a provider and a
      // gateway that did not is worth seeing in the run log.
      result.skipped.push({
        path: `providers.${provider.provider}`,
        reason: "not-present",
      });
      continue;
    }
    const fields = differingProviderFields(provider, observed);
    if (fields.length === 0) {
      result.unchanged++;
    } else {
      try {
        await gateway.putProvider(provider.provider, providerBody(observed, provider));
      } catch {
        fail(`could not apply a provider's live config (${provider.provider})`);
      }
      result.applied.push({
        section: `provider:${provider.provider}`,
        fields,
      });
      result.changed++;
    }
  }

  for (const key of desired.keys) {
    let observedKeys: Array<Record<string, unknown>>;
    try {
      observedKeys = await gateway.listProviderKeys(key.provider);
    } catch {
      throw new JanitorFailure(
        "config-unavailable",
        `could not list a provider's keys (${key.provider})`,
      );
    }
    const observed = observedKeys.find((entry) => entry.name === key.name);
    if (!observed) {
      result.skipped.push({
        path: `providers.${key.provider}.keys[name=${key.name}]`,
        reason: "not-present",
      });
      continue;
    }
    const id = typeof observed.id === "string" ? observed.id : undefined;
    if (!id) {
      throw new JanitorFailure(
        "config-unavailable",
        `the gateway reports no id for a provider key (${key.provider}/${key.name})`,
      );
    }
    const fields = differingKeyFields(key, observed);
    if (fields.length === 0) {
      result.unchanged++;
      continue;
    }
    try {
      await gateway.putProviderKey(key.provider, id, providerKeyBody(key, fields));
    } catch {
      fail(`could not apply a provider key's live config (${key.provider}/${key.name})`);
    }
    result.applied.push({
      section: `key:${key.provider}/${key.name}`,
      fields,
    });
    result.changed++;
  }

  return result;
};
