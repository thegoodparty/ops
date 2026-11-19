import { isAbsolute, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

// Path confinement for the reviewer's read tools, in one implementation.
//
// S3 built this against a tool it did not own: the guard ran as a hook in front
// of the Claude SDK's Read/Grep/Glob, so it had to assume the tool underneath
// might resolve a string differently from the guard's own reading of it. That
// is why S3 tests **both spellings**, the normalised one and the literal one,
// and the amendment it left behind says the literal half can be dropped only
// once the guard and the tool opening the file are the same code.
//
// S5 is that moment: the tools are ours (`framework/tools.ts`), they call
// `confineTo` themselves, and the hook that used to guard them is now a second
// caller of this same function. The literal check is kept anyway. It costs one
// `realpath` per candidate, it is what `run.test.ts`'s adversarial table pins,
// and the property it holds — a candidate has to be inside the root both as
// written and as normalised — is true of our tools too. Dropping it would be a
// readability win and a defence-in-depth loss, in a component whose whole job
// is to not be talked out of its boundary by a model.

/**
 * The unicode space characters a filesystem and a person can disagree about:
 * no-break, en quad through hair space, narrow no-break, medium mathematical,
 * ideographic. The same set pi normalises (`UNICODE_SPACES` in
 * `utils/paths.ts`), and the class is kept here rather than taken from there:
 * this module must not depend on the harness whose bug it is closing.
 *
 * Removing them is deliberate, and matches what pi does before it resolves
 * (`normalizePath`, same class). Folding to a plain space instead would leave
 * the space in the path, so `\u00a0/etc/hostname` would resolve as
 * `<checkout>/ /etc/hostname` — a different path that is inside the prefix and
 * therefore passes. Either way the guard would be disagreeing with the tool it
 * is protecting, which is the bug.
 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * A model-supplied path, as a resolver that strips a leading `@` and folds
 * unicode spaces would read it.
 *
 * **The normalisation is the guard.** A path the model sends is not a path the
 * file tool will open: a resolver that strips a leading `@` and folds unicode
 * spaces before resolving (pi's `resolveToCwd` does, which is where the bypasses
 * were found) reads `@/etc/hostname` and `\u00a0/etc/hostname` as
 * `/etc/hostname`, while a naive prefix test reads them as relative strings
 * inside the checkout. So the candidate is normalised first — unicode spaces
 * out, then one leading `@` off — and resolved after.
 */
export const normalizeGuardPath = (p: string): string => {
  const spaced = p.replace(UNICODE_SPACES, "");
  return spaced.startsWith("@") ? spaced.slice(1) : spaced;
};

export type Confinement = {
  /** The real path of the confinement root, with symlinks resolved. */
  root: string;
  /**
   * Whether `candidate` stays inside the root, as written and as normalised.
   * `resolved` is the absolute path a tool should open — the normalised
   * spelling, resolved against the root — so the tool and this function cannot
   * disagree about which file is meant.
   */
  check(candidate: string): { inside: boolean; resolved: string };
};

/**
 * Build the confinement for one root. Every read tool the reviewer gets is
 * created with this, and so is `pathGuardHook`.
 *
 * `realpath` is what makes a symlink inside the checkout that points outside it
 * a denial, and `root + sep` is what stops `/checkout-evil` reading as inside
 * `/checkout`. A path `realpath` cannot resolve is neither spelling's escape, so
 * it keeps a `resolve` fallback rather than being denied for being absent: the
 * tools report a missing file themselves.
 */
export const confineTo = (root: string): Confinement => {
  const real = realpathSync(root);
  const resolvesInside = (p: string) => {
    const abs = isAbsolute(p) ? p : resolve(real, p);
    let target: string;
    try {
      target = realpathSync(abs);
    } catch {
      target = resolve(abs);
    }
    return target === real || target.startsWith(real + sep);
  };
  return {
    root: real,
    check(candidate) {
      const normalised = normalizeGuardPath(candidate);
      const resolved = isAbsolute(normalised) ? normalised : resolve(real, normalised);
      // **Both spellings, and a candidate has to pass both.** The normalised
      // path is what our tool opens; the literal path is what a resolver that
      // does not normalise would open. Neither is redundant while a second
      // caller (`pathGuardHook`) can be handed a path by something other than
      // our tools.
      return { inside: resolvesInside(normalised) && resolvesInside(candidate), resolved };
    },
  };
};
