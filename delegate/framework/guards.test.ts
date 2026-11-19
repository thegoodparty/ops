import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGuard, applyGuards, defineGuard, guardSpecs } from "./guards";
import type { GuardSpec } from "./guards";

// The guard layer, which S5 turned from a closure into a closure **plus a spec**.
//
// The spec is what crosses into the spawned child, so the property worth pinning
// is that the two forms decide the same thing: `defineGuard(spec)` is a handler
// built from the same `applyGuard` the child runs, so a guard in the parent and
// the same guard in the child cannot drift.

const checkout = () => {
  const root = mkdtempSync(join(tmpdir(), "guards-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "x");
  return root;
};

const paths = (root: string): GuardSpec => ({ kind: "paths", root });

test("a paths guard allows what is inside and denies the plan's adversarial table", () => {
  const root = checkout();
  symlinkSync("/", join(root, "@l"));
  symlinkSync("/etc", join(root, "etc-link"));

  for (const inside of ["src/a.ts", "@src/a.ts", join(root, "src/a.ts")]) {
    assert.deepEqual(applyGuard({ toolName: "Read", input: { file_path: inside } }, paths(root)), {
      decision: "allow",
    });
  }
  for (const outside of [
    "/proc/1/environ",
    "../../etc/passwd",
    "@/etc/hostname",
    "@../../etc/passwd",
    "\u00a0/etc/hostname",
    "etc-link/hostname",
    "@l/proc/1/environ",
  ]) {
    assert.equal(
      applyGuard({ toolName: "Read", input: { file_path: outside } }, paths(root)).decision,
      "deny",
      outside,
    );
  }
});

test("a paths guard reads every path-carrying field, and only the guarded tools", () => {
  const root = checkout();
  // `path` is the field Grep and Glob use, and it is checked too — otherwise a
  // Grep over `/` would read the worker's environ through the tool it names.
  assert.equal(applyGuard({ toolName: "Grep", input: { pattern: "x", path: "/" } }, paths(root)).decision, "deny");
  assert.equal(applyGuard({ toolName: "Glob", input: { pattern: "*", path: "/proc" } }, paths(root)).decision, "deny");
  // A tool with no path in it is not this guard's business: a `Task` prompt is
  // not a path, and the subagent's own reads are guarded where they happen.
  assert.equal(applyGuard({ toolName: "Task", input: { prompt: "/proc/1/environ" } }, paths(root)).decision, "allow");
});

test("the git tools are guarded too, which the old hook did not do", () => {
  // `git_show -- ref:path` reads a file, so a path argument to a git tool is the
  // same escape as a path argument to Read. S3's hook only policed
  // Read/Grep/Glob because those were the tools the SDK owned; the git tools were
  // validated by `isSafePath` alone, which cannot see a symlink. They are in the
  // guarded set now.
  const root = checkout();
  for (const toolName of ["git_log", "git_show", "git_diff", "git_blame"]) {
    assert.equal(applyGuard({ toolName, input: { path: "/etc/passwd" } }, paths(root)).decision, "deny", toolName);
    assert.equal(applyGuard({ toolName, input: { path: "src/a.ts" } }, paths(root)).decision, "allow", toolName);
  }
});

test("a tools guard is an allowlist, and its reason says which list refused", () => {
  const spec: GuardSpec = { kind: "tools", names: ["Read", "Grep"], reason: "Tool not allowed in replay" };
  assert.deepEqual(applyGuard({ toolName: "Read", input: {} }, spec), { decision: "allow" });
  assert.deepEqual(applyGuard({ toolName: "Bash", input: {} }, spec), {
    decision: "deny",
    reason: "Tool not allowed in replay: Bash",
  });
});

test("guards are applied in order and the first denial wins", () => {
  // Order matters: the replay's tool list is checked before the path guard so a
  // refused tool is refused for the reason a reader expects, and so a tool with
  // an unexpected input shape never reaches the path walk.
  const root = checkout();
  const specs: GuardSpec[] = [
    { kind: "tools", names: ["Read"], reason: "not allowed" },
    paths(root),
  ];
  assert.deepEqual(applyGuards({ toolName: "Bash", input: { file_path: "/etc/passwd" } }, specs), {
    decision: "deny",
    reason: "not allowed: Bash",
    });
  assert.deepEqual(applyGuards({ toolName: "Read", input: { file_path: "/etc/passwd" } }, specs).decision, "deny");
  assert.deepEqual(applyGuards({ toolName: "Read", input: { file_path: "src/a.ts" } }, specs), {
    decision: "allow",
  });
});

test("an unknown guard kind denies rather than allows", () => {
  // The union is closed, so this can only arrive from a version skew across the
  // pipe. "I do not understand this guard" is not "the call passed it".
  const bogus = { kind: "future-thing" } as unknown as GuardSpec;
  const decision = applyGuard({ toolName: "Read", input: {} }, bogus);
  assert.equal(decision.decision, "deny");
  assert.match((decision as { reason: string }).reason, /Unknown guard kind: future-thing/);
});

test("defineGuard builds a handler that decides what applyGuard decides", () => {
  // The property that makes the pipe safe: the closure the parent would run and
  // the spec the child runs are the same function.
  const root = checkout();
  const handler = defineGuard(paths(root));
  const cases = [
    { toolName: "Read", input: { file_path: "src/a.ts" } },
    { toolName: "Read", input: { file_path: "/etc/passwd" } },
    { toolName: "Read", input: { file_path: "@l/proc/1/environ" } },
  ];
  for (const call of cases) {
    assert.deepEqual(handler(call), applyGuard(call, paths(root)), JSON.stringify(call));
  }
});

test("guardSpecs refuses a guard that has no spec, rather than dropping it", () => {
  // Skipping an undescribable guard would run the agent with fewer guards than
  // the caller asked for, silently. Failing is the only safe reading.
  assert.deepEqual(guardSpecs([]), []);
  assert.deepEqual(guardSpecs([defineGuard(paths("/tmp"))]), [paths("/tmp")]);
  assert.throws(
    () => guardSpecs([() => ({ decision: "allow" })]),
    /cannot cross the process boundary/,
  );
});
