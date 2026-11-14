---
title: Election Robocall post-mortem
date: 2026-11-03
source: https://goodparty.clickup.com/90132012119/v/dc/2ky4jq2q-20493/2ky4jq2q-179213
---

# Election Robocall post-mortem

## Lessons

- Accepting new scheduled work into a fixed-capacity queue without checking whether the projected drain time fits before the hard deadline (robocall scheduling with no capacity gate before the 9pm ET timezone cutoff).
- Estimating job duration from a vendor's advertised throughput instead of measured real throughput (CallHub robocall completion estimates based on the nominal 120 calls/minute rate).
- Processing a deadline-bound queue in arrival order instead of by earliest deadline (robocall queue not ordered by timezone cutoff).
- Shipping a capacity-constrained job queue with no alert when its projected backlog will miss a deadline, so the first signal is an already-overdue job (robocall queue overdue-call alert only).

## What happened

On the day before the election, the robocall queue that sends campaigns through the CallHub API took in more volume than it could dial before the 9pm cutoff in each timezone. A promotional coupon for free robocalls drove the spike. The integration has a basic limit: CallHub does not report when a robocall finishes, and a campaign stays active until the client marks it Done. So the scheduler estimates each call's duration from the listed dialing speed, the audio verification time and slowdowns seen in the past, then flips the call to Done through the API and starts the next one. If more campaigns run at once than the account's rate limit allows, CallHub freezes until load drops. Nothing stopped new robocalls from being scheduled into a day that could not finish them, and nothing raised an alert as the projected backlog grew. Real dial rates were well below the advertised 120 calls per minute. The first signal was an automated overdue-call alert in the afternoon. The on-call engineer moved one call to the next day with a database update and reordered the queue by timezone cutoff, Eastern first. That bought time, but CallHub dialing and audio verification stalled in the evening, and more calls kept arriving. Some campaigns were cancelled and refunded by hand, others failed and were refunded automatically, and some were delivered late. Review did not catch this because the queue was built for historically low volume, and the promotion was never checked against the integration's known limits. Recommended fixes are a capacity-aware scheduling gate that projects drain time from measured throughput against the earliest cutoff, scheduling by deadline, proactive alerts on projected misses, and moving to a CallHub tier or vendor that reports completion status and allows higher throughput.
