/**
 * The workbench account's one alert address.
 *
 * `aws-workbench@goodparty.org` was already spelled in three places for three
 * different reasons: `SPEND_ALERT_EMAIL` in `index.ts` for the Budgets
 * subscriber field, `VK_JANITOR_ALERT_EMAIL` in `bifrost-vk-janitor.ts` for the
 * reconciler's SNS topic, and the plan's step 1 group alias. A fourth copy in
 * `alarms.ts` would be the point at which a typo becomes a page nobody
 * receives, and an alias change becomes a hunt through the stack.
 *
 * So it is one constant in one file, and the three callers import it. It lives
 * in its own module rather than in one of the callers because the janitor and
 * the spend alerts are otherwise unrelated, and neither should have to import
 * the other's module to reach an email address.
 *
 * **This address is a group alias, and its SNS subscriptions are confirmed by
 * hand.** See the note on the topic in `alarms.ts`: an unconfirmed subscription
 * means an alarm fires and nobody is told.
 */
export const WORKBENCH_ALERT_EMAIL = "aws-workbench@goodparty.org";
