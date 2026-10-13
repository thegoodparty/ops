import type { Finding, PostedFinding } from "./schema";

// How far a re-emitted finding's line may move and still be considered the
// same prior finding. A finding anchors to a changed line; a nearby edit can
// shift it a line or two, but a move beyond this is a new finding, not a
// carried one.
export const PRIOR_MATCH_WINDOW = 10;

const tokens = (body: string): Set<string> =>
  new Set(body.toLowerCase().match(/[a-z0-9]+/g) ?? []);

const tokenOverlap = (a: Set<string>, b: Set<string>): number => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
};

// 0 when the two spans overlap, otherwise the number of lines between them.
const lineDistance = (finding: Finding, prior: PostedFinding): number => {
  const priorEnd = prior.endLine ?? prior.line;
  const findingEnd = finding.endLine ?? finding.line;
  if (finding.line <= priorEnd && prior.line <= findingEnd) return 0;
  return finding.line > priorEnd ? finding.line - priorEnd : prior.line - findingEnd;
};

export interface PriorMatch {
  prior: PostedFinding;
  distance: number;
  overlap: number;
}

const compareMatches = (a: PriorMatch, b: PriorMatch): number =>
  a.distance - b.distance ||
  b.overlap - a.overlap ||
  a.prior.id.localeCompare(b.prior.id);

// The best prior finding a re-emitted finding continues, or undefined for a
// fresh one. Deterministic: same path and category, a line within the window
// or an overlapping span, ties broken by closest line, then body fingerprint,
// then id so the result never depends on iteration order.
export const matchPriorFinding = (
  finding: Finding,
  priorFindings: readonly PostedFinding[],
): PostedFinding | undefined => {
  let best: PriorMatch | undefined;
  for (const prior of priorFindings) {
    if (prior.path !== finding.path || prior.category !== finding.category) continue;
    const distance = lineDistance(finding, prior);
    if (distance > PRIOR_MATCH_WINDOW) continue;
    const candidate: PriorMatch = {
      prior,
      distance,
      overlap: tokenOverlap(tokens(finding.body), tokens(prior.body)),
    };
    if (best === undefined || compareMatches(candidate, best) < 0) best = candidate;
  }
  return best?.prior;
};

// Assign each re-emitted finding to at most one prior finding, and each prior
// to at most one finding. Candidates are matched globally: the closest pair
// claims first, so two new findings can never thread onto the same comment —
// the nearer one carries it, the other is fresh. Returns an array parallel to
// `findings`, with undefined for a finding that is new.
export const matchPriorFindings = (
  findings: readonly Finding[],
  priorFindings: readonly PostedFinding[],
): (PostedFinding | undefined)[] => {
  const edges: { index: number; match: PriorMatch }[] = [];
  findings.forEach((finding, index) => {
    for (const prior of priorFindings) {
      if (prior.path !== finding.path || prior.category !== finding.category) continue;
      const distance = lineDistance(finding, prior);
      if (distance > PRIOR_MATCH_WINDOW) continue;
      edges.push({
        index,
        match: {
          prior,
          distance,
          overlap: tokenOverlap(tokens(finding.body), tokens(prior.body)),
        },
      });
    }
  });
  edges.sort((a, b) => compareMatches(a.match, b.match) || a.index - b.index);

  const assigned: (PostedFinding | undefined)[] = findings.map(() => undefined);
  const claimed = new Set<string>();
  for (const edge of edges) {
    if (assigned[edge.index] !== undefined) continue;
    if (claimed.has(edge.match.prior.id)) continue;
    assigned[edge.index] = edge.match.prior;
    claimed.add(edge.match.prior.id);
  }
  return assigned;
};
