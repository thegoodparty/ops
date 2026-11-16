---
title: Robocall Queue Starvation
date: 2026-11-03
source: https://goodparty.clickup.com/90132012119/v/dc/2ky4jq2q-20493/2ky4jq2q-203053
---

# Robocall Queue Starvation

## Lessons

- Mapping a vendor's statuses onto a whitelist and treating anything outside it as "not started", so an accepted-but-unrecognized status parks the work in an in-flight state (CallHub returning 8 on an accepted START, with only 1 to 4 mapped in gp-api).
- Reusing the destructive handler of a definitive failure in a guard whose premise is weaker, without re-checking that premise (the deadlock backstop voiding the card hold as if a 4xx reject meant no calls went out, after a 200 START).
- Leaving an in-flight state with no deadline tied to the delivery window in a serial queue, so one stuck item spends the whole day's capacity (a row stuck in `dialing` blocking the one-at-a-time send queue).
- Recording a money-affecting failure only in logs, with no notice to the affected person and no repair path, when the failure is forced rather than returned by the vendor (no candidate email or rebook on a voided hold).

## Post-mortem

### Overview

**Ticket:** [ENG-11570](https://goodparty.clickup.com/t/90132012119/ENG-11570)

| Users Impacted | 1 |
| ---| --- |
| Impact Duration | 33h26m |
| Time to Detect | 27h04m |
| Time to Resolve | 6h22m |

Impact start is the 11/2 dial window opening at 09:00 ET, impact end is the fix live in prod on 2026-11-03 at 6:26 PM ET, and detection is the #bugs report at 12:04 PM ET on 11/3. The candidate's send was never delivered, so the fix removes the cause but repairs nothing. The capacity side of the same day is in [2026-11-03 | Election Robocall Postportem](https://goodparty.clickup.com/90132012119/v/dc/2ky4jq2q-20493/2ky4jq2q-179213); this page covers the state machine that stranded the individual send.

### Participants
*   the on-call engineer (ST)
*   an engineer (HK)
*   a support staff member (C)

### Timeline

| Time (UTC) | Event |
| ---| --- |
| 2026-11-01 09:24pm | A candidate's robocall (outreach 89488) is authorized and the card hold is placed. |
| 2026-11-02 02:00pm | The 11/2 dial window opens. 89488 gets no launch attempt all day: the send queue runs one robocall at a time, and runs ahead of it (88247, 88342, 88541) sit in CallHub status 8, which the code does not know, while abort calls to them return 400. |
| 2026-11-03 02:14am | First launch attempt for 89488. CallHub returns 400 over the calls-per-second limit and the sweep backs off. |
| 2026-11-03 02:24am | Retry. CallHub accepts the START with status 8, the code logs "did not read back STARTED; reconciling", the status read returns 8 again, and the row is left in `dialing`. |
| 2026-11-03 02:54am | The dialing deadlock backstop force-fails the send as a permanent CallHub failure and voids the hold. The outreach now reads aborted. |
| 2026-11-03 05:04pm | A support staff member reports the missing send in #bugs after the candidate asks support. The on-call engineer says he is looking. |
| 2026-11-03 05:16pm | ENG-11570 is filed and flagged a possible duplicate of ENG-11563, with the on-call engineer as assignee. |
| 2026-11-03 09:22pm | An engineer comments that mapping status 8 to Starting is not the right fix. |
| 2026-11-03 10:53pm | [PR #3537](https://github.com/thegoodparty/omni/pull/3537) merges, adding `CALLHUB_VB_STATUS.STARTING = 8`. |
| 2026-11-03 11:26pm | [Release 41734610199](https://github.com/thegoodparty/omni/actions/runs/41734610199) (commit 5f10f717) is green through prod and the gp-api promote succeeds. The fix is live. |
| 2026-11-06 01:18pm | Closing check posted: release green, hold voided, send not repaired. |
| 2026-11-10 11:12pm | ENG-11570 is set to Resolved on the fix as-is. |

### Root Cause Analysis - [Five Whys](https://en.wikipedia.org/wiki/Five_whys)

1. **Why was the hold voided?** The backstop ran the same `failSend` path as a definitive 4xx reject, whose contract is "no calls were placed, void the hold". The launch had been accepted with a 200 START, so that premise did not hold.
2. **Why was the run still in** **`dialing`****?** CallHub answered the accepted START with status 8. The code maps only 1, 2, 3 and 4, so the launch logged "did not read back STARTED", reconciled, read 8 again, and stayed in `dialing` with the hold still authorized.
3. **Why did it not launch earlier in the day?** The send queue is serial and gates on `dialing`. Earlier runs were parked in the same unresolved state, and their aborts returned 400 from CallHub, so the gate stayed shut for most of the 11/2 window. 89488's first attempt was 9:14 PM ET.
4. **Why does a normal launch depend on a recovery path, and why does one stall cost the day?** The state machine decides "did it dial" from a status whitelist, so the unknown branch became the main path rather than an edge case, and the queue has no per-run deadline tied to the scheduled send window: a run that never resolves spends the day's capacity instead of failing fast.
5. **Why did nobody notice until the next afternoon?** A force-fail is treated as a vendor reject all the way through: the hold is voided, the outreach reads "aborted", and there is no candidate notice and no rebook path. The first signal was a support staff member hearing from the candidate.

**Root cause.** CallHub's real accepted-start status (8) was not recognized as a started dial, so launches parked in `dialing`, blocked the one-at-a-time queue, and were force-failed by a backstop that voids the hold on a guess.

### Recommended Actions

1. **Bound the serial queue by the scheduled send window.** In `packages/gp-api/src/outreach/services/outreachRobocallSend.service.ts`, fail and re-queue a run that is still `dialing` within the current 09:00-21:00 window instead of after hours, so one unresolved launch cannot consume a whole day of the queue. The follow-up list is on [ENG-11563](https://goodparty.clickup.com/t/90132012119/ENG-11563).
2. **Stop voiding a hold after a 200 START.** Change `forceFailDeadlockedDialing` to alert and hold the queue when the launch returned 200, and keep hold-voiding for a confirmed 4xx reject only. [PR #3537](https://github.com/thegoodparty/omni/pull/3537) covers status 8 but leaves this open. Then read the call count on CallHub campaign 4021660019010307814 and settle the voided hold on 89488.
3. **Tell the candidate when a paid send is force-failed.** Add a candidate-facing failure email with a rebook link, and move the deadlock CRITICAL log after the CAS so one run pages once instead of ten times. Track on [ENG-11570](https://goodparty.clickup.com/t/90132012119/ENG-11570).
