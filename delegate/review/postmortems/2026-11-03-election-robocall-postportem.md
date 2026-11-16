---
title: Election Robocall Postportem
date: 2026-11-03
source: https://goodparty.clickup.com/90132012119/v/dc/2ky4jq2q-20493/2ky4jq2q-179213
---

# Election Robocall Postportem

## Lessons

- Accepting work into a queue without projecting whether it can drain before its own deadline, so more is booked than the day can deliver (robocall campaigns accepted for the 11/2 window against the 9pm ET per-timezone cutoffs, with no drain-time gate).
- Sizing a capacity limit from the vendor's advertised throughput rather than the rate observed in production (capacity assumed at CallHub's 120 calls per minute while dialing and audio verification ran far below it).
- Deciding an external job has finished from a local time estimate instead of a signal from the system that ran it, so a stuck job looks the same as a slow one (robocalls flipped to Done on an estimate because CallHub has no status readback).
- Adding a source of load, or a promotion that multiplies it, with no gate on the queue it feeds and no alert when that queue falls behind (free-robocall coupon run the day before the election; no queue-depth alert existed).

## Post-mortem

### Overview

| Users Impacted | 12 users did not have robocalls sent<br>20 users robocalls were delayed from desired send time |
| ---| --- |
| Impact Duration | 14hrs |
| Time to Detect | 4hrs |
| Time to Resolve | 12hrs |

### Timeline

| Time (UTC) | Event |
| ---| --- |
| 2026-11-2 12:00PM ET | The robocall Queue had 20 robocalls scheduled on 11-2. This was the most in the queue we have had up the this point. The on-call engineer noted in standup that it was going to be back-to-back robocalls all day. At that time, we believed with the limitations, we still should be able to handle it. |
| 2026-11-2 4:00PM ET | In bot-politics channel, an automated alert triggered that a call was past it's scheduled time. A teammate tagged the on-call engineer and asked about the status of the queue. |
| 2026-11-2 4:30PM ET | The on-call engineer alerted a teammate and another teammate in a group DM, where previous robocall conversations were had that the queue had grown to 30 robocalls for 11-2 and filled past a reasonable capacity and unlikely to finish by 9PM. |
| 2026-11-2 4:40PM ET | In the slack group DM, a teammate asked if we could move the calls from 11-2 to 11-3. |
| 2026-11-2 4:45PM ET | A teammate and the on-call engineer determined that most calls could not be moved from 11-2 to 11-3 to free up the queue, because the call scripts contained "Election day is tomorrow". |
| 2026-11-2 4:50PM ET | A teammate suggested moving what we can to 11-3 and reordering the queue based on timezone priority (ET - first, CT - second, etc) because eastern timezones have a shorter window to finish. |
| 2026-11-2 5:00PM ET | The on-call engineer moved 1 large robocall which could be moved to 11-3 to 11-3 via a database update. |
| 2026-11-2 5:05PM ET | A teammate provided the on-call engineer with a list of ordering for the robocalls based on timezone and the on-call engineer reordered the queue was reordered based on timezone. |
| 2026-11-2 6:00PM ET | The on-call engineer checked the CallHub queue saw multiple campaigns cleared the queue from previous check. The queue was being digested at a reasonable pace. The re-ordering of the queue, provided an extra 2 hours to process the jobs. It was determined at this time that the time was tight, but the queue should process. |
| 2026-11-2 8:00PM ET | The on-call engineer checked the queue status and saw CallHub was also stuck in the middle of dialing for 15 minutes, some audio was stuck being verified for 15-30 minutes at a time, 2 more calls were added to the queue, and was not progressing at a rate that would finish before the 9PM cutoffs in various timezones. |
| 2026-11-2 8:05PM ET | The on-call engineer messaged a teammate and another teammate in the slack group DM that the queue was going to get stuck, and none of the calls would be processed, so some of them had to be cancelled. |
| 2026-11-3 12:00AM ET | The on-call engineer had finished babysitting the queue, getting through what could get through and cancelling/refunding what could not. The on-call engineer submitted a list of the 6 campaigns that were cancelled in the slack group DM to a teammate and another teammate. |
| 2026-11-3 8:00AM ET | A teammate inquired about 11-3 queue size and asked if we would have the same problem. |
| 2026-11-3 8:30AM ET | The on-call engineer determined that there was only 4 calls in the queue for 11-3 and it would finish. |
| 2026-11-3 12:00PM ET | The on-call engineer noted in standup the queue incident over the past night. |
| 2026-11-3 12:00PM ET | A support staff member alerted the on-call engineer in slack that some calls had failed earlier in the day on 11-2 and using the normal product behavior, the users were refunded and emailed. The users had reached out to Customer Support inquiring about it. |
| 2026-11-3 1:00PM ET | The on-call engineer provided the team with a list of the robocalls 11-2/11-3 including<br>6 cancelled manually by the on-call engineer<br>6 failures<br>28 dialed |

### Root Cause Analysis - [Five Whys](https://en.wikipedia.org/wiki/Five_whys)

1. **_Why?_**
    1. We overran our queue capacity for robocalls. Robocalls can take a few minutes to a few hours to fully dial. If a robocall is running when 9PM arrives for a timezone, the calls are stopped and resumed the next day. With the influx of robocall campaigns from our coupon deal for free robocalls, we were unable to process the volume of robocalls in the queue before 9PM on 11-2.
2. **_Why?_**
    1. CallHub has the limitation with their API that we are unable to know the status of a robocall once we send it to be dialed using the CallHub API. The status of a robocall does not auto-flip to "Done" when it is finished. The status must be manually flipped to "Done" either in the CallHub UI or via the API. Because of this, once we send a robocall to be dialed, we have no insight into it's behavior and our only mechanism is to flip it to "Done" at a given time. We have to estimate when it will be done based on the dialing speed listed, audio verification time-range, and potential slowdowns that have been seen in the past where CallHub does not dial at the speed listed. After the estimated time has elapsed, we flip the robocall to "Done" via the CallHub API and process the next call. If we send more campaigns then what our account limit can handle (120 calls/minute), CallHub freezes and does not dial anything until the limit is dropped.
    2. We did not build the capabilities to stop robocalls from being created if we could not process them. We did not build altering if the queue was in this situation.
    3. GoodParty started a Coupon for free robocalls which created an influx of usage the day before the election.
3. **_Why?_**
    1. When we asked CallHub for this capability, but they wanted us to sign an agreement for a higher tier throughput and customer support(in which they would provide this capability). We did not want to sign the agreement or switch vendors.
    2. We did not believe that the robocall volume would exceed what we had historically seen.
    3. We did not know the adverse effects of the combined influx of robocall-outreach from the free-robocall coupon campaign with the CallHub integration's limited capabilities.
4. **_Why?_**
    1. We had historically used CallHub manually. The politics team was comfortable with CallHub and using the self-serve tier was sufficient for their needs, so paying for a higher tier was not agreed on.
    2. Robocalls had historically been a valuable but low-volume outreach mechanism, as reported by the politics team, so investing into prevention mechanisms wasn't prioritized.
    3. The CallHub integration limitations and coupon deal were not communicated to the appropriate stakeholders.
5. **_Why?_**
    1. Instead of signing with CallHub or moving to another vendor, we decided to ride it out as it is.
    2. We waited until too late to communicate with customers and cancel their robocalls.
    3. The promotional deal was not communicated with the team members who knew about the CallHub limitations.
    4. The limits of the CallHub integration was not communicated with the team members who knew about the promotion.

### Recommended Improvements

1. **Capacity-aware scheduling gate.** Before a robocall is accepted for a given day, project the queue's drain time at the real observed dial rate and compare it against the earliest timezone cutoff (9pm ET). If it won't finish, block the slot and offer the next day. This is the single change that would have prevented the incident outright, given our limitations.
2. **A real-rate capacity model, not the nominal 120/min.** Observed dialing ran far below 120/min (credits/channel cap is the true bottleneck). Size the gate off measured throughput, not CallHub's advertised number. Incorporate this new value with the capacity-aware gate.
3. **Re-evaluate vendor.** Sign with CallHub to get the needed capabilities and higher tier throughput or switch vendors. The majority, if not totality, of our pain and work has been trying to get around the limitations. Removing the limitations is the highest ROI.
4. **Proactive detection that posts to a public channel.** The first signal anyone got was an overdue-call alert, and everything after it happened in a DM. A monitoring agent in Slack could have caught this hours or days earlier and announced it publicly on its own: watching queue depth, the measured dial rate, queue growth rate, and each call's timezone cutoff, it posts "projected to miss the 9pm ET cutoff by N calls" before it happened, with the current state and recommended actions. This is the loop our agent swarm is built for, and keeping it in a public channel means the whole team sees a developing problem instead of three people in a thread. It can take the safe actions itself (reorder by cutoff, pause new intake) and escalate the irreversible ones (cancel, refund) for communication with customers before it happens. In retrospect, we could have predicted the growth rate and capacity limit before it happened.
5. **Close the communication gaps, in the open.** Two gaps compounded this. The free-robocall promotion was never raised with the people who knew the CallHub limits, and the incident itself was run in a group DM, so the developing problem, the decisions, and the customers impacted stayed in the group DM. Make it standard that any promotion or change loading a capacity-constrained integration is reviewed with the owning team before launch, and that incidents and customer-affecting issues are coordinated in a public channel with support looped in early, never in DMs.
