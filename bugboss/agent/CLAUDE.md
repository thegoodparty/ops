# agent

The incident agent: a Pi session running in a child process, against
Bedrock, with a fresh checkout of omni.

## What it is allowed to do

It opens pull requests. **It never merges one.** The prompt says so to save
it turns, but the actual controls are branch protection on `main` and the
GitHub App's permissions — it runs with a real shell, so a prompt is not a
control.

In AWS it runs on the Boss's own identity, resolved through the container
credential provider, which refreshes itself for as long as the run lasts.
Nothing inside the container separates the two, so what limits an agent is
what the task can reach at all — no database, no release path.

GitHub is different. It gets the App's **credentials**, not a token minted for
it, and re-mints every twenty minutes. Installation tokens last an hour and an incident can
run for a day, so a token handed down at launch would expire
mid-investigation and surface as `gh` refusing to push a branch the agent
had already built.

## The two blocking tools

`monitor` and `contact_human` each cost **one turn** no matter how long they
wait. That is what keeps a multi-day incident from saturating context on
polling, and it is why the prompt forbids polling with bash in a loop.

- `monitor(command, …)` — **the command must be read-only.** On a container
  restart the session holds a tool call with no result, so the tool runs
  again; an action would be performed twice.
- `contact_human(message, …)` — re-entrant. The marker is written *before*
  the post, so a resumed agent resumes waiting rather than asking twice. It
  re-posts when the stored message differs from the new one, and when
  `messageTs` is empty because the post itself failed — otherwise one Slack
  hiccup becomes a silent 24-hour wait that escalates for the wrong reason.

Both take the harness's deadline signal combined with Pi's own, so the soft
deadline can interrupt a blocking tool. Without that, `steer` only lands
after the current turn's tool calls finish — and the agent spends most of
its life inside a `monitor` with an hours-long timeout.

## What it writes goes straight to Slack

`contact_human`, the hand-off brief, the root cause, the resolution evidence
and the post-mortem are all posted as the agent wrote them, so the prompt
carries the mrkdwn contract ("Writing to Slack" in `prompt.ts`). The model is
told **not** to escape `&`, `<` or `>` itself — `slack/format.ts` does that at
the boundary, and a model that pre-escapes would post `&amp;amp;`.

The conversion is a backstop, not the mechanism. It only fires on the Markdown
that slips through anyway, and it runs on the Slack copy alone: the stored
root cause and post-mortem stay as the agent wrote them.

## Directives

The poll in `contact_human` uses a **non-draining** read
(`GET /incidents/:id/directives`). Draining there destroyed `stop`,
`merged`, `handoff`, `new_signals` and `resumed_after` — including the
`resumed_after` the dispatcher inserts at launch, which the agent's first
replayed call would eat before it ever ran `get_incident`.

The one reply it acts on is consumed by id. Everything else stays pending
for `get_incident` to deliver. A `human_message` left pending would
otherwise come back a turn later and read as a *new* instruction, since
directives render as prose.

That read is on the **read-only** connection, so a 30-second poll never
queues behind the write queue's synchronous S3 PUT.

## Sessions and resume

One layout: `sessions/incident/<id>/session.jsonl`, which the Slack agent
and the S3 lifecycle rule both expect. `BUGBOSS_SESSION_REF`
is **required** — there is no fallback, because the old default wrote to a
key nothing read, producing a session that appeared to persist and restored
nothing.

Every flush checks `lastError()`. A silently failing S3 write means the next
restart starts from scratch with the whole investigation lost, and combined
with relaunch that is an unbounded loop of agents each beginning again. N
consecutive failures steers the agent to hand off.

**The model is pinned in the session.** On resume it resolves from the
stored prefix, not from env — Bedrock does not restore it, and the SSM
mapping retunes without a deploy. Replaying against a different model
rejects every thinking block, and `drop_block` is deliberately quiet.

## Exit

`exitCodeFor` returns non-zero when `session.state.errorMessage` is set. A
soft timeout the agent handed off inside still exits 0: the signal is an
aborted turn, not the deadline.
