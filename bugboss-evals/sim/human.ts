import type { Scenario, VolunteerMilestone } from "../core/scenario";

const DONT_KNOW = "I don't know more, proceed.";

/** The scripted human's reply: every fact the question matches, once each. */
export const humanReply = (question: string, facts: { when: string; say: string }[], said: Set<string>): string => {
  const fresh = facts.filter((f) => new RegExp(f.when, "i").test(question) && !said.has(f.say));
  for (const f of fresh) said.add(f.say);
  return fresh.length ? fresh.map((f) => f.say).join(" ") : DONT_KNOW;
};

/**
 * The volunteered lines due now: each whose milestone the run has reached and
 * that was not said before, in scenario order, with `{pr}` filled in. Marks
 * them said, as humanReply does, so the harness posts what comes back.
 */
export const due = (
  volunteer: Scenario["human"]["volunteer"],
  milestones: ReadonlySet<VolunteerMilestone>,
  said: Set<string>,
  pr: number | null,
): { milestone: VolunteerMilestone; say: string }[] => {
  const fresh = volunteer.filter((v) => milestones.has(v.at) && !said.has(v.say));
  for (const v of fresh) said.add(v.say);
  return fresh.map((v) => ({ milestone: v.at, say: v.say.replaceAll("{pr}", pr === null ? "the PR" : `#${pr}`) }));
};
