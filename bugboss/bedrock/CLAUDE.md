# bedrock

A Pi API provider over Bedrock's `InvokeModel`, used by the incident agent.

## Why not `Converse`

Converse drops thinking blocks that have **empty text but a live
signature** — which is exactly the shape Opus 5 produces under adaptive
thinking.

Resume depends on those surviving. A thinking block's signature is
cryptographically bound to the prefix: the system prompt, the tools array
and every earlier message. Drop one and the replay is rejected, so a
restarted agent cannot continue its own session. Since every merge to ops
`main` restarts this container, resume is the normal path.

So this module exists to keep the raw Anthropic message shape intact end to
end.

## Usage is the cost record

Per-turn usage is what the Boss sums out of the session file after a child
exits. Nothing else records what a run cost, and it is read from the file
rather than reported by the agent because a killed agent never gets to
report — and the file is on disk either way.

`emptyUsage()` exists so a turn that fails still has a shape to record
rather than a hole.

## No explicit credentials

The client is constructed with no `credentials` key, so the SDK's default
chain resolves them: the ECS task role, in the parent and in a child alike.

That matters now that agents run for a day. The container provider refreshes
on its own schedule, so a client built at startup keeps working for the whole
run. Setting credentials explicitly here would pin them at construction and
defeat that.

## The model id is pinned in the session

Bedrock does not restore it on resume, because deployment ids are
provider-specific. The mapping lives in SSM and retunes without a deploy, so
a restart after a retune would replay every running agent against a
different model — rejecting every thinking block, quietly, since
`drop_block` is deliberately silent.

`agent/run.ts` resolves from the stored prefix for that reason, and alarms
distinctly when the environment disagrees.

## No retries here

There is no backoff anywhere in this module, deliberately: Pi owns the
retry loop, and a second layer underneath it would multiply attempts
invisibly.
