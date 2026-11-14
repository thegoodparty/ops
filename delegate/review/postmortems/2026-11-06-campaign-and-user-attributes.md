---
title: Campaign and User Attributes
date: 2026-11-06
source: https://goodparty.clickup.com/90132012119/v/dc/2ky4jq2q-20493/2ky4jq2q-181773
---

# Campaign and User Attributes

## Lessons

- Hiding a critical self-service action behind a stricter precondition than the backend endpoint actually needs, so users who could have been served get no option at all (AccountSettingsButton.tsx returns null when campaign.details.subscriptionId is empty, though createPortalSession only needs a Stripe customer id).
- Removing the only fallback path for an action during a UI refactor, leaving affected users no way forward when the main control is hidden (omni #577 dropped the "Send us an email" link next to Manage subscription).
- Reading a value from a single copied field when the backend already has fallback lookups for it, so the frontend breaks in cases the API handles (app/dashboard/account/page.tsx reads subscriptionId only from campaign.details).
- Copying state owned by an external system into several app-written fields with nothing that reconciles them, so any write-side bug leaves records out of sync (Stripe subscription state duplicated into campaign.details, user.metaData.customerId and campaign.is_pro).
- Updating a shared JSON column with a non-atomic read-modify-write, so concurrent writes can silently drop fields (patchCampaignDetails losing campaign.details.subscriptionId, fixed in omni #1942).
- Attaching a user-level entitlement to a per-campaign record, so it can be lost or go stale when a user has several campaigns or moves between products (is_pro and subscriptionId stored on campaign instead of user).

## What happened

A paying Pro user found no "Manage subscription" button in account settings and could not cancel. The cause traces back to an older change that hid the button for Pro campaigns with no campaign.details.subscriptionId. At that point a "Send us an email" link still sat next to it as a fallback. Then omni #577, a refactor that merged the profile and account pages, moved the check into AccountSettingsButton.tsx (if (!subscriptionId) return null) and removed the email link. A code comment justified the check as protecting "limbo" Pro accounts, such as ones mid-cancellation, where the billing portal might error. After this change, any Pro user whose campaign had lost or never received subscriptionId was stuck with no way to cancel. Several write paths could cause that: a read-modify-write race in patchCampaignDetails (fixed in omni #1942), an older checkout flow that sent only customer_email, an admin setting is_pro by hand, and the deleteUser cascade. Review missed it because the check looked like a reasonable defensive guard. But it was stricter than the backend: createPortalSession in gp-api purchase.controller.ts needs only the Stripe customer id, and it can already recover that from user.metaData.customerId or any campaign's subscription. A drift script added in omni #1955 (pro-without-subscription-drift.ts) flags exactly this group of users, but it only runs by hand. The problem went unnoticed for about 120 days, until support canceled the subscription directly in Stripe and reported the bug. omni #3615 fixed the check. The deeper issue is that subscription state is copied into campaign.details, user.metaData and campaign.is_pro with nothing reconciling those copies against Stripe. The planned follow-ups are to move Pro state onto the user and to run regular reconciliation against Stripe.
