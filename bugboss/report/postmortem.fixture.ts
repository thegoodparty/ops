// A post-mortem built from a real closed incident (98: door-knocking list
// saves refused while a slow voter lookup held database connections), with
// every user and campaign identifier taken out. Tests close incidents on it
// and render it, so what they check is what an agent actually writes.

import type { PostmortemSections } from "../types";

export const PRACTICE_CHANGES = [
  "This failure came from doing slow remote work inside a database transaction, which the code made easy and nothing flagged.",
  "Three practice changes would catch the whole class, not just this route.",
  "First, make transactions narrow by construction: the transaction helper should accept only database work, and a lint rule should flag any call to Databricks, an HTTP client or a queue from inside one.",
  "Reviewers then see the hazard in the diff instead of inferring it from timing.",
  "Second, load-test the write paths a single user can fan out.",
  "Saving every walk list at once is ordinary behaviour, and a test that fires fifty concurrent saves against a pool of twenty connections would have failed before release.",
  "We should keep a small suite of these burst tests for any endpoint the UI calls in a loop.",
  "Third, alert on pool pressure rather than on the errors it causes.",
  "Connection wait time and transactions held longer than a second are leading signals; by the time route errors fire, users have already been refused.",
  "Finally, when a request depends on a slow external system, design it so that system is called before or after the write, never during, and write that rule into the backend guide so new endpoints start from it rather than rediscovering it in production.",
].join(" ");

export const SECTIONS: PostmortemSections = {
  atAGlance:
    "For about two minutes, a candidate saving several door-knocking lists at once had every save refused with a 503. The saves held a database connection while waiting on a slow voter lookup, so a burst ran the pool dry. The lookup now runs before the transaction opens, and a real batch of 18 saves has since succeeded.",
  timeline: [
    { at: "2026-10-01T02:14:30Z", event: "First of 7 list saves refused with 503: the database could not start a transaction in time." },
    { at: "2026-10-01T02:15:40Z", event: "Route-error alert fires for POST /v1/door-knocking/turfs." },
    { at: "2026-10-01T02:15:55Z", event: "The candidate retries; all 7 lists save." },
    { at: "2026-10-01T03:00:00Z", event: "Cause confirmed from a trace: a 3.4s voter lookup held inside a 3.5s transaction." },
    { at: "2026-10-01T03:50:00Z", event: "Fix PR opened.", evidenceUrl: "https://github.com/thegoodparty/omni/pull/2290" },
    { at: "2026-10-01T04:29:16Z", event: "Fix merged after review." },
    { at: "2026-10-01T05:17:05Z", event: "Fix running in production." },
    { at: "2026-10-01T07:45:02Z", event: "A real batch of 18 saves, 17 concurrent, all succeed." },
  ],
  userImpact:
    "One candidate saw 7 door-knocking list saves fail with a \"database briefly unavailable\" error over about 90 seconds. Retrying saved all of them, so no list was lost. No other user hit the error in the window.",
  rootCause:
    "Saving a door-knocking list opened a database transaction and then resolved the list's audience from the voter file inside it. That lookup takes about 3.4 seconds, so each save held one of 20 pooled connections for 3.5 seconds. A burst of saves exhausted the pool, and the database client gave up after 2 seconds waiting for a connection, which surfaced as a 503.",
  fiveWhys: [
    { why: "Why were the saves refused?", because: "The database client could not get a connection within 2 seconds." },
    { why: "Why were no connections free?", because: "Each in-flight save held one for about 3.5 seconds." },
    { why: "Why did a save hold a connection that long?", because: "It waited on a 3.4 second voter-file lookup while its transaction was open." },
    { why: "Why was the lookup inside the transaction?", because: "The audience was resolved where it was first needed, which happened to be inside the write." },
    { why: "Why did nothing catch that before production?", because: "No test or review rule looks for slow remote calls inside a transaction, and no test saves lists concurrently." },
  ],
  resolutionActions: [
    "omni#2290 moves the voter-file lookup before the transaction and re-reads the saved filter inside it, merged as bf59a93.",
    "Deployed to production at 05:17 UTC; a post-deploy trace shows no transaction open during the lookup.",
  ],
  practiceChanges: PRACTICE_CHANGES,
};

/** The arguments report_analysis takes, for a test that only needs a close. */
export const ANALYSIS = {
  ...SECTIONS,
  usersImpacted: 1,
  impactQuery: '{service_name="gp-api"} |= "P2028"',
};
