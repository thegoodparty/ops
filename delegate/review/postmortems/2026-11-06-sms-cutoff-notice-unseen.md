---
title: SMS Cutoff Notice Unseen
date: 2026-11-06
source: https://goodparty.clickup.com/90132012119/v/dc/2ky4jq2q-20493/2ky4jq2q-199093
---

# SMS Cutoff Notice Unseen

## Lessons

- Removing the only interactive path to a required user-facing screen during a copy or visual rework, which leaves a click that does nothing and contradicts the spec (closed SMS tile `handleTileClick` returning early in ChannelTileGrid.tsx).
- Rewriting a test to assert the new broken behavior and deleting the assertion that guarded the requirement, so the test protects the bug (ChannelTileGrid.test.tsx asserting the closed tile opens nothing and no longer fires `NoticeViewed`).
- Removing the UI trigger for a tracked analytics event without keeping a test that the event still fires from a normal user path (`Outreach - SMS Cutoff Notice Viewed` with surface `sms_tile` in gp-webapp outreach hub).

## What happened

PR #2747 in thegoodparty/omni added an SMS cutoff notice for candidates inside their texting cutoff window. Early on the branch, commit 54604df made the closed SMS tile on the outreach hub open the cutoff notice dialog and fire `Outreach - SMS Cutoff Notice Viewed` with surface `sms_tile`. A few hours later, commit 52c677c reworked the cutoff copy and "quieted" the closed tile. It replaced the dialog with a hover tooltip, and `handleTileClick` in ChannelTileGrid.tsx began returning early for a closed text tile. The product one-pager called for the tile to open the info screen with links to other channels, so this went against the spec. The same commit rewrote ChannelTileGrid.test.tsx to assert that the closed tile opens nothing and sends no analytics event, and it removed the assertion that the click fires `NoticeViewed`. The PR merged and shipped. After that, the only ways to reach the notice were a `?compose=text` deep link or a resumed draft.

In production nothing errored, so the log and metric alerts on gp-api had nothing to fire on. The notice event fired zero times for about 19 days, while the Pro wizard's version of the event kept arriving, which showed tracking itself worked. The Amplitude event health monitor treats a never-fired event as too new to judge for 30 days and posts to a channel the bug rotation does not read. A hand-run launch watch pilot finally caught the gap.

Review missed it because the test had been changed to match the dead end, and review comments focused on backend guards such as Peerly submit and purchase validation. No one compared the merged behavior with the one-pager.

The fix, PR #3522, makes a click on the closed tile open the notice again with surface `text_tile`. A proposed automated daily launch watch, PR #3525, was closed without merging, so that monitoring gap is still open.
