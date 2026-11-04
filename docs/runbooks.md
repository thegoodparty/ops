# Runbooks

Each entry answers one alarm or one failure whose steps are not obvious, usually
within the hour it first fires. An entry that has never been run is a guess with
a heading, so the ones marked **rehearsed** have been walked through at least
once and say when.

- [Google Workspace → Identity Center group sync: credentials](./google-group-sync-credentials.md) — the manual Google setup, the service-account key, the secret and its 90-day rotation.

---

## The Bifrost reconciler is not converging

**Alarm:** `bifrost-vk-janitor-not-converging` (`deploy-workbench/bifrost-vk-janitor.ts`).
**Metric:** `AWS/Lambda` `Errors`, `Sum` over three consecutive five-minute periods, threshold 1.
**Email:** the `bifrost-vk-janitor-not-converging` SNS topic, subscribed to `aws-workbench@goodparty.org`.

**What it means.** The `bifrost-vk-janitor` Lambda has failed three scheduled
runs in a row, so for at least fifteen minutes it has not converged either the
gateway's live configuration or the governance of the virtual keys whose owners
are still in the `Engineers` group. Nothing has broken yet; what has broken is
the assurance that what Bifrost serves matches what the repo says. A run fails
by throwing a `JanitorFailure`, so the alarm counts the runs, not the changes:
**three failures means three attempts that got nowhere, which usually means one
cause repeating**, not three things going wrong.

**What it does not mean.** It is not the alarm for a *throttled* invoke. A
`TooManyRequestsException` (429) is a scheduling collision between the five-
minute rule and the deploy's invoke, the deploy's poll retries it, and the plan
keeps the two signals separate (`docs/bifrost-reconciler.md`, the
`reservedConcurrentExecutions` section). A throttle is not counted by this
alarm, and a run that never started is not a run that failed.

### 1. Confirm it is real, and read the last failure

```sh
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda --metric-name Errors \
  --dimensions Name=FunctionName,Value=bifrost-vk-janitor \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 300 --statistics Sum --region us-west-2
```

Three consecutive nonzero periods confirm the alarm. Then read the failure
itself — the handler rethrows the real error, so the log line names a stage:

```sh
aws logs tail /aws/lambda/bifrost-vk-janitor --since 1h --region us-west-2
```

The `JanitorFailure` message carries a machine-readable code and a human
sentence, and each code points at a different cause:

| Where the log says | What it means | Where to look |
|---|---|---|
| `membership-unavailable` | the cross-account read to the management account failed ("could not assume the directory role") | the `bifrost-vk-reader` trust in `deploy/components/bifrost-vk-reader.ts` and this function's role |
| `gateway-unavailable` | the setup token could not be read ("could not read the setup token") | `BIFROST_SETUP_TOKEN` in the `bifrost/gateway` secret |
| `desired-state-unavailable` | a governance document or `/bifrost/config` is absent or unreadable | `aws ssm get-parameter --name /bifrost/governance-overrides`; a bad *parse* is a red `deploy-workbench` run, not this alarm, so suspect a **deleted** parameter |
| `config-unavailable` | the gateway's live config could not be read | the gateway call section below |
| `convergence-failed` | everything was read, and a write or the convergence itself failed | the gateway call section below, then `vk-janitor-core.ts` |

### 2. The two causes that are not this alarm's fault

- **The gateway task is not running.** A stopped or hot-looping task makes every
  run fail identically. Check the service before touching the reconciler:
  `aws ecs describe-services --cluster bifrost --services bifrost --region us-west-2`.
  If the task is down, fix that; the alarm clears on the next successful run.
- **A parameter was deleted out of band.** Pulumi writes both governance
  parameters on every apply, so the durable fix is a redeploy, not a console
  edit: a console edit is overwritten by the next apply (`deploy-workbench/bifrost/governance-overrides.json`
  says so in its own comment).

### 3. What this alarm is not allowed to do

**Do not disable or raise the alarm to clear it.** Nothing in this design
disables the reconciler automatically (decision 15 of
`docs/bifrost-reconciler.md`), and the alarm is the only thing watching a job
that runs unattended every five minutes. If it is firing because a change was
bad, the fix is to revert the change — reverting the committed file converges
the running task back within one interval, which is success criterion 6 of that
plan.

**Do not widen the reconciler's permissions to make a run pass.** The
reconciler can never grant access: it applies desired state to keys that already
exist and creates none (criterion 8, decision 7). A run that fails on a
permission boundary is describing that invariant working, and the answer is to
fix the read it needs, not to hand it a write.

### 4. Escalate

If the cause is not in the table above, or three more runs fail after a
redeploy, this is a gateway or a cross-account problem rather than a reconciler
problem. `docs/bifrost-reconciler.md` records the design and its decisions, and
`docs/bifrost-virtual-keys.md` records what the keys are for. Both are the
places a fix belongs; this entry is the triage.

**Status:** not rehearsed. Written with step 6, which built the alarm, so the
steps above have been read against the code but not yet run against a real
failure.
