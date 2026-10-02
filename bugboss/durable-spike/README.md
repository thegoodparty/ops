# Pi Durable spike

A trial of moving BugBoss's two agents onto
[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
(`@earendil-works/pi-durable`). Production code does not import anything in
this directory. Run it with:

```
npx tsx --test bugboss/durable-spike/*.test.mts
```

## What the tests prove

| Test | Question | Answer |
| --- | --- | --- |
| `bedrock.test.mts` | Does our InvokeModel provider work under Pi Durable? | Yes, with one adaptation. The silent thinking signature is stored. |
| `resume.test.mts` | Does a run survive SIGKILL in the middle of a tool round? | Yes. A real child process is killed while two tools run. A fresh harness on the same SQLite file finishes the run. The replay-safe tool reruns. The unsafe wait comes back to the model as "interrupted". Resending the same request id returns the original submission. |
| `boss.test.mts` | Can the Boss answer several threads at once? | Yes. Each thread is its own conversation, and both requests were open at the same moment. |
| `boss.test.mts` | Can the Boss steer an agent that is blocked in a wait? | Yes. `message_agent` is one `submit` with `whenBusy: "steer"`. The agent's `monitor` watches its own inbox and returns, so the steer reached the agent's next turn in milliseconds, through an hour-long wait. |

## What a migration would delete

| Today | Replaced by |
| --- | --- |
| `agent/session.ts`: JSONL upload to S3 after each turn, restore on resume, the `bugboss_exit` record | Checkpointed tasks in one SQLite file. A killed run stays pending, so it cannot look finished. |
| `dispatcher/spawn.ts`, the in-memory `running` map, and the dispatcher's relaunch and resume core | One harness running every conversation. `harness.resume()` at boot. |
| `pending_directive`, `createDirectiveWatcher` (10s poll), `createWaitInterrupt` | `submit({ whenBusy: "steer" })`, and a wait that watches the inbox |
| The commander's turn loop, `compactTranscript`, thread `state.json`, the thread TTL lock and waiting map | A conversation per thread, with background compaction and the inbox |
| `pending_wait` / `pending_question` replay markers | `replay: "safe"` and the interrupted result |

The incident domain stays as it is: triage, the tool API, transitions,
`incident_wait`, the board and reports.

## What the migration costs, found by doing it

1. **Pi 1.0 first.** Pi Durable needs `pi-ai` 1.0. This branch bumps
   `pi-ai` and `pi-coding-agent` from 0.87 to 1.0. The full suite (1,435
   tests) and `tsc` pass unchanged on 1.0, so this step is cheap and can ship
   on its own.
2. **ESM.** ops compiles as CommonJS, and every Pi 1.0 entry point is
   ESM-only. Today that is why bugboss reaches Pi only through dynamic
   `import()`. The spike uses `.mts` files, which can only see bugboss
   modules through their default export. A real migration should switch ops
   to `"type": "module"` first, as a separate change.
3. **Model routing moves.** Pi Durable resolves a model from the provider's
   own catalog, and the builtin Bedrock catalog stamps Converse on every
   entry. Without the `getModels` override in `bedrock.test.mts`, our model
   silently streams Converse again. That is the bug `bedrock/runtime.ts` was
   written to catch, and `assertBedrockInvokeModelRouting` only knows
   `ModelRuntime`, so it needs an equivalent for `Models`.
4. **Conversation ids are numbers.** A tool argument declared as a string
   fails validation and gives the model an error result. A scripted Boss
   carried on as though it had delivered. Real tool code has to convert, and
   tests have to assert the tool result, not the model's reply.
5. **One process, no isolation.** A wedged agent shares the event loop with
   every other agent and the Boss. The dispatcher's SIGKILL deadline becomes a
   cooperative `abort()`. Bash and other tools still run as subprocesses.
6. **Durability of the file.** SQLite runs with `synchronous = NORMAL`, so
   the newest commit can be lost on a host crash. The file has to join the
   existing snapshot to S3, and transcripts and incident tables are only
   committed together if they share one database.
7. **Experimental.** 1.0.0 shipped on 2026-10-01, and its README says the API
   changes without notice. Issue #10320: the bundled coding tools shipped
   without `replay`, so a crash interrupts even `read`.
