---
title: Dashboard 500s During Deploy
date: 2026-11-12
source: https://goodparty.clickup.com/90132012119/v/dc/2ky4jq2q-20493/2ky4jq2q-208073
---

# Dashboard 500s During Deploy

## Lessons

- Dropping a column or table before a separate production rollout has finished removing every dependency, including generated ORM queries, breaks the old instances still serving traffic; a merged PR or green schema check does not prove compatibility with the deployed release (Prisma still selected `campaign.ai_content` during the gp-api rollout of omni #3748).

## Post-mortem

### Overview

**Ticket:** [ENG-11633](https://goodparty.clickup.com/t/90132012119/ENG-11633)

| Users Impacted | 2 confirmed, total unknown |
| ---| --- |
| Impact Duration | 44s |
| Time to Detect | 53s |
| Time to Resolve | 0m |

### Participants

The engineer (change author)
Delegate, the automated bug responder (D)

### Timeline

| Time (UTC) | Event |
| ---| --- |
| 2026-11-11 09:30pm | [#3747](https://github.com/thegoodparty/omni/pull/3747) merges. The code stops reading `campaign.ai_content`; the schema is untouched. The correct first half of a two-release removal. |
| 2026-11-12 05:35pm | [#3748](https://github.com/thegoodparty/omni/pull/3748) merges, 20 hours later, and the release train starts on `0a7b4df55f` ([run 43271034930](https://github.com/thegoodparty/omni/actions/runs/43271034930)). It deletes `aiChat.prisma`, removes `aiContent` from `campaign.prisma`, and adds the migration that drops the column and the `ai_chat` table. Code removal and drop ship in one release. Its description warns not to merge until #3747 is deployed, but nothing checks that. |
| 2026-11-12 06:01:03pm | The "Promote gp-api" job begins. |
| 2026-11-12 06:04:10pm | The first new task boots and applies `20261111201946_drop_ai_content_and_ai_chat`. The column and the table cease to exist. Six tasks on the previous image are still serving traffic, because prod keeps every old task in service until the new one is healthy. |
| 2026-11-12 06:04:41pm | The new task passes its health check. ECS begins draining the six old tasks, as configured. |
| 2026-11-12 06:04:47pm | First 500. The old release's Prisma client names `ai_content` in its `SELECT` and Postgres rejects it (P2022). 37 seconds passed between the drop and the first crash. |
| 2026-11-12 06:05:31pm | Last user-facing 500. 18 requests across four dashboard endpoints, from two accounts. The window closes here only because no further campaign read landed on an old task. |
| 2026-11-12 06:05:40pm | Grafana's route-error alert fires and D opens [ENG-11633](https://goodparty.clickup.com/t/90132012119/ENG-11633) and [ENG-11634](https://goodparty.clickup.com/t/90132012119/ENG-11634). Detected. |
| 2026-11-12 06:07:30pm | The `tcrStrandedKickoffSweep` job fails P2022 on an old task and retries successfully at 06:08:30pm on a new one. |
| 2026-11-12 06:07:48pm | The last old task stops. The failures were already over; the rollout ended them, not any repair. |
| 2026-11-12 06:09pm | D's filing attributes the error to schema drift, a column dropped outside the migration history. That reading came from a stale checkout and was already false when posted. |
| 2026-11-18 11:08pm | the change author opens [#3891](https://github.com/thegoodparty/omni/pull/3891) to make the chat code independent of the tables it replaced. It merges at 12:18am, and [#3893](https://github.com/thegoodparty/omni/pull/3893), the drop, merges at 02:07am. The same removal, two releases apart, produces zero P2022. |
| 2026-11-19 01:43am | [#3894](https://github.com/thegoodparty/omni/pull/3894) adds the rule to `packages/gp-api/prisma/AGENTS.md`: drop a column or table one deploy after the code stops using it. |

### Root Cause Analysis - [Five Whys](https://en.wikipedia.org/wiki/Five_whys)

1. **Why did the campaign dashboard fail?** Every request that reads a campaign crashed, because the Prisma client running in prod selected `campaign.ai_content` and the column no longer existed. The query itself was fast, 3.4ms; Postgres rejected it for the missing column.
2. **Why was the column gone while servers still asked for it?** Each new task runs `npx prisma migrate deploy` during its own startup (`packages/gp-api/deploy/docker-entrypoint.sh:105`), and prod keeps every old task serving until the new one is healthy (`deploymentMinimumHealthyPercent: 100`, `deploymentMaximumPercent: 200`). So the migration landed 37 seconds before the first crash, with six old tasks still taking traffic.
3. **Why did the drop ship in the release that removed the readers?** Nothing in the repo required otherwise. #3748 carried the code removal, the model change and the destructive migration in one commit, and the only sequencing was a "do not merge until deployed" note in its description.
4. **Why did no check or gate catch it?** CI compared the schema against the migrations, and the two agreed. No check asked what the migration would do to the release still in service. The rule against it reached the repo a week later (#3894), and the check that enforces it ([#3771](https://github.com/thegoodparty/omni/pull/3771)) is still unmerged.
5. **Why does the failure mode still exist?** Migrating from the task entrypoint means any non-backward-compatible migration corrupts the rollout instead of blocking it. The rule and the pending check close the route this incident took, not the mechanism. Running the migration as its own deploy step ahead of the traffic shift is what removes it.

### Code Review Lessons

*   Removing a column or table in the same release that stops using it breaks the tasks still running the previous release, which name the dropped column in every `SELECT`, until the rollout replaces them (`campaign.ai_content` dropped in omni #3748, the same release that also removed its readers).

### Recommended Actions

*   **Merge** [**#3771**](https://github.com/thegoodparty/omni/pull/3771)**.** It is approved and green, open since 12 Nov. It fails a new migration containing `DROP COLUMN`, `DROP TABLE` or `RENAME` unless that migration carries an explicit `-- expand-contract:` acknowledgement, wired into the gp-api checks job. Until it merges, the rule #3894 wrote down is enforced by nothing.
*   **Take** **`npx prisma migrate deploy`** **out of** **`packages/gp-api/deploy/docker-entrypoint.sh`** **and run it as its own deploy step before ECS shifts traffic.** This removes the mechanism rather than the route: a migration the still-serving release cannot run against then halts the deploy with the previous revision intact. It lives in the release train, so it needs a ticket owned by gp-api platform.
*   **Fix the guidance that made the unsafe change look correct.** `packages/gp-api/.claude/skills/new-migration/SKILL.md:66` tells authors that a schema change and its migration go in a single commit and must not be split. Followed literally with a `DROP COLUMN`, that is this incident. Carve out drops and renames: they ship one release after the code.
