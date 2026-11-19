import type { ToolCall, ToolCallDecision, ToolCallHandler } from "./types";
import { confineTo } from "./tool-paths";

// The guards, in one implementation, described in a form that can cross a
// process boundary.
//
// S3 put `pathGuardHook` and `replayToolGuard` on the neutral `ToolCallHandler`
// seam while the tool underneath was still the Claude SDK's, and its amendment
// left one condition open: the literal half of the path check could be dropped
// only once the guard and the tool opening the file were the same code. S5 is
// when they are — but S5 also puts the model call in a spawned child, and a
// closure cannot be sent over a pipe.
//
// So a guard is now two things: the function (`ToolCallHandler`, unchanged, so
// every existing caller and test still works), and a **spec** describing it as
// data. `agent.ts` sends the specs to the child, the child applies them there,
// and this module is the only implementation either side runs. A guard with no
// spec is a run-time error rather than a silently skipped guard: an unguarded
// child is the exact failure the allowlist exists to prevent.

/**
 * A guard as data. Closed on purpose — a new guard is a new member here, which
 * is what makes `applyGuard` total rather than a dispatch that can fall through.
 */
export type GuardSpec =
  | {
      /**
       * Every file path the call carries has to stay inside `root`. This is
       * `pathGuardHook`: the review's confinement, and the replay's.
       */
      kind: "paths";
      /** The directory no path may leave. Resolved with `realpath` on use. */
      root: string;
    }
  | {
      /**
       * The call's tool name has to be in `names`. This is `replayToolGuard`,
       * which exists because `pr-reviewer.ts`'s tool list is a string literal a
       * candidate branch may edit, so the replay holds its own.
       */
      kind: "tools";
      names: readonly string[];
      /** Prefixed to the denial, so a reader knows which list refused the call. */
      reason: string;
    };

/** A guard that can describe itself, which is what lets it run in the child. */
export type GuardHandler = ToolCallHandler & { readonly spec: GuardSpec };

/** The file-shaped inputs a tool call can carry, and the only ones a guards reads. */
const pathCandidates = (input: Record<string, unknown>): string[] =>
  [input.file_path, input.path]
    .filter((value): value is string => typeof value === "string" && value.length > 0);

/**
 * Decide one call against one spec.
 *
 * A spec this module does not know is a **deny**, not an allow: the closed set
 * means an unknown member can only get here from a version skew across the pipe,
 * and the safe reading of "I do not understand this guard" is that the call did
 * not pass it.
 */
export const applyGuard = (call: ToolCall, spec: GuardSpec): ToolCallDecision => {
  switch (spec.kind) {
    case "paths": {
      // Only the tools that take a path are policed. A `Task` call carries a
      // prompt, not a path, and its subagent's own reads are guarded where they
      // happen.
      if (!["Read", "Grep", "Glob", "git_log", "git_show", "git_diff", "git_blame"].includes(call.toolName)) {
        return { decision: "allow" };
      }
      const confine = confineTo(spec.root);
      const outside = pathCandidates(call.input).find((candidate) => !confine.check(candidate).inside);
      return outside === undefined
        ? { decision: "allow" }
        : { decision: "deny", reason: `Path is outside the review checkout: ${outside}` };
    }
    case "tools":
      return spec.names.includes(call.toolName)
        ? { decision: "allow" }
        : { decision: "deny", reason: `${spec.reason}: ${call.toolName}` };
    default: {
      // Unreachable while the union is closed; kept so a spec from a newer
      // version on the other side of the pipe denies rather than throws.
      const unknown = spec as { kind?: unknown };
      return { decision: "deny", reason: `Unknown guard kind: ${String(unknown.kind)}` };
    }
  }
};

/**
 * Every spec a run's guards carry.
 *
 * Throws on a guard that cannot describe itself. The alternative — skipping it —
 * would run an agent with fewer guards than the caller asked for and say nothing,
 * which is worse than failing the run.
 */
export const guardSpecs = (guards: readonly ToolCallHandler[]): GuardSpec[] =>
  guards.map((guard, index) => {
    const spec = (guard as Partial<GuardHandler>).spec;
    if (spec === undefined) {
      throw new Error(
        `Guard ${index} cannot cross the process boundary: it has no \`spec\`. ` +
          `Build guards with \`pathGuardHook\` / \`replayToolGuard\`, or give a custom one a spec in \`framework/guards.ts\`.`,
      );
    }
    return spec;
  });

/** Apply every guard, in order, stopping at the first denial. A guard that throws denies. */
export const applyGuards = (call: ToolCall, specs: readonly GuardSpec[]): ToolCallDecision => {
  for (const spec of specs) {
    const decision = applyGuard(call, spec);
    if (decision.decision === "deny") return decision;
  }
  return { decision: "allow" };
};

/** A handler and its spec, which is what every guard in this repo is. */
export const defineGuard = (spec: GuardSpec): GuardHandler => {
  const handler: ToolCallHandler = (call) => applyGuard(call, spec);
  return Object.assign(handler, { spec });
};
