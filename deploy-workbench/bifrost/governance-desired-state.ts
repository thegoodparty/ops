/**
 * The governance desired state: one default template plus per-person
 * overrides, as data, with the merge and the validation in one place.
 *
 * Step 2 of `docs/bifrost-reconciler.md`. The two documents are the desired
 * state the reconciler converges the running node to (step 3), and the state
 * the minter creates from (step 5), so neither of those may hold its own copy
 * of the rules:
 *
 * - `vk-mint-template.json` is the default shape every Lambda-managed key
 *   gets. It is already the source for a minted key, stored at
 *   `/bifrost/vk-mint-template` by `deploy-workbench/bifrost-vk-mint.ts`; this
 *   module does not change it.
 * - `governance-overrides.json` is the new per-person document, stored at
 *   `/bifrost/governance-overrides` the same way. It is keyed by **lowercase
 *   email**, because that is the key's name (`docs/bifrost-virtual-keys.md`,
 *   "The key name is the lowercase email") and what the mint lowercases before
 *   it compares.
 *
 * Nothing reads either document from the gateway yet: this module is the merge
 * and the validation, which is what makes the documents reviewable and a bad
 * one a failed apply rather than a `400` retried every tick behind an alarm
 * (decision 10).
 *
 * ## The merge (decision 9)
 *
 * Field by field, at the top level. A field an override leaves out keeps the
 * template's value, and `"provider_configs": "inherit"` is the explicit
 * spelling of that for the one field where a reader otherwise has to know the
 * default to know what they are reading.
 *
 * `inherit` is refused on every other field on purpose. Absence already means
 * "keep the template's" everywhere, so a second spelling for the same thing
 * would only invite a reviewer to believe the two differ. And it is refused
 * inside a provider config, a budget or a rate limit for the same reason: a
 * half-inherited budget is not a thing the gateway can express.
 *
 * "Field by field" is top-level fields, not a deep merge. An override that
 * names `provider_configs` replaces the whole list — a provider entry is never
 * merged into the template's entry of the same name — because the wire field
 * is a replacement set (`UpdateVirtualKeyRequest.provider_configs`, and the
 * per-provider pruning in `governance.go` at the pinned tag), and a deep merge
 * would make an override that means to *narrow* a model list depend on the
 * template's list rather than restating the narrowing.
 *
 * ## What the validation refuses
 *
 * Everything the gateway would refuse later, and the three things a typo
 * produces: an unknown email, a field name the merge does not understand, and
 * `inherit` where it cannot be honoured. The reasons:
 *
 * - A document is written by a human, once, in review. The reconciler runs
 *   every five minutes and a `400` from it is the same `400` forever.
 * - An undercounted field is the one that does not announce itself: a
 *   misspelled `budget` would be silently ignored by a merge that only copies
 *   fields it knows.
 *
 * The email check has two halves. The shape is checked here; membership in the
 * `Engineers` group is a directory read, so it is checked by
 * `checkGovernanceOverrides` against a member set the caller supplies — the
 * deploy-time check through the reader role, and the tests with a literal set.
 * `npm test` holds no credentials (`deploy.yml` runs it in the credential-free
 * job), so this module never reaches the directory itself.
 *
 * ## Budgets, rate limits and calendar alignment
 *
 * `calendar_aligned: true` snaps a `1M` budget to the calendar month rather
 * than anchoring it at key creation (decision 11), and is a key-level field on
 * the wire, so it is a field of the desired state rather than of a budget.
 *
 * `rate_limit` has no default anywhere (decision 12): the template does not
 * carry one, and this module refuses a `rate_limit` field it cannot use (a
 * maximum with no reset duration, or a duration with no maximum), because on
 * the wire an empty one means "remove the limit" and an override should never
 * do that by accident.
 *
 * ## The merge, and who calls it
 *
 * `desiredStateFor` is the merge. `governanceDesiredState` (below) is the whole
 * of what a caller needs to write a key: the merge, the narrowing to the fields
 * governance owns, the `calendar_aligned` default, and the complete-set body.
 * Two callers use it and neither holds a copy: the reconciler
 * (`vk-janitor-core.ts`, step 3) converges existing keys to it, and the minter
 * (`vk-mint-core.ts`, step 5) creates a key from it.
 *
 * That the two share the function is the whole of step 5's guarantee. A mint and
 * a convergence that agreed only because each had its own transcription of the
 * rules would agree until one of them changed, and the failure mode is a key
 * that starts drifted and is written on the tick after every mint — with
 * `changed` counting it as a fight rather than the mint's mistake.
 */

import { isEmailShaped } from "./key-name";

/** The sentinel that says "keep the template's value for this field". */
export const GOVERNANCE_INHERIT = "inherit";

export type GovernanceInherit = typeof GOVERNANCE_INHERIT;

/** One budget, as the create/update routes take it (`CreateBudgetRequest`). */
export type GovernanceBudget = {
  max_limit: number;
  reset_duration: string;
};

/**
 * One rate limit (`CreateRateLimitRequest` / `UpdateRateLimitRequest`): a
 * maximum and the duration its window resets on, per resource type. Both
 * fields of a pair are required together — the table's `BeforeSave` refuses
 * one without the other, so the check here is the same rule one step earlier.
 */
export type GovernanceRateLimit = {
  token_max_limit?: number;
  token_reset_duration?: string;
  request_max_limit?: number;
  request_reset_duration?: string;
};

/**
 * One provider entry of a key's `provider_configs`.
 *
 * Deliberately absent, and refused if a document names one: `id` (the
 * reconciler matches entries by `provider`), and the three nested budget and
 * rate-limit fields (`budgets`, `model_budgets`, `rate_limit` under a provider
 * config). Per-provider limits are not in this plan; adding one is a field and
 * a validation rule, not a new mechanism.
 */
export type GovernanceProviderConfig = {
  provider: string;
  allowed_models?: string[];
  blacklisted_models?: string[];
  weight?: number;
  key_ids?: string[];
};

/** A key's governance, as the gateway's `PUT` takes it. */
export type GovernanceDesiredState = {
  description?: string;
  is_active?: boolean;
  provider_configs?: GovernanceProviderConfig[];
  budgets?: GovernanceBudget[];
  rate_limit?: GovernanceRateLimit;
  calendar_aligned?: boolean;
};

/**
 * One person's override. Every field is optional, and `provider_configs` may
 * also be the `inherit` sentinel.
 */
export type GovernanceOverride = Omit<
  Partial<GovernanceDesiredState>,
  "provider_configs"
> & {
  provider_configs?: GovernanceProviderConfig[] | GovernanceInherit;
};

/** The whole document, keyed by lowercase email. */
export type GovernanceOverrides = Record<string, GovernanceOverride>;

/**
 * The fields a document may set, in the order a reader of the file meets them.
 * `provider_configs` is here because it is the one field the sentinel applies
 * to; everything else is a value.
 */
export const GOVERNANCE_FIELDS = [
  "description",
  "is_active",
  "provider_configs",
  "budgets",
  "rate_limit",
  "calendar_aligned",
] as const;

/**
 * The one metadata key a document may carry. `$comment` is where the file
 * explains itself — the merge semantics, the duration forms, the reminder that
 * the console is overwritten — because JSON has no comments and a reviewable
 * document that cannot state its own rules gets them restated in three places
 * and drifts. It is stripped by the merge, so it never reaches the wire.
 *
 * Any other `$`-prefixed key is refused: the point of the exception is one.
 */
export const GOVERNANCE_METADATA_FIELDS = ["$comment"] as const;

/** A problem with a document, at the path in the document that caused it. */
export type GovernanceProblem = { path: string; message: string };

const BUDGET_FIELDS = ["max_limit", "reset_duration"] as const;
const RATE_LIMIT_FIELDS = [
  "token_max_limit",
  "token_reset_duration",
  "request_max_limit",
  "request_reset_duration",
] as const;
const PROVIDER_CONFIG_FIELDS = [
  "provider",
  "allowed_models",
  "blacklisted_models",
  "weight",
  "key_ids",
] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPositiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * The `inherit` sentinel, wherever it appears. A single test for the string,
 * because "it is an object with a field set to `inherit`" and "it is a field
 * set to `inherit`" have to be refused by the same words.
 */
const isInherit = (value: unknown): value is GovernanceInherit =>
  value === GOVERNANCE_INHERIT;

/* -------------------------------------------------------------------------
 * Durations
 * ---------------------------------------------------------------------- */

/**
 * `tables.ParseDuration` at the pinned tag
 * (`framework/configstore/tables/utils.go`, `transports/v2.3.2`), transcribed.
 *
 * The suffix forms are Bifrost's own and are not Go's: `d`, `w`, `M`, `Q` and
 * `Y` are multiplied out of a bare number — `ParseDuration("1M")` is 30 days —
 * where `m` is a minute and `1q` is refused outright, deliberately, so a
 * lowercase typo is an error rather than a quarter. Everything without one of
 * those five suffixes is Go's `time.ParseDuration`, which accepts `30s`,
 * `5m`, `1h30m`, `1.5h` and `500ms`.
 *
 * Transcribed rather than approximated because the whole point of validating
 * here is that the gateway will not refuse it later: a duration this accepts
 * and Bifrost rejects is a `400` on every tick, which is the failure the
 * validation exists to prevent. The forms are pinned by a table in
 * `governance-desired-state.test.ts`, and the day/month/quarter figures are
 * what `budget.go` uses for a rolling window.
 */
const BIFROST_SUFFIX_HOURS: Record<string, number> = {
  d: 24,
  w: 24 * 7,
  M: 24 * 30,
  Q: 24 * 90,
  Y: 24 * 365,
};

const GO_UNIT_MILLISECONDS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  "µs": 1e-3,
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
};

const GO_NUMBER = "(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
const GO_UNIT = "(?:ns|us|µs|ms|s|m|h)";
const GO_DURATION = new RegExp(`^[+-]?(?:${GO_NUMBER}${GO_UNIT})+$`);
const GO_PART = new RegExp(`(${GO_NUMBER})(${GO_UNIT})`, "g");
const BARE_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * A duration as milliseconds, or `undefined` for one Bifrost would refuse.
 *
 * Millisecond resolution only to keep the arithmetic readable; nothing here
 * distinguishes 1ns from 1µs, and a budget window does not either.
 */
export const parseBifrostDuration = (value: string): number | undefined => {
  if (value === "") return undefined;
  // Go's own special case: a bare "0" is a valid zero duration, and a budget
  // therefore refuses it on the `d <= 0` rule rather than as unparseable.
  if (value === "0") return 0;

  const suffix = value.slice(-1);
  const suffixHours = BIFROST_SUFFIX_HOURS[suffix];
  if (suffixHours !== undefined) {
    const prefix = value.slice(0, -1);
    if (!BARE_NUMBER.test(prefix)) return undefined;
    const hours = Number(prefix) * suffixHours;
    return Number.isFinite(hours) ? hours * GO_UNIT_MILLISECONDS.h : undefined;
  }

  if (!GO_DURATION.test(value)) return undefined;
  const sign = value.startsWith("-") ? -1 : 1;
  const unsigned = value.replace(/^[+-]/, "");
  let total = 0;
  for (const match of unsigned.matchAll(GO_PART)) {
    total += Number(match[1]) * GO_UNIT_MILLISECONDS[match[2]];
  }
  const milliseconds = sign * total;
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
};

/* -------------------------------------------------------------------------
 * Validation
 * ---------------------------------------------------------------------- */

/** Why a duration is not usable, in the words the gateway's own rules use. */
const durationProblem = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.trim() === "") {
    return "must be a duration string, e.g. \"1M\", \"1w\" or \"5m\"";
  }
  const milliseconds = parseBifrostDuration(value);
  if (milliseconds === undefined) {
    return `is not a duration Bifrost accepts: "${value}" (1d, 1w, 1M, 1Q, 1Y, or Go's 30s, 5m, 1h30m; "1q" is not a quarter)`;
  }
  if (milliseconds <= 0) {
    return `must be a positive duration: "${value}"`;
  }
  return undefined;
};

/**
 * The keys of `value` that are in none of `known`. Metadata is not a field of
 * anything but the document's top level, so it is not exempt here: a
 * `$comment` on a budget or a provider config is refused like any other
 * unknown key.
 */
/**
 * The sentinel, refused wherever it cannot be honoured.
 *
 * Run over every object a document holds, not only over the fields the merge
 * does not recognise: `"max_limit": "inherit"` names a real field, so an
 * unknown-field check would let it through to the number check and report "must
 * be a number" — true, and not the thing the author needs to read. Decision 9's
 * sentinel has exactly one honourable place, and saying so is the message.
 */
const checkNoInherit = (
  value: Record<string, unknown>,
  path: string,
  problems: GovernanceProblem[],
  where: string,
  /** The fields where the sentinel means something, and is therefore allowed. */
  allowed: readonly string[] = [],
): void => {
  for (const [key, field] of Object.entries(value)) {
    if (allowed.includes(key)) continue;
    if (!isInherit(field)) continue;
    problems.push({
      path: `${path}.${key}`,
      message: `"inherit" cannot be honoured ${where}; omit the field, or set the top-level "provider_configs": "inherit" to keep the template's provider list`,
    });
  }
};

const unknownFields = (
  value: Record<string, unknown>,
  known: readonly string[],
): string[] => Object.keys(value).filter((key) => !known.includes(key));

const isMetadataField = (key: string): boolean =>
  (GOVERNANCE_METADATA_FIELDS as readonly string[]).includes(key);

const checkMetadata = (
  value: unknown,
  path: string,
  problems: GovernanceProblem[],
): void => {
  const isStringList =
    Array.isArray(value) && value.every((line) => typeof line === "string");
  if (typeof value !== "string" && !isStringList) {
    problems.push({
      path,
      message: "must be a string or an array of strings",
    });
  }
};

/**
 * One provider entry. `inherit` inside it is refused: a provider config is a
 * whole entry of a replacement set, so there is nothing in it to inherit.
 */
const checkProviderConfig = (
  value: unknown,
  path: string,
  problems: GovernanceProblem[],
): void => {
  if (!isPlainObject(value)) {
    problems.push({ path, message: "must be an object" });
    return;
  }
  for (const key of unknownFields(value, PROVIDER_CONFIG_FIELDS)) {
    problems.push({
      path: `${path}.${key}`,
      message: isInherit(value[key])
        ? `"inherit" cannot be honoured inside a provider config; omit the field, or set "provider_configs": "inherit" to keep the template's list`
        : `is not a field of a provider config (${PROVIDER_CONFIG_FIELDS.join(", ")})`,
    });
  }
  checkNoInherit(value, path, problems, "inside a provider config");

  if (typeof value.provider !== "string" || value.provider.trim() === "") {
    problems.push({
      path: `${path}.provider`,
      message: "must name the provider, e.g. \"bedrock\"",
    });
  }

  for (const field of ["allowed_models", "blacklisted_models", "key_ids"]) {
    const list = value[field];
    if (list === undefined) continue;
    if (isInherit(list)) {
      // Named explicitly rather than left to the array check: `inherit` inside
      // a provider config is a refusal decision 9 makes on purpose, and the
      // message should say so instead of "must be an array".
      continue;
    }
    if (!Array.isArray(list) || list.length === 0) {
      problems.push({
        path: `${path}.${field}`,
        message: "must be a non-empty array of strings, or be left out",
      });
      continue;
    }
    for (const [index, entry] of list.entries()) {
      if (typeof entry !== "string" || entry.trim() === "") {
        problems.push({
          path: `${path}.${field}[${index}]`,
          message: "must be a non-empty string",
        });
      }
    }
  }

  if (value.weight !== undefined && !isNonNegativeFinite(value.weight)) {
    problems.push({
      path: `${path}.weight`,
      message: "must be a number, zero or greater",
    });
  }
};

/**
 * One budget. `id` and `reset_config` are refused rather than ignored: the
 * reconciler matches a budget by `reset_duration` (there are no ids in git),
 * and a fiscal-quarter start is a window setting this plan does not use. Both
 * are one field plus one rule if they are ever needed, and silently dropping
 * either is how a document stops meaning what it says.
 */
const checkBudget = (
  value: unknown,
  path: string,
  problems: GovernanceProblem[],
): void => {
  if (!isPlainObject(value)) {
    problems.push({ path, message: "must be an object" });
    return;
  }
  for (const key of unknownFields(value, BUDGET_FIELDS)) {
    problems.push({
      path: `${path}.${key}`,
      message: isInherit(value[key])
        ? `"inherit" cannot be honoured inside a budget; omit the budget, or "provider_configs": "inherit" to keep the template's provider list`
        : key === "id"
          ? "is not used here: a budget in this document is matched by reset_duration, so an id would be written and never read"
          : `is not a field of a budget (${BUDGET_FIELDS.join(", ")})`,
    });
  }
  checkNoInherit(value, path, problems, "inside a budget");

  if (!isNonNegativeFinite(value.max_limit)) {
    problems.push({
      path: `${path}.max_limit`,
      message: "must be a number, zero or greater, in dollars",
    });
  }

  const problem = durationProblem(value.reset_duration);
  if (problem) problems.push({ path: `${path}.reset_duration`, message: problem });
};

const checkBudgets = (
  value: unknown,
  path: string,
  problems: GovernanceProblem[],
): void => {
  if (!Array.isArray(value)) {
    problems.push({ path, message: "must be an array of budgets" });
    return;
  }
  value.forEach((budget, index) =>
    checkBudget(budget, `${path}[${index}]`, problems),
  );

  // The gateway refuses two budgets with one reset duration in the same set
  // (`governance.go`, the `seenDurations` check), and it has to: the reconciler
  // and the update path both match an existing budget by that duration when no
  // id is given, so two of them are ambiguous rather than merely redundant.
  const seen = new Map<string, number>();
  for (const [index, budget] of value.entries()) {
    if (!isPlainObject(budget)) continue;
    const duration = budget.reset_duration;
    if (typeof duration !== "string") continue;
    const first = seen.get(duration);
    if (first !== undefined) {
      problems.push({
        path: `${path}[${index}].reset_duration`,
        message: `duplicates ${path}[${first}]; the gateway refuses two budgets on one reset duration, and the reconciler matches by it`,
      });
    } else {
      seen.set(duration, index);
    }
  }
};

const checkRateLimit = (
  value: unknown,
  path: string,
  problems: GovernanceProblem[],
): void => {
  if (!isPlainObject(value)) {
    problems.push({ path, message: "must be an object" });
    return;
  }
  for (const key of unknownFields(value, RATE_LIMIT_FIELDS)) {
    problems.push({
      path: `${path}.${key}`,
      message: isInherit(value[key])
        ? `"inherit" cannot be honoured inside a rate limit; omit the rate_limit field entirely`
        : `is not a field of a rate limit (${RATE_LIMIT_FIELDS.join(", ")})`,
    });
  }
  checkNoInherit(value, path, problems, "inside a rate limit");

  const pairs = [
    ["token_max_limit", "token_reset_duration", "token"],
    ["request_max_limit", "request_reset_duration", "request"],
  ] as const;

  for (const [limitField, durationField, label] of pairs) {
    const limit = value[limitField];
    const duration = value[durationField];

    if (limit !== undefined) {
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
        problems.push({
          path: `${path}.${limitField}`,
          message: "must be a whole number greater than zero",
        });
      }
      if (duration === undefined) {
        problems.push({
          path: `${path}.${durationField}`,
          message: `is required when ${limitField} is set; a maximum with no window is refused by the gateway`,
        });
      }
    }

    if (duration !== undefined) {
      const problem = durationProblem(duration);
      if (problem) {
        problems.push({ path: `${path}.${durationField}`, message: problem });
      } else if (limit === undefined) {
        problems.push({
          path: `${path}.${durationField}`,
          message: `has no ${limitField} to apply to, so it would do nothing`,
        });
      }
    }
  }

  // An empty object is how an update says "remove the limit". An override that
  // meant nothing by it must not remove a limit nobody asked it to remove.
  if (!RATE_LIMIT_FIELDS.some((field) => value[field] !== undefined)) {
    problems.push({
      path,
      message:
        "names no limit; on the wire an empty rate_limit removes the key's limit, so omit the field to keep the template's",
    });
  } else if (
    value.token_max_limit === undefined &&
    value.request_max_limit === undefined
  ) {
    problems.push({
      path,
      message: "names only a reset duration; a rate limit needs a maximum",
    });
  }
};

/** One person's override. */
const checkOverride = (
  value: unknown,
  path: string,
  problems: GovernanceProblem[],
): void => {
  if (!isPlainObject(value)) {
    problems.push({ path, message: "must be an object of fields" });
    return;
  }

  for (const key of Object.keys(value)) {
    // Metadata is the document's own, not an override's: a `$comment` inside a
    // person's block has no reader and would either reach the gateway or be
    // dropped without a word.
    if (isMetadataField(key)) {
      problems.push({
        path: `${path}.${key}`,
        message:
          "belongs at the top level of the document, not inside an override; a note here is read by nobody",
      });
      continue;
    }
    if (!(GOVERNANCE_FIELDS as readonly string[]).includes(key)) {
      const hint = isInherit(value[key])
        ? `"inherit" is only honoured on provider_configs; every other field keeps the template's value by being absent`
        : `is not a field of the desired state (${GOVERNANCE_FIELDS.join(", ")})`;
      problems.push({ path: `${path}.${key}`, message: hint });
    }
  }
  checkNoInherit(value, path, problems, "here", ["provider_configs"]);

  if (value.description !== undefined) {
    if (typeof value.description !== "string" || value.description.trim() === "") {
      problems.push({
        path: `${path}.description`,
        message: "must be a non-empty string",
      });
    }
  }

  for (const field of ["is_active", "calendar_aligned"]) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      problems.push({ path: `${path}.${field}`, message: "must be true or false" });
    }
  }

  if (value.provider_configs !== undefined) {
    const configs = value.provider_configs;
    if (isInherit(configs)) {
      // The one honourable use of the sentinel: keep the template's list.
    } else if (!Array.isArray(configs)) {
      problems.push({
        path: `${path}.provider_configs`,
        message: `must be an array of provider configs, or "${GOVERNANCE_INHERIT}" to keep the template's`,
      });
    } else {
      configs.forEach((config, index) =>
        checkProviderConfig(config, `${path}.provider_configs[${index}]`, problems),
      );
      const seen = new Map<string, number>();
      for (const [index, config] of configs.entries()) {
        if (!isPlainObject(config) || typeof config.provider !== "string") continue;
        const first = seen.get(config.provider);
        if (first !== undefined) {
          problems.push({
            path: `${path}.provider_configs[${index}].provider`,
            message: `duplicates provider_configs[${first}]; one key has one entry per provider`,
          });
        } else {
          seen.set(config.provider, index);
        }
      }
    }
  }

  if (value.budgets !== undefined) {
    checkBudgets(value.budgets, `${path}.budgets`, problems);
  }

  if (value.rate_limit !== undefined) {
    checkRateLimit(value.rate_limit, `${path}.rate_limit`, problems);
  }
};

/**
 * Every problem with a parsed overrides document, or an empty list.
 *
 * `isMember` is the directory half: the caller supplies the `Engineers`
 * membership it read (or a literal set, in a test), and every email in the
 * document must be in it. Left out, only the shape of the email is checked —
 * which is what a caller without credentials can do, and what `npm test` does.
 */
export const validateGovernanceOverrides = (
  value: unknown,
  options: { isMember?: (email: string) => boolean } = {},
): GovernanceProblem[] => {
  const problems: GovernanceProblem[] = [];
  if (!isPlainObject(value)) {
    return [{ path: "document", message: "must be an object keyed by email" }];
  }

  const seen = new Map<string, string>();
  for (const [key, override] of Object.entries(value)) {
    const path = key;
    if (key.startsWith("$")) {
      if (!isMetadataField(key)) {
        problems.push({
          path,
          message: `is not a metadata field (${GOVERNANCE_METADATA_FIELDS.join(", ")}); every other key is an email`,
        });
      } else {
        checkMetadata(override, path, problems);
      }
      continue;
    }

    if (!isEmailShaped(key)) {
      problems.push({
        path,
        message: "is not an email address; the document is keyed by the key's name, which is the lowercase email",
      });
      continue;
    }
    if (key !== key.toLowerCase()) {
      problems.push({
        path,
        message: "is not lowercase; the key's name is the lowercase email, and an upper-case key here would never match it",
      });
    }
    const first = seen.get(key.toLowerCase());
    if (first !== undefined) {
      problems.push({
        path,
        message: `duplicates ${first} ignoring case; both would converge the same key`,
      });
    } else {
      seen.set(key.toLowerCase(), key);
    }

    if (options.isMember && !options.isMember(key.toLowerCase())) {
      problems.push({
        path,
        message:
          "is not in the Engineers group, so this override would be applied to a key nobody can hold; membership is checked at apply time, before the parameter is written",
      });
    }

    checkOverride(override, path, problems);
  }

  return problems;
};

/**
 * The same check over the document's text, so the committed file, the
 * parameter's value and a test fixture all go through one door.
 */
export const checkGovernanceOverrides = (
  text: string,
  options: { isMember?: (email: string) => boolean } = {},
): GovernanceProblem[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return [
      {
        path: "document",
        message: `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
  return validateGovernanceOverrides(parsed, options);
};

/** The problems as lines a failed apply can print. */
export const formatGovernanceProblems = (
  problems: readonly GovernanceProblem[],
): string =>
  problems.map((problem) => `  ${problem.path}: ${problem.message}`).join("\n");

/* -------------------------------------------------------------------------
 * The merge
 * ---------------------------------------------------------------------- */

/** The fields the composed state owns, and the only ones copied out. */
const COMPOSED_FIELDS = GOVERNANCE_FIELDS;

/**
 * Decision 9, in one function: the template with each field the override names
 * replaced, and every field it leaves out — or sets to `"inherit"` — kept.
 *
 * The result never carries a metadata key or an `inherit` sentinel: it is the
 * body the gateway is given, so a `$comment` reaching the wire would be an
 * unknown field at best and a rejected request at worst.
 */
export const composeGovernanceDesiredState = (
  template: GovernanceDesiredState,
  override?: GovernanceOverride,
): GovernanceDesiredState => {
  const composed: Record<string, unknown> = {};
  for (const field of COMPOSED_FIELDS) {
    const fromTemplate = (template as Record<string, unknown>)[field];
    const fromOverride = override
      ? (override as Record<string, unknown>)[field]
      : undefined;

    if (fromOverride === undefined || isInherit(fromOverride)) {
      if (fromTemplate !== undefined) composed[field] = fromTemplate;
    } else {
      composed[field] = fromOverride;
    }
  }
  return composed as GovernanceDesiredState;
};

/**
 * The desired state for one key, by the key's name.
 *
 * The name is the lowercase email, and the lookup lowercases for the same
 * reason the mint does: an override keyed `Jeff@goodparty.org` never matched a
 * key named `jeff@goodparty.org` is exactly the silent miss the validation
 * refuses, but a caller that already holds a mixed-case address must not miss
 * it either.
 *
 * No override is not a failure: it is the template, which is what most people
 * get and what a key minted before overrides existed already is.
 */
export const desiredStateFor = (
  template: GovernanceDesiredState,
  overrides: GovernanceOverrides,
  email: string,
): GovernanceDesiredState =>
  composeGovernanceDesiredState(template, overrides[email.toLowerCase()]);

/* -------------------------------------------------------------------------
 * What the reconciler and the minter both send
 *
 * Steps 3 and 5 of `docs/bifrost-reconciler.md`. This half is here, in step 2's
 * module, because it is the one place both callers can reach without one of
 * them importing the other: the reconciler converges an existing key to it and
 * the minter creates a key from it, and neither may hold a transcription of the
 * rules. See this module's header for why that is the point of step 5.
 * ---------------------------------------------------------------------- */

/**
 * The fields governance owns, as the reconciler's diff compares them.
 *
 * `description` and `is_active` are deliberately **not** here even though the
 * template carries them. The template's `description` is the marker the janitor
 * matches on, and `is_active` is a decision two other jobs own: the janitor sets
 * it false with a deletion timer, and the mint sets it true to reactivate. A
 * convergence loop that re-asserted the template's `is_active: true` every five
 * minutes would undo a revocation within one tick.
 *
 * They are left out of the create body for the mirror-image reason: the mint's
 * body carries the template's own `description` and `is_active` (which is how a
 * new key gets the marker and starts active), so a composed state that also
 * carried them would be a second, divergent spelling of the same two fields in
 * one request.
 */
export const RECONCILED_FIELDS = [
  "provider_configs",
  "budgets",
  "rate_limit",
  "calendar_aligned",
] as const;

export type ReconciledField = (typeof RECONCILED_FIELDS)[number];

/**
 * The template as the desired-state computation reads it: the governance
 * fields, with no metadata and no per-call fields.
 *
 * A structural superset of the mint's `VirtualKeyTemplate` rather than a second
 * declaration of it: the create path and the converge path read the same SSM
 * document, so a field the template gains is a field both see.
 */
export type GovernanceTemplate = {
  description?: string;
  is_active?: boolean;
  provider_configs?: GovernanceProviderConfig[];
  budgets?: GovernanceBudget[];
  rate_limit?: GovernanceRateLimit;
  calendar_aligned?: boolean;
};

/**
 * Where the composed `provider_configs` came from.
 *
 * Decision 9's whole point is that "inherit" and "absent" mean the same value
 * and different statements, so the composition records which it was. Nothing on
 * the wire reads it; a test does.
 */
export type ProviderConfigsSource = "override" | "inherit" | "absent";

export type ComposedDesiredState = {
  /** The complete desired governance for one key, ready for `governanceBody`. */
  state: GovernanceDesiredState;
  providerConfigsSource: ProviderConfigsSource;
};

/**
 * The desired state for one key: the template merged field by field with that
 * person's override, narrowed to the fields governance owns.
 *
 * The merge is `desiredStateFor` above, not a second copy of the rules. On top
 * of it: the narrowing to `RECONCILED_FIELDS`, and the `calendar_aligned`
 * default.
 *
 * `calendar_aligned` is asserted rather than inherited. Decision 11 is the
 * fleet's rule, not a per-document one, so a template that forgot the field
 * still converges every key to a calendar-aligned window. An override that says
 * `false` still wins, because the document is the authority for the people it
 * names.
 */
export const governanceDesiredState = (args: {
  template: GovernanceTemplate;
  overrides: GovernanceOverrides;
  email: string;
}): ComposedDesiredState => {
  const merged = desiredStateFor(args.template, args.overrides, args.email);

  const state: GovernanceDesiredState = {};
  for (const field of RECONCILED_FIELDS) {
    const value = (merged as Record<string, unknown>)[field];
    if (value === undefined) continue;
    (state as Record<string, unknown>)[field] = value;
  }

  // Decision 11. Set on the composed state rather than on the template so no
  // future document edit can drop it by accident.
  if (state.calendar_aligned === undefined) state.calendar_aligned = true;
  // An empty `rate_limit` would mean "remove the key's limit" on the wire,
  // which is the opposite of a field with no default (decision 12).
  if (state.rate_limit && Object.keys(state.rate_limit).length === 0) {
    delete state.rate_limit;
  }

  const fromOverride = args.overrides[args.email.toLowerCase()]?.provider_configs;
  const providerConfigsSource: ProviderConfigsSource =
    fromOverride === undefined
      ? "absent"
      : fromOverride === GOVERNANCE_INHERIT
        ? "inherit"
        : "override";

  return { state, providerConfigsSource };
};

/**
 * The name the reconciler's callers had before the mint became the second one.
 *
 * Kept rather than renamed in the callers: step 3's tests and assertions name
 * it, and a step about the minter should not churn the convergence loop's diff
 * for a name. The mint calls the same function under the name that says who it
 * is for, and there is exactly one implementation behind both.
 */
export const composeDesiredState = governanceDesiredState;

/**
 * The complete governance body for one key, whether it is being created or
 * converged.
 *
 * Complete is the load-bearing word, and it is what makes the whole approach
 * safe against a replacement set. The body carries the whole composed
 * `provider_configs`, every budget, and the key's own `calendar_aligned`; it
 * carries no budget ids (git holds none, and the update path matches on
 * `reset_duration` when none is given) and never `reset_budget_usage` (clearing
 * usage is opt-in on the wire, and nothing here has a reason to opt in).
 *
 * **`budgets` and `provider_configs` are always sent, even when the composed
 * state names none**, because both are replacement sets and the body has to
 * match what a diff compared. The asymmetry with `rate_limit` below is not an
 * inconsistency: `rate_limit` omission genuinely means "leave the key's alone"
 * and the reconciler's diff skips it for that reason, while an omitted
 * `budgets` or `provider_configs` also means "leave them alone" — so leaving
 * either out would make the diff report a difference the `PUT` cannot fix, and
 * the run would rewrite that key forever with `changed` never reaching zero. An
 * empty array is what actually clears a set the desired state no longer names,
 * which is what makes "rollback is a revert plus one tick" true for a budget an
 * override drops (success criterion 6).
 *
 * On the create path the same two fields mean "this key has these and no
 * others", which is the shape the desired state has just computed, so the mint
 * sends this body's contents spread into its create request. It sends them
 * rather than the composed state itself because the two differ in one place:
 * the body drops `id`s from budget rows, and a create carries none either.
 */
export const governanceBody = (
  state: GovernanceDesiredState,
): Record<string, unknown> => {
  const body: Record<string, unknown> = {};

  if (state.calendar_aligned !== undefined) {
    body.calendar_aligned = state.calendar_aligned;
  }

  // Always, even empty: see the comment above. `provider_configs` is the field
  // whose omission deletes the entries' budgets and rate limits, so leaving it
  // out while the diff compared it is the one shape that never converges.
  body.provider_configs = (state.provider_configs ?? []).map((config) => {
    const entry: Record<string, unknown> = { provider: config.provider };
    if (config.allowed_models !== undefined) {
      entry.allowed_models = config.allowed_models;
    }
    if (config.blacklisted_models !== undefined) {
      entry.blacklisted_models = config.blacklisted_models;
    }
    if (config.weight !== undefined) entry.weight = config.weight;
    if (config.key_ids !== undefined) entry.key_ids = config.key_ids;
    return entry;
  });

  // Always, even empty, for the same reason: an empty list is how the desired
  // state says "this key has no budgets", and it is the only thing that removes
  // one an override has dropped.
  body.budgets = (state.budgets ?? []).map((budget) => ({
    max_limit: budget.max_limit,
    reset_duration: budget.reset_duration,
  }));

  if (state.rate_limit !== undefined) {
    const limit: Record<string, unknown> = {};
    for (const field of [
      "token_max_limit",
      "token_reset_duration",
      "request_max_limit",
      "request_reset_duration",
    ] as const) {
      const value = state.rate_limit[field];
      if (value !== undefined) limit[field] = value;
    }
    body.rate_limit = limit;
  }

  return body;
};

/**
 * The reconciler's name for `governanceBody`: the complete set a `PUT` carries.
 *
 * One implementation, two names, on the same reasoning as
 * `composeDesiredState` above: step 3's diff and tests read `convergenceBody`,
 * and step 5 adds a second caller rather than a second body.
 */
export const convergenceBody = governanceBody;
