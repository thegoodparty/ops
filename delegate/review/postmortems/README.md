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
  How to frame one: "Writing a lesson" below.
- **Post-mortem** is the ClickUp page exported as markdown, unedited, except that
  people's names become roles ("a staff member", "the on-call engineer"): this
  repository is public.
- The file name is `<date>-<slug>.md`. `postmortems-format.test.ts` in the
  folder above checks every file.

## Writing a lesson

One line, one mistake, in this shape:

```
<what the author did> <main verb naming what it breaks> <what the consequence was> (<where it happened>)
```

- **Start with the action the author took, not the fix.** "Removing a column or
  table in the same release that stops using it…", not "Ship destructive
  migrations one release apart".
- **Give that action a main verb that names its effect.** "…breaks the tasks
  still running the previous release…", not "…so tasks fail". A gerund with no
  main verb of its own, or the real verb buried after a "so", is not a
  statement.
- **Then say what breaks, and when it stops.** "…which name the dropped column
  in every SELECT, until the rollout replaces them."
- **The parenthesis carries where it happened**, so the lesson matches both that
  feature and any diff that repeats the mistake.

Test it against a diff before you commit it: can you point at the line that did
this, and name what failed because of it? If you can only point at a fix, or at
how bad the incident was, it is not a lesson.

Worked example:

> Removing a column or table in the same release that stops using it breaks the
> tasks still running the previous release, which name the dropped column in
> every SELECT, until the rollout replaces them (campaign.ai_content dropped in
> omni #3748, the same release that also removed its readers).

**Not a lesson:** a fix or approach ("run migrations as a deploy step ahead of
the traffic shift"), a restatement of the incident, or a fact with no mistake in
it. Those belong under Recommended actions in the post-mortem itself.

## How files get here

Weekly, Delegate opens one PR that copies in the post-mortems written or changed
in ClickUp since the last sync and writes their lessons. A human reviews the
lessons, and that the post-mortem is ready to teach the reviewer, then merges.
