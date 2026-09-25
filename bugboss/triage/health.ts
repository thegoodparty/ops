// Fallback-rate tracking for the Boss's own model calls. Design spec:
// docs/bugboss/design.md, "BugBoss alerts must not route through BugBoss".
//
// Every fallback in this directory returns a well-formed answer: triage
// returns new_incident, correlation returns no merges. Downstream neither is
// distinguishable from a real decision, so a wrong model id, a denied Bedrock
// call or sustained throttling reads as a busy, productive week -- a 15-alert
// burst becomes 15 incidents and 15 agents with no dedup, no attach and no
// suppression, and nothing anywhere says the model never answered.
//
// One fallback is normal and a sustained rate is not, so the rate travels with
// every alarm and crossing the threshold is its own event.

/** Recent calls per site. Sized to a burst, not to a day. */
const WINDOW = 50;

/** Under this a single failure reads as 100%, which says nothing. */
const MIN_SAMPLE = 10;

export const SUSTAINED_FALLBACK_RATE = 0.5;

export interface FallbackRate {
  recentFallbacks: number;
  /** The denominator of `fallbackRate`, successes included. */
  recentCalls: number;
  fallbackRate: number;
  /** True once the rate is high and drawn from enough calls to mean it. */
  sustained: boolean;
}

const windows = new Map<string, boolean[]>();

export const recordCall = (site: string, fellBack: boolean): FallbackRate => {
  const recent = windows.get(site) ?? [];
  recent.push(fellBack);
  if (recent.length > WINDOW) recent.shift();
  windows.set(site, recent);

  const fallbacks = recent.filter((failed) => failed).length;
  const rate = fallbacks / recent.length;
  return {
    recentFallbacks: fallbacks,
    recentCalls: recent.length,
    fallbackRate: Math.round(rate * 1000) / 1000,
    sustained: recent.length >= MIN_SAMPLE && rate >= SUSTAINED_FALLBACK_RATE,
  };
};

/** Test seam: the window is process-local and outlives one test. */
export const resetFallbackRates = () => windows.clear();
