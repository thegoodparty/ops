# BugBoss build plan

**Design spec:** `docs/bugboss/design.md` in this repo. It is the acceptance
criteria, not background reading. Every chunk below names the sections that
define it.

**Status:** Phase 0 not started.

## Shape

Serial spine, wide fan-out, serial wire-up. The bottleneck is interfaces, not
work: almost every component depends on the data model and the tool API
contract, and on nothing else.

**One branch, one PR.** Chunks own disjoint files and every dependency is
declared in Phase 0, so parallel agents write into a single checkout with no
merge step. Commits happen at phase boundaries.

| Phase | Who        | What                                             |
| ----- | ---------- | ------------------------------------------------ |
| 0     | serial     | Scaffold, contracts, database layer, failing E2E |
| 1     | 9 parallel | One chunk each, against the contracts            |
| 2     | serial     | Composition root, make the E2E pass              |
| 3     | 3 parallel | Review the whole diff once                       |

Phase 0 is the risk. Eight agents building against a wrong interface is the
failure mode, which is why the E2E test is written _before_ the fan-out: it
forces the contracts to be exercised rather than merely declared.

## Phase 0 — the spine

Owned entirely by the driving session. Nothing in Phase 1 starts until this
lands.

- `bugboss/types.ts` — every entity, tool signature, directive shape
- `bugboss/db/schema.sql`, `bugboss/db/index.ts` — schema, the `withWrite`
  helper (serialized writes, `VACUUM INTO`, synchronous S3 PUT), read-only
  query connection
- `package.json` — **every dependency for every chunk**, declared now. This
  is the one file everyone would otherwise touch and the only guaranteed
  conflict.
- `tsconfig.json`, directory skeleton
- `bugboss/test/e2e.test.ts` — failing. Fake Grafana webhook in, stubbed
  model, incident opened, agent dispatched, PR opened, resolved, post-mortem
  written.

Spec: _Layer 1_ in full.

## Phase 1 — the fan-out

Nobody touches `types.ts`, `package.json`, or another chunk's files.

| #   | Chunk            | Owns                                          | Spec sections                                       | Status      |
| --- | ---------------- | --------------------------------------------- | --------------------------------------------------- | ----------- |
| 1   | Ingress          | `bugboss/ingress/{grafana,slack,human}.ts`    | Job 1, Human reports                                | not started |
| 2   | Triage           | `bugboss/triage/`                             | Job 2, Job 2b                                       | not started |
| 3   | Dispatcher       | `bugboss/dispatcher/`                         | Job 3, Authentication (child env scrubbing)         | not started |
| 4   | Tool API         | `bugboss/toolapi/`                            | Job 4                                               | not started |
| 5   | Incident agent   | `bugboss/agent/{run,session,tools,prompt}.ts` | Layer 3 in full                                     | not started |
| 6   | Bedrock provider | `bugboss/bedrock/`                            | Model and provider, Why InvokeModel is not optional | not started |
| 7   | Slack            | `bugboss/slack/{relay,agent}.ts`              | Job 5, Job 6                                        | not started |
| 8   | MCP + OAuth      | `bugboss/mcp/`                                | The MCP server                                      | not started |
| 9   | Pulumi           | `deploy/components/bugboss.ts`                | Infrastructure in full                              | not started |

Chunk 9 is fully independent and can start during Phase 0.

Each chunk writes its own tests. Each gets its spec sections verbatim in its
prompt: the agent implements a written contract rather than inferring intent,
and that is what replaces a per-task review gate.

## Phase 2 — wire-up

`bugboss/index.ts`, the composition root. Make the E2E pass. Mis-fits surface
here, all at once, which is the point.

## Phase 3 — review

Three agents over the whole diff at once: correctness, silent failures, type
design. One pass, not a gate per chunk.

## Things that will bite

Pulled forward from the spec's own findings so they are not rediscovered.

- **`ops` CI is unfiltered.** Every merge to `main` rebuilds and redeploys.
  Tolerable at 1-2 merges a day; revisit if that changes.
- **`Environment: infra` is a protection tag.** Tagging anything `dev` grants
  every engineer `Action: ["*"]` on it. Default tags do not reach resources
  created at runtime.
- **A dedicated Secrets Manager secret.** Not `DELEGATES`, whose every key
  becomes an env var in every container.
- **Confirm two IAM grants before starting:** `acm:RequestCertificate` and
  `ecr:CreateRepository`. Any widening must land _and finish applying_ before
  the PR that needs it.
- **First ECS service and first ALB in this repo.** No local pattern to copy.
  Set `ephemeralStorage` explicitly; the default is 20 GiB.
- **Double quotes and semicolons** in this repo, the opposite of omni, and
  nothing enforces it.
- **The repo is public.**

## Checks to run during the build

From the spec's open questions. Each is small and each invalidates real work
if it comes back wrong.

1. `curl -i` the 401 and confirm `WWW-Authenticate` survives the ALB.
2. Kill an agent mid-turn, resume, confirm thinking signatures replay.
   Separately: compact, restore from S3, confirm resume respects the
   compaction point.
3. Reproduce the Converse empty-thinking drop on Opus 5 before writing the
   InvokeModel provider.
4. Check whether `clear_thinking` passes through that provider.
5. Confirm the model catalog prices our Bedrock model ids.
6. Measure a real `npm ci` in the container to size concurrent fixers.
