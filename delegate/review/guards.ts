import { defineGuard, guardSpecs } from "../framework/guards";
import type { GuardHandler } from "../framework/guards";
import type { ToolCallHandler } from "../framework/types";

// The reviewer's guards, in one implementation, on the neutral seam.
//
// **S3's amendment closes here.** S3 put `pathGuardHook` and `replayToolGuard` on
// `ToolCallHandler` while the tool underneath was still the Claude SDK's, and left
// one condition open: the literal half of the path check could be dropped only
// once the guard and the tool opening the file were the same code. In S5 they are
// — the read tools are `framework/tools.ts`, they call `confineTo` themselves, and
// `applyGuard` calls the same `confineTo`. The literal check is **kept anyway**:
// it is one `realpath` per candidate, it is what `run.test.ts`'s adversarial table
// pins, and the property it holds — a candidate has to be inside the root both as
// written and as normalised — is still true of our tools. Dropping it would be a
// readability win and a defence-in-depth loss in the one component whose whole job
// is not being talked out of its boundary.
//
// What did change is the form. A guard is now a `ToolCallHandler` **with a spec**:
// the same decision function as before, plus a description of itself as data,
// because the model call happens in a spawned child and a closure cannot cross the
// pipe. The child applies the spec with `applyGuard`, the same function the
// handler is built from, so there is one implementation and not two. A guard with
// no spec fails the run rather than being silently skipped.

/**
 * Confine the reviewer's file tools to the review checkout.
 *
 * The worker process next door still holds every token, and `/proc/<pid>/environ`
 * is a regular file to a read tool, so a cwd alone is not a boundary. This is the
 * boundary: it normalises the path (unicode spaces out, one leading `@` off),
 * resolves it, `realpath`s it so a symlink inside the checkout pointing at `/etc`
 * is not inside, and tests the prefix with `root + sep` so `/checkout-evil` does
 * not read as inside `/checkout`. Dropping any one of those steps is a bypass,
 * which is what the adversarial table in `run.test.ts` pins.
 *
 * The check runs on **both spellings** — the normalised one and the literal one —
 * and a candidate has to pass both. That is S3's fix, kept.
 */
export const pathGuardHook = (reviewDir: string): GuardHandler =>
  defineGuard({ kind: "paths", root: reviewDir });

/**
 * Allow only the tools the replay named.
 *
 * The tool list in `pr-reviewer.ts` is a string literal a candidate branch may
 * change, so the replay holds its own list. A candidate that named Bash or Write
 * would otherwise reach the run's result files and the holdout manifest.
 */
export const replayToolGuard = (names: readonly string[]): GuardHandler =>
  defineGuard({ kind: "tools", names, reason: "Tool not allowed in replay" });

/** Every guard's spec, which is what goes into the child's `ChildSpec`. */
export { guardSpecs };

/** The handler types every guard here is, re-exported for callers. */
export type { GuardHandler, ToolCallHandler };
