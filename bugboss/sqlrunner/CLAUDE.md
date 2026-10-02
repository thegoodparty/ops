# sqlrunner

The sidecar that runs one read-only query against gp-api prod for an incident
agent, after a person in the on-call rotation approves it in Slack. Its own
container ("sqlrunner") in the BugBoss task, same image, entry point
`main.ts`, listening on `127.0.0.1:8790`.

The agent's `request_sql_query` tool goes through the Boss's in-process
`createSidecarSqlPort` (`agent/sql.ts`), which adds the incident's thread and
forwards here. The agent can also call this port directly, so nothing a caller
sends is taken on trust.

- `runner.ts`: the state machine and the HTTP routes. Every decision.
- `slack.ts`, `execute.ts`: the Slack and Postgres wiring it is handed.

## The trust boundary

The incident agent is untrusted and shares everything with the Boss except
this container's PID namespace and filesystem: same Unix user, same task role,
same loopback, and it can read `BUGBOSS_SECRETS`, so it holds the Slack bot
token and signing secret. Each choice below follows from that.

**The password lives only here.** It reaches this container through ECS
`secrets`, injected by the execution role at launch. The task role cannot
read it, so neither can the agent. Nothing in the Boss's container may ever
be given it.

**Approval is a reaction, not a button.** A button click arrives as a signed
request, and the agent can sign one. A reaction is read back from Slack with
`reactions.get`, and the only user the agent's token can react as is the bot,
which is excluded. Only members of the rotation user group count. Nothing of
ours ever reacts to the message, so a reaction from the bot is the agent
seeding a pill for a person to click, and it fails the request.

**The thread is checked with Slack, not taken from the caller.** The Boss
names the incident's thread, but the agent can skip the Boss and name any
incident and any thread. Before posting, the runner reads the thread's
top-level message and refuses unless it is that exact message (not a reply),
the bot posted it, and its first line names the same incident number. This
stops an agent from asking "Incident 812 wants to run a query" under
incident 812 so the approver judges it against the wrong incident. It does
not stop the agent posting a fake top-level header with the bot token; that
would be a new, visible message in the channel.

**What the approver reads is what runs.** The SQL must be printable ASCII
(bidi controls and zero-width characters can show one query and run
another), at most 40 lines of at most 200 characters, with no two blank
lines in a row, so nothing hides below Slack's "Show more". The reason must
be printable ASCII on one line. The message states the query's line count.

**The message is re-read before it runs.** The agent can `chat.update` our
message, so a person could approve SQL that is not what we stored. Before
running, the reply is fetched again and refused if it is gone, carries
`edited`, or its text differs from what Slack stored at post time. `edited`
stays set after an edit is reverted, which is what closes "edit, approve,
edit back".

**Its own log group.** The task role cannot read it, so the agent cannot read
what other incidents asked for or got back.

## Invariants

- **No result value reaches Slack.** Not rows, and not a Postgres error
  message either, which can quote a value ("invalid input syntax ...: <the
  value>"). Slack gets the error code; the agent gets the message. The tests
  assert this over every outcome; keep them.
- **Nothing logs the password, the connection string, or a result value.**
  The SQL and reason are logged: they are already in Slack, and they are the
  audit trail of what ran against prod.
- **Nothing is truncated.** The full SQL is posted, escaped, in a code block.
  An oversized result fails with a message saying how to narrow it; it is
  never cut to fit. A duplicate column name fails rather than silently
  collapsing in the row object.
- **The executor is read-only by construction, not by trust in the SQL.**
  `BEGIN READ ONLY`, `SET LOCAL statement_timeout`, the extended query
  protocol (one statement per Parse, so Postgres refuses a second), always
  `ROLLBACK`, a fresh client per query and always `end()`. The `;` check in
  validation is a clear error for the agent, not the fence.
- **Refusal wins.** Any rotation `:x:` beats any `:white_check_mark:`.
- **State is memory only.** A restart loses pending requests; the agent's
  tool treats a 404 as "lost, ask again". Do not add persistence that the
  agent's container could reach.
- **No rotation group, no requests.** POST answers 503 and posts nothing.

## Slack details that bite

- `conversations.replies` always returns the thread's parent first, so
  `limit: 1` never returns the reply. `slack.ts` pins `oldest`/`latest` to
  our ts and finds the reply by ts.
- Given a reply's ts, `conversations.replies` still returns the thread's
  parent first, so `threadParent` comparing the parent's ts with the one
  asked about is what catches a reply passed off as a thread.
- Read calls do not retry: a 429 skips one 10s poll rather than parking the
  loop inside the SDK. Writes retry for up to five minutes.
- Five pending requests polled every 10s is 30 `reactions.get` a minute,
  under Tier 3's 50. Raise `MAX_PENDING_TOTAL` or shorten the poll only with
  that in mind.
