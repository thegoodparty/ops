---
title: Statewide read freeze
date: 2026-11-04
source: https://goodparty.clickup.com/90132012119/v/dc/2ky4jq2q-20493/2ky4jq2q-180313
---

# Statewide read freeze

## Lessons

- Running a CPU-heavy computation synchronously on the single Node.js request thread, so one slow call stops the whole server from answering any request or health check (statistical opinion model run inline in the gp-api priority read).
- Adding an algorithm whose cost grows much faster than its input, without capping the input or measuring it at the largest size the data allows (MRP model with one parameter per census tract in omni #2977).
- Recomputing an expensive result on every read when it only changes when its inputs change, instead of computing it once when those inputs update (priority read on every Home load in omni #3023).
- Caching an expensive result in each server process's memory when a load balancer spreads requests across many instances, so the cache rarely hits (per-task 15-minute priority read cache in gp-api).
- Making a page wait on a slow backend call in its server render, so the whole page fails with that call and each retry starts more backend work (priority page server render in omni #2852).

## What happened

omni #2852 put the priority read on request paths: the read-status endpoint, Chief of Staff turns, and priority chat turns. It also made the priority page wait for the read in its server render. At that point the read was a cheap calculation. Then #2969 added an MRP opinion model that runs in-process in gp-api. Its architecture record assumed a few dozen parameters and about 1 ms per fit. Next, #2977 switched the read to that model with census tract as a dimension, so the model had one parameter per tract. The PR noted that speed on very large districts had not been measured. Finally, #3023 ran the read on every Home load.

In production, a staff test org on a statewide position (about 3,000 tracts) opened a priority. The model's cost grows with the cube of the tract count, so each fit took minutes and blocked the Node.js event loop. The page failed in its server render, and the page's retries sent read-status requests to six servers. Each server had its own cold 15-minute in-memory cache, and the load balancer kept sending new requests to servers that were not yet frozen. All gp-api servers stopped answering, health checks failed, and ECS replaced the tasks. That caused about four minutes of full outage. When some frozen servers finally finished, their queued requests carried expired tokens and got 401s. Reproducing the bug during the investigation froze several more servers.

Review did not catch it. The unmeasured large-district case was accepted as a known gap. No gate asked what the largest input would be, and the reviewer did not flag synchronous CPU work on requests, per-task caching, or blocking server renders. The `serve-citizen-panels` flag was turned off for staff accounts. A refactor of the priority read is in progress, and these PRs are being added as review eval cases.
