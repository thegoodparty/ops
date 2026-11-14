# Post-mortems the PR reviewer learns from

Each file here is one production incident: the post-mortem as written in
ClickUp, copied whole, with a list of lessons on top. Before every review the
reviewer reads the lessons of all of them, picks the few a pull request might
repeat, and then reads those post-mortems in full to decide.

## Why they live here

The reviewer believes what it is handed. In a test, two deliberately wrong
post-mortems made it stop catching a real repeat. So a post-mortem reaches the
reviewer only by merging here, which puts it, and every lesson line, in front of
a human: this path is owned by `@thegoodparty/gp-contrib` like the rest of
`delegate/`. A PR under review cannot change them either, because they are read
from this repository, not from the repository being reviewed.

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

## Post-mortem

<the ClickUp page, copied as it is>
```

- **Lessons** are one line per distinct mistake a diff could show, 1 to 6 per
  incident. The general wording is what lets a lesson match a different feature
  that makes the same mistake; the part in parentheses is what lets it match the
  same feature. They are the only part the reviewer reads before it has picked.
- **Post-mortem** is the ClickUp page exported as markdown, unedited, except that
  people's names become roles ("a staff member", "the on-call engineer"): this
  repository is public.
- The file name is `<date>-<slug>.md`. `postmortems-format.test.ts` in the
  folder above checks every file.

## How files get here

Weekly, Delegate opens one PR that copies in the post-mortems written or changed
in ClickUp since the last sync and writes their lessons. A human reviews the
lessons, and that the post-mortem is ready to teach the reviewer, then merges.
