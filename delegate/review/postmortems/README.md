# Post-mortems the PR reviewer learns from

Each file here is one production incident, reduced to what a code reviewer
needs: the mistakes a pull request could repeat, and a technical account of what
happened. The full post-mortem stays in ClickUp, linked from `source`.

## Why they live here

The reviewer believes what it is handed. In a test, two deliberately wrong
post-mortems made it stop catching a real repeat. So a post-mortem reaches the
reviewer only by merging here, which puts every one, and every lesson line, in
front of a human: this path is owned by `@thegoodparty/gp-contrib` like the
rest of `delegate/`. A PR under review cannot change them either, because they
are read from this repository, not from the repository being reviewed.

## Format

```
---
title: Statewide read freeze
date: 2026-11-04
source: <ClickUp page URL>
---

# Statewide read freeze

## Lessons

- <the mistake in general terms> (<where it happened>)

## What happened

<150 to 300 words: what changed, how it failed, why review missed it, the fix>
```

- **Lessons** are one line per distinct mistake a diff could show, 1 to 6 per
  incident. The general wording is what lets a lesson match a different feature
  that makes the same mistake; the part in parentheses is what lets it match the
  same feature. The reviewer's first pass reads only these lines.
- **What happened** (at most 300 words) is what the reviewer reads when a lesson matched, to decide
  whether the pull request really repeats the incident.
- The file name is `<date>-<slug>.md`.

## This repository is public

Keep code identifiers, file paths, service names and public PR numbers. Leave
out names of people, staff or customers; user, candidate or customer counts;
money amounts; contact details; Slack channel names; and internal links other
than `source`. Use roles ("a staff member", "the on-call engineer").

## How files get here

Weekly, Delegate opens one PR that adds the post-mortems written in ClickUp
since the last sync, and updates any that changed, in this format. A human
reviews the lessons and the redaction, then merges.
