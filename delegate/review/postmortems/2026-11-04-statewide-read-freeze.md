---
title: Statewide read freeze
date: 2026-11-04
source: https://goodparty.clickup.com/90132012119/v/dc/2ky4jq2q-20493/2ky4jq2q-180313
---

# Statewide read freeze

## Lessons

- Running a CPU-heavy computation synchronously on the single Node.js request thread stops the whole server answering any request or health check, until that computation finishes (statistical opinion model run inline in the gp-api priority read).
- Adding an algorithm whose cost grows much faster than its input, without capping the input or measuring it at the largest size the data allows, blows the request past its budget on the biggest districts (MRP model with one parameter per census tract in omni #2977).
- Recomputing an expensive result on every read when it only changes when its inputs change spends every page view's request budget on the same unchanged answer (priority read on every Home load in omni #3023).
- Caching an expensive result in each server process's memory when a load balancer spreads requests across many instances misses on nearly every request, which sends each instance to recompute the same answer (per-task 15-minute priority read cache in gp-api).
- Making a page wait on a slow backend call in its server render fails the whole page with that call, and every retry starts more backend work (priority page server render in omni #2852).

## Post-mortem

### Overview

**Ticket:** [ENG-11575: Priorities page shows "Something went wrong" on prod](https://app.clickup.com/t/17tnw2bckxt)

| Users Impacted | 4 |
| ---| --- |
| Impact Duration | 25m |
| Time to Detect | 2m |
| Time to Resolve | 23m |

### Timeline

| Time (UTC) | Event |
| ---| --- |
| 2026-10-16 01:15am | [#2852](https://github.com/thegoodparty/omni/pull/2852) merges. It puts the "priority read" mechanism on request paths: the read-status endpoint, Chief of Staff turns and priority chat turns. The priority page now waits for the read in its server render, before it can show anything. The read is a cheap calculation at this point. |
| 2026-10-19 10:29pm | [#2969](https://github.com/thegoodparty/omni/pull/2969) merges. It adds the opinion model (MRP), and an architecture record says it will run in-process in gp-api because "a fit takes about 1 ms" for "a few dozen parameters". |
| 2026-10-20 12:33am | [#2977](https://github.com/thegoodparty/omni/pull/2977) merges. The read switches to the model, with census tract as one of its dimensions (one parameter per tract). The PR body notes that speed on very large districts was not measured. |
| 2026-10-20 11:39pm | [#3023](https://github.com/thegoodparty/omni/pull/3023) merges. Home card sync now runs the read on every Home load. |
| 2026-11-02 02:54pm | A staff Test Mode org is created on the "U.S. Senate - North Carolina" position. Its district is statewide (7.4M registered voters, 3,003 tracts). |
| 2026-11-04 05:54pm | Last prod deploy before the incident finishes ([#3575](https://github.com/thegoodparty/omni/pull/3575)). The load balancer has 7 healthy gp-api servers from 18:20. |
| 2026-11-04 06:21pm | A staff member creates a priority in the statewide test org and opens it (18:21:46). Over the next 30 seconds the page and its retries send 7 read-status requests to 6 different servers. Each server stops responding a few seconds later, when its warehouse read finishes and the model starts. Impact starts at 18:21:52. |
| 2026-11-04 06:22pm | The webapp's error page posts a front-end error to #bot-dev (18:22:02), the first automated signal. The last request completed by any gp-api server is at 18:22:29: full outage begins. Requests completed at the load balancer fall from about 4,900 a minute to 1,398 this minute, then 35 and 14 in the next two. Synthetic health probes start timing out at 18:22:46. |
| 2026-11-04 06:24pm | The staff member reports in #bugs that Priorities shows "Something went wrong" (18:24:08). Detected. The load balancer marks all 7 servers unhealthy; no healthy server remains until 18:26. ECS replaces the 8 tasks it saw as unhealthy, in four batches from 18:24:18 to 18:25:05. Grafana alert "Health check probe failures" goes to Pending (18:24:40). |
| 2026-11-04 06:25pm | ECS starts stopping the frozen servers. Requests waiting on them fail with 502s: 210 this minute and 1,076 the next. |
| 2026-11-04 06:26pm | First replacement server serves traffic (18:26:11). Full outage ends after 3m42s. The health alert fires at 18:26:40, 29 seconds after the outage ended: it averages probe results over 5 minutes, then waits 2 more minutes before firing. |
| 2026-11-04 06:28pm | Delegate turns the alert into [ENG-11576](https://app.clickup.com/t/17tnw2bckyd) and posts it in #bugs at 18:28:31, mentioning the on-call group. Nobody replies, and nothing links it to the report in #bugs from 4 minutes earlier. |
| 2026-11-04 06:29pm | Health alert resolves. From 18:22 to 18:30 the load balancer returned 1,784 errors (5xx), about 1,100 requests ended with the client giving up, and about 20,000 fewer requests completed than normal. |
| 2026-11-04 06:30pm | #urgent opened, with a Meet call (18:30:41). Two frozen servers finish their model runs (525s and 567s) and work through their queued requests, which now carry expired sign-in tokens: 5 signed-in users (4 external, 1 staff) get 401s across 21 requests. A queued Stripe webhook is rejected as too old (Stripe retries). An unrelated prod deploy ([#3583](https://github.com/thegoodparty/omni/pull/3583)) starts rolling gp-api; it is not a cause. |
| 2026-11-04 06:32pm | While investigating on the call, the team opens the affected page to reproduce, including by impersonating the affected account from gp-admin (18:32:49). |
| 2026-11-04 06:33pm | This triggers a second-wave outage: about 10 more read-status calls freeze about 7 of the roughly 22 running servers. The rest keep serving; the load balancer returns 18 errors in this window. The last frozen server returns at 18:38:10, after 256s. |
| 2026-11-04 06:35pm | Delegate opens [#3587](https://github.com/thegoodparty/omni/pull/3587) for ENG-11576, which moves the load balancer's health check off the database. The database was not this incident's cause. This was NOT an effective fix. |
| 2026-11-04 06:39pm | On the call, the cause is identified as the model running inside the request on gp-api, not in Databricks. Everyone is asked to stop opening the page. |
| 2026-11-04 06:46pm | `serve-citizen-panels` is turned off for all [goodparty.org](http://goodparty.org) accounts in Amplitude (the affected account's first "off" read is at 18:46:49). Real users keep the feature, on the basis that no real official has a district this large. The incident is marked non-urgent. Resolved for staff accounts. |

### Root Cause Analysis - [Five Whys](https://en.wikipedia.org/wiki/Five_whys)

1. **Why did gp-api go down?** Every prod server was stuck in one CPU-heavy computation for minutes and could not answer requests or health checks.
2. **Why was one computation able to stop a server?** The priority read runs its statistical model synchronously, on the same thread that serves every request. Its cost grows with the cube of the district's census tract count. A statewide district (3,003 tracts) takes minutes per run.
3. **Why did one person's page take down the whole fleet, not one server?** The priority page waits for the read in its server render, so the whole page failed with it, and each reload or "Try again" started another read. Each server keeps its own 15-minute cache, so nothing was shared. The load balancer sends each new request to the least-busy server, which here meant a server not yet frozen. Seven requests in 30 seconds reached six servers.
4. **Why was work this expensive on the request path?** The model was designed and documented for "a few dozen parameters, about 1 ms" and never measured at the largest districts the data allows. Its result only changes when new answers are coded, but it is recomputed on every read instead of when those answers change. Nothing capped its input size.
5. **Why did no check catch the size assumption before prod?** No test or review gate asks "what is the largest input this will see?" The PR said large districts were unmeasured, and that was accepted as a known gap. Real Serve onboarding reaches large districts too: 69 real orgs have more than 150,000 registered voters, including New York City and a statewide office. A staff test account happened to open a priority in one first.

### Recommended Actions

1. **Prioritize a refactor of the "priority read" mechanism to unblock rollout of civic panel to larger districts.** (this is already in-progress)
2. **Add the offending PRs to delegate's eval suite.** Add [#2977](https://github.com/thegoodparty/omni/pull/2977) (the model in the request path, with a per-task cache and no size limit) and [#3023](https://github.com/thegoodparty/omni/pull/3023) (the model on every Home load) as cases delegate must block, and hill-climb until it does.
3. **Prioritize experimenting with encoding architectural guidance at the repo level and in delegate.** Move [Contribution Safeguards: encode architectural guidance in the repo and in delegate's review](https://app.clickup.com/t/17tnw2b5grg) to the top of the backlog. This feature merged three patterns an experienced engineer would reject on sight, and each one passed review:
    *   **The page waits on gp-api in its server render.** The webapp is a single-page app, so this makes the page only as fast as its slowest call, and here the whole page failed with it.
    *   **A CPU-heavy calculation runs synchronously inside requests.** Node serves every request on one thread, so one slow calculation stops the whole server, not one user's request.
    *   **Results are cached in each task's memory.** gp-api runs 4 to 24 tasks behind a load balancer that spreads requests, so the cache rarely hits. On 11-04, seven requests reached six tasks with cold caches.
4. **Update in-repo agent guidance to explicitly recommend client-side data fetching by default, and add a delegate eval case for that preference.** Write it into `packages/gp-webapp/AGENTS.md` and `docs/state-management.md`, since 18 pages wait on gp-api in their server render today and agents copy what they see. Build the eval case from [#2852](https://github.com/thegoodparty/omni/pull/2852).
5. **Add an alert that fires within a minute when the gp-api fleet stops answering, routed to #bugs.** Today's health alert fired 29 seconds after this outage ended.
6. **Route front-end errors to the Bugs board through Sentry, and remove the #bot-dev path.** Add a Sentry alert rule for new and spiking issues that feeds delegate's alert intake, the same way Grafana alerts reach the Bugs board today. Then delete the /v1/error-logger route and the Slack post.
