// The deterministic half of a plan-gated review, and only that half: no
// network, no model, no GitHub types. `bundle.ts` hands in the PR body, the
// base ref, the changed paths and the two files it read from GitHub
// (`CODEOWNERS` and the plan); this module turns them into a `GatingResult`
// that `gates.ts` folds into the verdict. Everything here is unit-testable
// without a run, which is the point: a gate the model can argue with is not a
// gate. `docs/plan-gated-merges.md` is the spec.
import type { PlanConsistency } from "./schema";

/**
 * `off` is the default, in code (decision 13 of `docs/plan-gated-merges.md`).
 * A missing, empty or misspelled `DELEGATE_GATING_MODE` cannot therefore
 * loosen anything: the deployed value is a human-owned `deploy/` change, and
 * nothing about a failed deploy can give the bot authority it did not have.
 */
export type GatingMode = "off" | "shadow" | "enforce";

const MODES = ["off", "shadow", "enforce"] as const;

export const parseGatingMode = (raw: string | undefined): GatingMode => {
  const value = (raw ?? "").trim().toLowerCase();
  return (MODES as readonly string[]).includes(value) ? (value as GatingMode) : "off";
};

/**
 * Gating is adopted per repo by an explicit list (decision 12), never derived
 * from "does this repo have a `CODEOWNERS`". `runbooks` has one with a handful
 * of owned paths and no `*` default, so a derived rule would hand the bot
 * almost the entire repository by accident, and the mistake would look exactly
 * like a correct configuration. A repo not on this list keeps today's
 * behaviour exactly: no plan fetch, no `CODEOWNERS` read, no verdict change.
 *
 * This list is a scope, not a source of authority: it can only shrink what the
 * bot may approve, because the ownership check still runs (decision 3).
 */
export const GATED_REPOS: ReadonlySet<string> = new Set(["thegoodparty/ops"]);

export const isGatedRepo = (repo: string): boolean => GATED_REPOS.has(repo);

/**
 * Every reason a gated PR goes to a human instead of an approval. The first
 * five map to the five cases in `docs/plan-gated-merges.md`; `owned_paths` and
 * `unverifiable_authority` are the baseline the plan describes under "Where
 * the bot's authority comes from", and the last three split case 5 by what the
 * model actually said, because a missing answer and a considered `unclear` are
 * different defects in the shadow run's numbers.
 *
 * These names are the machine-readable half: `gates.ts` puts them on
 * `Decision.gates`, the review body renders the sentence beside each one, and
 * the record keeps them for step 5's analysis.
 */
export type GatingFlag =
  | "no_binding"
  | "ambiguous_binding"
  | "invalid_binding"
  | "plan_not_on_main"
  | "touches_docs"
  | "unverifiable_authority"
  | "owned_paths"
  | "inconsistent"
  | "unclear_consistency"
  | "no_consistency_answer";

/** What a reader of the review body is told each flag means. */
export const GATING_FLAG_REASON: Record<GatingFlag, string> = {
  no_binding:
    "the PR body has no `Plan:` line, so there is nothing to be consistent with",
  ambiguous_binding:
    "the PR body names more than one plan, and an ambiguous binding is not a binding",
  invalid_binding:
    "the `Plan:` path is not a repo-relative `docs/**.md` document",
  plan_not_on_main:
    "the plan does not resolve at `main`, so it has not been reviewed and merged as a spec",
  touches_docs:
    "the PR adds or changes something under `docs/`, so the spec and the work would move together",
  unverifiable_authority:
    "`CODEOWNERS` at the base ref cannot be read, or has no `*` default, so the bot's authority cannot be derived",
  owned_paths:
    "a changed path has an owner in `CODEOWNERS` on `main`, so a human code owner still has to approve",
  inconsistent: "the change is not consistent with the plan",
  unclear_consistency:
    "the reviewer could not tell whether the change is consistent with the plan",
  no_consistency_answer:
    "the reviewer did not answer whether the change is consistent with the plan",
};

// A `Plan:` line is the whole convention: start of a line, the keyword
// case-insensitively, one repo-relative path, nothing else. `Step:` is matched
// the same way and never reaches the gate (decision 8).
const PLAN_LINE = /^[ \t]*plan:[ \t]*(\S+)[ \t]*$/gim;
const STEP_LINE = /^[ \t]*step:[ \t]*(\d+)[ \t]*$/gim;

export type PlanBinding = {
  /** Every `Plan:` path in the body, in the order they appear. */
  paths: string[];
  /** The numbered step the PR claims, when exactly one well-formed `Step:`
   *  line says so. Status only; the gate never reads it. */
  step?: number;
};

/**
 * Deterministic, with no similarity matching of any kind (decision 8): not by
 * title, not by branch, not by changed files. The author states the plan or
 * the PR is a human's.
 */
export const parsePlanBinding = (body: string): PlanBinding => {
  const paths = [...body.matchAll(PLAN_LINE)].map((m) => m[1]);
  const steps = [...body.matchAll(STEP_LINE)].map((m) => Number(m[1]));
  // A missing, malformed or duplicated `Step:` is not an error and not a
  // flag: it only leaves the step's status where it was.
  return steps.length === 1 ? { paths, step: steps[0] } : { paths };
};

/**
 * A plan is a document a reviewer can approve as one. It lives under `docs/`,
 * it is markdown, and it is repo-relative: no absolute path, no `..` escape
 * out of the repository.
 */
export const isPlanPath = (path: string): boolean =>
  path.startsWith("docs/") &&
  path.endsWith(".md") &&
  path.length > "docs/".length + ".md".length &&
  !path.includes("..") &&
  !path.includes("\\") &&
  !path.startsWith("/");

export type CodeownersPattern = {
  /** The pattern as written, before the leading/trailing slash is stripped. */
  pattern: string;
  owners: string[];
};

/**
 * `CODEOWNERS` as an ordered list of rules, first match winning from the end:
 * the last pattern that matches a path decides who owns it. Lines the GitHub
 * parser ignores are ignored here too -- blanks, comments, and `!` patterns,
 * which `CODEOWNERS` does not support as negation.
 */
export const parseCodeowners = (text: string): CodeownersPattern[] => {
  const patterns: CodeownersPattern[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const [pattern, ...owners] = trimmed.split(/\s+/);
    if (!pattern) continue;
    patterns.push({ pattern, owners });
  }
  return patterns;
};

/** A `*` rule with owners, which is what makes ownership derivable at all. */
export const hasStarDefault = (patterns: CodeownersPattern[]): boolean =>
  patterns.some((p) => p.pattern === "*" && p.owners.length > 0);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `*` and `?` stop at a path separator, `**` does not, and `**/` may match
// nothing so `**/CLAUDE.md` covers the repository root as well as a nested
// `CLAUDE.md`. That is the subset of .gitignore syntax `CODEOWNERS` actually
// uses in this org; anything fancier falls through as a literal, which can
// only fail to match, and a path that matches no pattern is treated as owned.
const globBody = (pattern: string): string => {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else {
        re += ".*";
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += escapeRe(c);
    }
  }
  return re;
};

const compilePattern = (raw: string): RegExp | undefined => {
  const directory = raw.endsWith("/");
  let pattern = directory ? raw.slice(0, -1) : raw;
  // A slash anywhere but the end anchors the pattern to the repository root;
  // otherwise it matches at any depth, the way .gitignore does.
  const anchored = pattern.startsWith("/") || pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  if (!pattern) return undefined;
  const suffix = directory ? "(?:/.*)?" : "";
  const body = globBody(pattern);
  return anchored ? new RegExp(`^${body}${suffix}$`) : new RegExp(`(?:^|/)${body}${suffix}$`);
};

export type Ownership = "owned" | "unowned" | "unmatched";

export const resolveOwnership = (
  patterns: CodeownersPattern[],
  path: string,
): Ownership => {
  for (let i = patterns.length - 1; i >= 0; i--) {
    const re = compilePattern(patterns[i].pattern);
    if (!re || !re.test(path)) continue;
    return patterns[i].owners.length > 0 ? "owned" : "unowned";
  }
  // Nothing matched, which should be impossible under a `*` default. It is
  // reported separately and treated as owned by `evaluateGating`, because
  // "unowned" is not a property to derive by absence.
  return "unmatched";
};

export type GatingResult = {
  mode: GatingMode;
  /** The binding the PR states. `path` is set only when it is unambiguous. */
  binding: { path?: string; step?: number };
  baseRef: string;
  /** Present only when the plan was read at `main` and is usable. */
  plan?: { path: string; blobSha: string };
  authority: { checked: boolean; ownedPaths: string[]; reason: string };
  /** Cases 1-4 and the authority baseline. Case 5 lives in `consistencyFlag`. */
  flags: GatingFlag[];
};

/**
 * Cases 1 to 4 of "The five cases that go to a human", plus the authority
 * baseline, all from inputs the harness already has. Case 5 -- consistency --
 * is the model's answer and is folded in by `gates.ts`.
 *
 * Every unknown is a flag (fail closed): no binding, an ambiguous binding, a
 * binding outside `docs/`, a base ref that is not `main`, a plan that did not
 * resolve, a `CODEOWNERS` with no `*`, a path no pattern matches.
 */
export const evaluateGating = (args: {
  mode: Exclude<GatingMode, "off">;
  body: string;
  baseRef: string;
  changedFiles: string[];
  /** `CODEOWNERS` text at the base ref; undefined when there is none. */
  codeowners: string | undefined;
  /** What `bundle.ts` read at the base ref, if anything. */
  plan: { path: string; blobSha: string } | undefined;
}): GatingResult => {
  const flags: GatingFlag[] = [];
  const binding = parsePlanBinding(args.body);
  const bound = binding.paths.length === 1 ? binding.paths[0] : undefined;

  // Cases 1 and 2: nothing to be consistent with, or a binding the model could
  // have negotiated. The convention is the harness's, not the model's.
  if (binding.paths.length === 0) flags.push("no_binding");
  else if (binding.paths.length > 1) flags.push("ambiguous_binding");
  else if (!isPlanPath(binding.paths[0])) flags.push("invalid_binding");
  const boundValid = bound !== undefined && isPlanPath(bound);

  // Case 4: the spec and the work must not move together, or a PR can
  // authorise itself. Broader than "touches the plan it implements" on
  // purpose: a new plan, an unrelated plan, or a typo fix are all `docs/`.
  if (args.changedFiles.some((p) => p === "docs" || p.startsWith("docs/"))) {
    flags.push("touches_docs");
  }

  // Case 3: "merged to `main`" is the whole of the plan's authority, so a plan
  // read off any other ref is not used even when the fetch succeeded.
  const plan =
    boundValid &&
    args.baseRef === "main" &&
    args.plan !== undefined &&
    args.plan.path === bound
      ? args.plan
      : undefined;
  if (boundValid && plan === undefined) flags.push("plan_not_on_main");

  // The baseline: authority is derived from `CODEOWNERS` at the base ref and
  // never asserted by the model (decision 7). An owned path is not one of the
  // five cases -- it is the ordinary PR in this repo after step 2, and the
  // reason it is a comment rather than an approval.
  const patterns = parseCodeowners(args.codeowners ?? "");
  const checked = args.baseRef === "main" && hasStarDefault(patterns);
  const ownedPaths = checked
    ? args.changedFiles.filter((p) => resolveOwnership(patterns, p) !== "unowned")
    : [];
  if (!checked) flags.push("unverifiable_authority");
  else if (ownedPaths.length > 0) flags.push("owned_paths");

  return {
    mode: args.mode,
    binding: {
      ...(bound !== undefined ? { path: bound } : {}),
      ...(binding.step !== undefined ? { step: binding.step } : {}),
    },
    baseRef: args.baseRef,
    ...(plan !== undefined ? { plan } : {}),
    authority: {
      checked,
      ownedPaths,
      reason: !checked
        ? args.baseRef !== "main"
          ? `the base ref is ${args.baseRef}, not main`
          : args.codeowners === undefined
            ? "there is no CODEOWNERS at the base ref"
            : "CODEOWNERS has no `*` default"
        : ownedPaths.length > 0
          ? `${ownedPaths.length} changed path(s) have an owner in CODEOWNERS on main`
          : "every changed path is unowned in CODEOWNERS on main",
    },
    flags,
  };
};

/**
 * Case 5, the one model judgement in the design (decision 9). Anything other
 * than `consistent` is a flag, including no answer: the question was asked, so
 * a silence is not a pass. Called only when a plan was actually put in front
 * of the model.
 */
export const consistencyFlag = (
  answer: PlanConsistency["verdict"] | undefined,
): GatingFlag | undefined => {
  if (answer === "consistent") return undefined;
  if (answer === "inconsistent") return "inconsistent";
  if (answer === "unclear") return "unclear_consistency";
  return "no_consistency_answer";
};
