import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  consistencyFlag,
  evaluateGating,
  hasStarDefault,
  isGatedRepo,
  isPlanPath,
  parseCodeowners,
  parseGatingMode,
  parsePlanBinding,
  resolveOwnership,
} from "./gating";

// A `CODEOWNERS` shaped like this repo's after step 2 of
// `docs/plan-gated-merges.md`: `*` owns everything, and the opt-out list is what
// can grant authority. `deploy/` is the one path opted out here so an approval
// is reachable at all.
const CODEOWNERS = `# Who must approve what.

*                                 @thegoodparty/gp-contrib
deploy/
`;

// A `CODEOWNERS` with owned paths and no `*` default is what `runbooks` has,
// which is why "unowned" must never be derived from a pattern not matching
// (decision 12).
const NO_STAR_CODEOWNERS = `some/path @thegoodparty/gp-contrib`;

describe("parseGatingMode", () => {
  it("defaults to off when the variable is missing, empty or unknown", () => {
    assert.equal(parseGatingMode(undefined), "off");
    assert.equal(parseGatingMode(""), "off");
    assert.equal(parseGatingMode("   "), "off");
    assert.equal(parseGatingMode("enforced"), "off");
    assert.equal(parseGatingMode("true"), "off");
    assert.equal(parseGatingMode("shadow "), "shadow");
  });

  it("reads all three modes, case-insensitively", () => {
    assert.equal(parseGatingMode("off"), "off");
    assert.equal(parseGatingMode("shadow"), "shadow");
    assert.equal(parseGatingMode("ENFORCE"), "enforce");
  });
});

describe("isGatedRepo", () => {
  it("gates only the repos that adopted it", () => {
    assert.equal(isGatedRepo("thegoodparty/ops"), true);
    assert.equal(isGatedRepo("thegoodparty/omni"), false);
    assert.equal(isGatedRepo("thegoodparty/runbooks"), false);
  });
});

describe("parsePlanBinding", () => {
  it("reads the plan and the step from their own lines", () => {
    const binding = parsePlanBinding("## Why\nstuff\n\nPlan: docs/sheriff.md\nStep: 3\n\nmore");
    assert.deepEqual(binding, { paths: ["docs/sheriff.md"], step: 3 });
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    assert.deepEqual(parsePlanBinding("plan:\tdocs/a.md"), { paths: ["docs/a.md"] });
    assert.deepEqual(parsePlanBinding("  PLAN: docs/a.md  "), { paths: ["docs/a.md"] });
  });

  it("does not match a Plan: that is not at the start of a line", () => {
    assert.deepEqual(parsePlanBinding("this PR follows Plan: docs/a.md"), { paths: [] });
  });

  it("returns every path when the body names two plans", () => {
    const binding = parsePlanBinding("Plan: docs/a.md\n\nPlan: docs/b.md");
    assert.deepEqual(binding, { paths: ["docs/a.md", "docs/b.md"] });
  });

  it("has no step when the Step: line is absent", () => {
    assert.deepEqual(parsePlanBinding("Plan: docs/a.md"), { paths: ["docs/a.md"] });
  });

  it("has no step when the Step: line is malformed", () => {
    for (const body of [
      "Plan: docs/a.md\nStep: three",
      "Plan: docs/a.md\nStep: 3a",
      "Plan: docs/a.md\nStep:",
      "Plan: docs/a.md\nStep: 1.5",
      "Plan: docs/a.md\nStep: -1",
    ]) {
      assert.deepEqual(parsePlanBinding(body), { paths: ["docs/a.md"] }, body);
    }
  });

  it("has no step when two Step: lines disagree", () => {
    assert.deepEqual(parsePlanBinding("Plan: docs/a.md\nStep: 1\nStep: 2"), {
      paths: ["docs/a.md"],
    });
  });
});

describe("isPlanPath", () => {
  it("accepts a markdown document under docs/", () => {
    assert.equal(isPlanPath("docs/sheriff.md"), true);
    assert.equal(isPlanPath("docs/plans/step-4.md"), true);
  });

  it("rejects anything that is not a repo-relative docs/**.md path", () => {
    assert.equal(isPlanPath("README.md"), false);
    assert.equal(isPlanPath("delegate/review/plan.md"), false);
    assert.equal(isPlanPath("docs/plan.txt"), false);
    assert.equal(isPlanPath("docs/"), false);
    assert.equal(isPlanPath("docs/.md"), false);
    assert.equal(isPlanPath("/docs/plan.md"), false);
    assert.equal(isPlanPath("docs/../delegate/review/gates.md"), false);
    assert.equal(isPlanPath("docs\\plan.md"), false);
  });
});

describe("parseCodeowners", () => {
  it("keeps ordered patterns with their owners and drops comments and blanks", () => {
    assert.deepEqual(parseCodeowners(CODEOWNERS), [
      { pattern: "*", owners: ["@thegoodparty/gp-contrib"] },
      { pattern: "deploy/", owners: [] },
    ]);
  });

  it("ignores a negated pattern rather than treating it as a rule", () => {
    assert.deepEqual(parseCodeowners("!docs/\n* @gp"), [
      { pattern: "*", owners: ["@gp"] },
    ]);
  });

  it("detects the *-owned default and its absence", () => {
    assert.equal(hasStarDefault(parseCodeowners(CODEOWNERS)), true);
    assert.equal(hasStarDefault(parseCodeowners("docs/ @gp")), false);
    assert.equal(hasStarDefault(parseCodeowners(NO_STAR_CODEOWNERS)), false);
    assert.equal(hasStarDefault([]), false);
  });
});

describe("resolveOwnership", () => {
  const patterns = parseCodeowners(CODEOWNERS);

  it("owns a path the * default covers", () => {
    assert.equal(resolveOwnership(patterns, "delegate/review/gates.ts"), "owned");
  });

  it("leaves a path the opt-out covers unowned", () => {
    assert.equal(resolveOwnership(patterns, "deploy/index.ts"), "unowned");
    assert.equal(resolveOwnership(patterns, "deploy/components/webhooks.ts"), "unowned");
  });

  it("lets the last matching pattern win when two match", () => {
    const two = parseCodeowners(`* @gp
deploy/ @gp
deploy/components/
deploy/components/css/ @gp
`);
    assert.equal(resolveOwnership(two, "deploy/index.ts"), "owned");
    assert.equal(resolveOwnership(two, "deploy/components/x.ts"), "unowned");
    assert.equal(resolveOwnership(two, "deploy/components/css/x.css"), "owned");
  });

  it("matches an unanchored pattern at any depth", () => {
    const p = parseCodeowners(`*.md
CLAUDE.md
docs/
`);
    assert.equal(resolveOwnership(p, "README.md"), "unowned");
    assert.equal(resolveOwnership(p, "a/b/NOTES.md"), "unowned");
    assert.equal(resolveOwnership(p, "CLAUDE.md"), "unowned");
    assert.equal(resolveOwnership(p, "delegate/CLAUDE.md"), "unowned");
    assert.equal(resolveOwnership(p, "docs/plan.md"), "unowned");
    assert.equal(resolveOwnership(p, "x/docs/plan.md"), "unowned");
    assert.equal(resolveOwnership(p, "README.txt"), "unmatched");
  });

  it("anchors a pattern that starts with a slash", () => {
    const p = parseCodeowners(`/deploy/\n/docs/plan.md\n`);
    assert.equal(resolveOwnership(p, "deploy/index.ts"), "unowned");
    assert.equal(resolveOwnership(p, "nested/deploy/index.ts"), "unmatched");
    assert.equal(resolveOwnership(p, "docs/plan.md"), "unowned");
  });

  it("lets ** match any depth including the root", () => {
    const p = parseCodeowners(`**/CLAUDE.md\n`);
    assert.equal(resolveOwnership(p, "CLAUDE.md"), "unowned");
    assert.equal(resolveOwnership(p, "delegate/review/CLAUDE.md"), "unowned");
    assert.equal(resolveOwnership(p, "delegate/CLAUDE.md.bak"), "unmatched");
  });

  it("owns a subtree when a narrower owned rule follows a broader opt-out", () => {
    // A pattern without a trailing slash still matches a directory and
    // everything beneath it, so the owned rule has to win over the opt-out
    // that already matched further up the path. Under-matching it here would
    // report an owned path as unowned and hand the bot authority GitHub does
    // not give it.
    const p = parseCodeowners(`* @gp
/deploy/components/
/deploy/components/iam @gp
`);
    assert.equal(resolveOwnership(p, "deploy/components/iam/x.ts"), "owned");
    assert.equal(resolveOwnership(p, "deploy/components/other.ts"), "unowned");
  });

  it("treats a no-trailing-slash directory pattern as covering its contents", () => {
    const p = parseCodeowners(`/deploy/components/iam @gp
`);
    assert.equal(resolveOwnership(p, "deploy/components/iam/x.ts"), "owned");
    assert.equal(resolveOwnership(p, "deploy/components/iam"), "owned");
    assert.equal(resolveOwnership(p, "deploy/components/iam-x.ts"), "unmatched");
  });

  it("reports a path no pattern matches instead of calling it unowned", () => {
    const p = parseCodeowners(`docs/ @gp\n`);
    assert.equal(resolveOwnership(p, "delegate/review/gates.ts"), "unmatched");
  });
});

describe("evaluateGating", () => {
  const base = {
    mode: "enforce" as const,
    body: "Plan: docs/plan-gated-merges.md\nStep: 4",
    baseRef: "main",
    changedFiles: ["deploy/components/webhooks.ts"],
    codeowners: CODEOWNERS,
    plan: { path: "docs/plan-gated-merges.md", blobSha: "1c7ac96f062c9263697f7208056f9941e4dc499a" },
  };

  it("returns no flags when a merged plan binds, every path is unowned, and docs/ is untouched", () => {
    const g = evaluateGating(base);
    assert.deepEqual(g.flags, []);
    assert.deepEqual(g.binding, { path: "docs/plan-gated-merges.md", step: 4 });
    assert.deepEqual(g.plan, base.plan);
    assert.deepEqual(g.authority, {
      checked: true,
      ownedPaths: [],
      reason: "every changed path is unowned in CODEOWNERS on main",
    });
  });

  it("flags case 1: no Plan: line", () => {
    const g = evaluateGating({ ...base, body: "no plan here", plan: undefined });
    assert.ok(g.flags.includes("no_binding"));
  });

  it("flags case 2: more than one plan named", () => {
    const g = evaluateGating({
      ...base,
      body: "Plan: docs/plan-gated-merges.md\nPlan: docs/sheriff.md",
    });
    assert.ok(g.flags.includes("ambiguous_binding"));
    assert.equal(g.plan, undefined);
  });

  it("flags case 2: a binding outside docs/ or not markdown", () => {
    for (const path of ["delegate/review/gates.ts", "docs/plan.txt", "README.md"]) {
      const g = evaluateGating({
        ...base,
        body: `Plan: ${path}`,
        plan: undefined,
      });
      assert.ok(g.flags.includes("invalid_binding"), path);
    }
  });

  it("flags case 3: the base ref is not main", () => {
    const g = evaluateGating({ ...base, baseRef: "release/2026" });
    assert.ok(g.flags.includes("plan_not_on_main"));
    // A plan read off any other ref grants nothing, even if the read succeeded.
    assert.equal(g.plan, undefined);
  });

  it("flags case 3: the plan does not exist at main", () => {
    const g = evaluateGating({ ...base, plan: undefined });
    assert.ok(g.flags.includes("plan_not_on_main"));
  });

  it("flags case 4: the PR adds or edits anything under docs/", () => {
    for (const path of ["docs/new-plan.md", "docs/plan-gated-merges.md", "docs"]) {
      const g = evaluateGating({ ...base, changedFiles: [path] });
      assert.ok(g.flags.includes("touches_docs"), path);
    }
  });

  it("flags a CODEOWNERS with no * default as unverifiable authority", () => {
    const g = evaluateGating({ ...base, codeowners: "deploy/ @gp\n" });
    assert.ok(g.flags.includes("unverifiable_authority"));
    assert.equal(g.authority.checked, false);
    assert.deepEqual(g.authority.ownedPaths, []);
  });

  it("flags a missing CODEOWNERS as unverifiable authority", () => {
    const g = evaluateGating({ ...base, codeowners: undefined });
    assert.ok(g.flags.includes("unverifiable_authority"));
    assert.match(g.authority.reason, /no CODEOWNERS/i);
  });

  it("flags a changed path that CODEOWNERS owns, and names it", () => {
    const g = evaluateGating({
      ...base,
      changedFiles: ["delegate/review/gates.ts", "deploy/index.ts"],
    });
    assert.ok(g.flags.includes("owned_paths"));
    assert.deepEqual(g.authority.ownedPaths, ["delegate/review/gates.ts"]);
  });

  it("treats a path matching no pattern as owned, never as unowned", () => {
    const g = evaluateGating({
      ...base,
      codeowners: "*\ndeploy/index.ts\n",
      changedFiles: ["deploy/index.ts"],
    });
    // `*` with no owner marks everything unowned, which is exactly the shape a
    // repo must never ship; it is still caught by the missing-owners default.
    assert.ok(g.flags.includes("unverifiable_authority"));

    const g2 = evaluateGating({
      ...base,
      codeowners: "* @gp\n",
      changedFiles: ["delegate/review/gates.ts"],
    });
    assert.deepEqual(g2.authority.ownedPaths, ["delegate/review/gates.ts"]);
  });

  it("never fails the review: it returns a result for every input", () => {
    const g = evaluateGating({
      ...base,
      body: "",
      baseRef: "develop",
      changedFiles: ["docs/x.md"],
      codeowners: undefined,
      plan: undefined,
    });
    assert.equal(g.mode, "enforce");
    assert.deepEqual(g.flags, [
      "no_binding",
      "touches_docs",
      "unverifiable_authority",
    ]);
  });
});

describe("consistencyFlag", () => {
  it("is silent only for consistent", () => {
    assert.equal(consistencyFlag("consistent"), undefined);
    assert.equal(consistencyFlag("inconsistent"), "inconsistent");
    assert.equal(consistencyFlag("unclear"), "unclear_consistency");
    assert.equal(consistencyFlag(undefined), "no_consistency_answer");
  });
});
