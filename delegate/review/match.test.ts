import { test } from "node:test";
import assert from "node:assert/strict";
import {
  carryForwardUnmatchedPriors,
  dismissablePriorFindings,
  matchPriorFinding,
  matchPriorFindings,
  PRIOR_MATCH_WINDOW,
} from "./match";
import type { Finding, PostedFinding } from "./schema";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  path: "src/a.ts",
  line: 10,
  body: "The handler dereferences a null session.",
  category: "bugs",
  confidence: "high",
  ...overrides,
});

const prior = (overrides: Partial<PostedFinding> = {}): PostedFinding => ({
  id: "11111111-1111-1111-1111-111111111111",
  path: "src/a.ts",
  line: 10,
  body: "The handler dereferences a null session.",
  category: "bugs",
  confidence: "high",
  anchorAdjusted: false,
  ...overrides,
});

test("matches an exact path, category and line", () => {
  const p = prior();
  assert.equal(matchPriorFinding(finding(), [p]), p);
});

test("matches a line moved within the window", () => {
  const p = prior({ line: 10 });
  assert.equal(matchPriorFinding(finding({ line: 10 + PRIOR_MATCH_WINDOW }), [p]), p);
});

test("does not match a line beyond the window", () => {
  const p = prior({ line: 10 });
  assert.equal(matchPriorFinding(finding({ line: 10 + PRIOR_MATCH_WINDOW + 1 }), [p]), undefined);
});

test("matches a finding that overlaps the prior span even outside the window", () => {
  const p = prior({ line: 100, endLine: 140 });
  assert.equal(matchPriorFinding(finding({ line: 130 }), [p]), p);
});

test("does not match a different path", () => {
  assert.equal(matchPriorFinding(finding({ path: "src/b.ts" }), [prior()]), undefined);
});

test("does not match a different category", () => {
  assert.equal(matchPriorFinding(finding({ category: "security" }), [prior()]), undefined);
});

test("returns undefined when there is no candidate", () => {
  assert.equal(matchPriorFinding(finding(), []), undefined);
});

test("a body fingerprint breaks a distance tie", () => {
  const closerBody = prior({ id: "00000000-0000-0000-0000-0000000000aa", line: 10, body: "unrelated words here" });
  const matchingBody = prior({
    id: "00000000-0000-0000-0000-0000000000bb",
    line: 10,
    body: "The handler dereferences a null session, again.",
  });
  assert.equal(
    matchPriorFinding(finding({ line: 10, body: "The handler dereferences a null session." }), [
      closerBody,
      matchingBody,
    ]),
    matchingBody,
  );
});

test("an id tiebreak keeps the result independent of iteration order", () => {
  const a = prior({ id: "00000000-0000-0000-0000-00000000000a" });
  const b = prior({ id: "00000000-0000-0000-0000-00000000000b" });
  assert.equal(matchPriorFinding(finding(), [a, b]), a);
  assert.equal(matchPriorFinding(finding(), [b, a]), a);
});

test("the closest of two findings claims the prior, the other is fresh", () => {
  const p = prior({ line: 10 });
  const nearer = finding({ line: 11, body: "nearer" });
  const farther = finding({ line: 15, body: "farther" });
  // Farther first on purpose: the assignment must not depend on order.
  assert.deepEqual(matchPriorFindings([farther, nearer], [p]), [undefined, p]);
});

test("a prior finding is claimed at most once", () => {
  const p = prior({ line: 10 });
  const a = finding({ line: 10, body: "a" });
  const b = finding({ line: 10, body: "b" });
  const matches = matchPriorFindings([a, b], [p]);
  assert.equal(matches.filter((m) => m === p).length, 1);
  assert.equal(matches.filter((m) => m === undefined).length, 1);
});

test("two findings match two priors independently", () => {
  const a = prior({ id: "00000000-0000-0000-0000-000000000001", path: "src/a.ts", line: 10 });
  const b = prior({ id: "00000000-0000-0000-0000-000000000002", path: "src/b.ts", line: 20 });
  const matches = matchPriorFindings(
    [finding({ path: "src/a.ts", line: 11 }), finding({ path: "src/b.ts", line: 19 })],
    [a, b],
  );
  assert.deepEqual(matches, [a, b]);
});

test("a finding with no candidate stays fresh", () => {
  const p = prior({ path: "src/a.ts", line: 10 });
  const matches = matchPriorFindings(
    [finding({ path: "src/other.ts", line: 10 })],
    [p],
  );
  assert.deepEqual(matches, [undefined]);
});

test("a dropped finding leaves every unmatched prior open", () => {
  const a = prior({ id: "00000000-0000-0000-0000-000000000001" });
  const b = prior({ id: "00000000-0000-0000-0000-000000000002" });
  // One prior was matched and carried; with a drop, the other must not be
  // dismissed even though the model did not re-emit it.
  assert.deepEqual(dismissablePriorFindings([a, b], new Set([a.id]), 1), []);
  assert.deepEqual(dismissablePriorFindings([a, b], new Set([a.id]), 0), [b]);
});

test("carryForwardUnmatchedPriors retains every prior not already carried", () => {
  const a = prior({ id: "00000000-0000-0000-0000-000000000001" });
  const b = prior({ id: "00000000-0000-0000-0000-000000000002" });
  const carried = [a];
  assert.equal(carryForwardUnmatchedPriors([a, b], carried), 1);
  assert.deepEqual(carried, [a, b]);
  assert.equal(carryForwardUnmatchedPriors([a, b], carried), 0);
});
