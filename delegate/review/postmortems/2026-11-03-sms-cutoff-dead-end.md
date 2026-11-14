---
title: SMS cutoff dead end
date: 2026-11-03
source: https://goodparty.clickup.com/90132012119/v/dc/2ky4jq2q-20493/2ky4jq2q-199033
---

# SMS cutoff dead end

## Lessons

- Removing a click handler and the dialog it rendered inside a commit described as a copy or tone change, which silently removes the only normal entry point to a required user-facing notice (closed text tile in ChannelTileGrid.tsx no longer opening SmsCutoffNoticeDialog).
- Rewriting existing tests in the same change so they assert the new behavior, instead of keeping tests that encode the product requirement, which lets a regression pass CI (tile tests rewritten in commit 52c677c).
- Bundling a behavior-changing commit into a larger feature PR, where it gets reviewed as part of the launch and its effect on that launch's own goal goes unexamined (52c677c shipped inside omni #2747 with the SMS cutoff).
- Shipping a feature whose success depends on an analytics event without adding an automated check that the event fires for the users who should trigger it (SMS cutoff notice event with no launch_watch.yaml check).

## What happened

Commit 52c677c, titled as a rework of SMS cutoff copy that would also quiet the closed membership and text tile, changed handleTileClick in ChannelTileGrid.tsx. Before the change, clicking the closed text tile set smsNoticeOpen and rendered SmsCutoffNoticeDialog (surface sms_tile). After it, the handler returned early for a closed text tile, the closed reason appeared only in a tooltip, and the dialog render was deleted. The commit shipped in omni #2747, the same PR that closed texting for candidates within 19 days of their election. omni #2830 followed the same day and did not restore the click.

In production, the closed text tile did nothing when clicked. The cutoff notice could only be reached through a ?compose=text deep link or a resumed draft, and almost no one arrived that way. For about 19 days, the Outreach - SMS Cutoff Notice Viewed event never fired from outreach, even though eligible candidates visited every day. Tracking worked: the Pro wizard's notice event was still arriving.

Review missed it because the commit looked like a copy and tone change, it shipped inside the larger cutoff PR, and its tile tests were rewritten to assert the new behavior. Nothing compared the change against the launch's goal of showing candidates the notice and steering them to another channel. Nothing alerted on it either. Grafana alerts watch gp-api logs and metrics, and nothing errored. The Amplitude event health monitor treats events that have never fired within 30 days as too new to judge. A hand-run launch watch pilot finally caught the gap.

The fix, omni #3522, made a click on the closed tile open the notice again. A daily launch watch alert (omni #3525, launch_watch.yaml) was approved but closed without merging, so that alert gap is still open.
