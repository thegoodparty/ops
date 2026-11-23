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

---

## The Bifrost gateway is saturated or not serving

**Alarms:** `bifrost-gateway-cpu-saturation`, `bifrost-gateway-memory-pressure`,
`bifrost-gateway-alb-5xx`, `bifrost-gateway-no-running-task`,
`bifrost-db-memory-pressure`, `bifrost-db-storage-queue`, all in
`deploy-workbench/alarms.ts`.
**Email:** the `bifrost-gateway-health` SNS topic, subscribed to
`aws-workbench@goodparty.org`.

Six alarms, one topic, because they are six ways of answering the same
question — is the gateway serving? — and the triage below is the same until step
3. Which one fired tells you where to start, so start there.

| Alarm | What it counted | Where to look first |
|---|---|---|
| `bifrost-gateway-cpu-saturation` | `AWS/ECS` `CPUUtilization`, `Maximum` ≥ 90% in 3 of the last 6 five-minute periods | step 1 |
| `bifrost-gateway-memory-pressure` | `AWS/ECS` `MemoryUtilization`, `Maximum` ≥ 85% in all of the last 6 | step 2 |
| `bifrost-gateway-alb-5xx` | `AWS/ApplicationELB` `HTTPCode_ELB_5XX_Count` ≥ 30 in one five-minute period | step 3 |
| `bifrost-gateway-no-running-task` | `ECS/ContainerInsights` `RunningTaskCount` < 1, or unpublished, for 4 consecutive periods | step 4 |
| `bifrost-db-memory-pressure` | `AWS/RDS` `FreeableMemory`, `Minimum` < 5% of the instance's RAM in 3 of the last 6 | step 5 |
| `bifrost-db-storage-queue` | `AWS/RDS` `DiskQueueDepth`, `Maximum` ≥ 1 in 2 of the last 6 | step 5 |

### 1. CPU saturation: requests are queueing inside the task

Sustained pinning, not a spike: the alarm needs fifteen of the last thirty
minutes above 90%, so it does not fire on the normal densification bursts that
have always been single five-minute buckets.

```sh
aws cloudwatch get-metric-statistics \
  --namespace AWS/ECS --metric-name CPUUtilization \
  --dimensions Name=ServiceName,Value=bifrost Name=ClusterName,Value=bifrost \
  --start-time "$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 300 --statistics Maximum Average --region us-west-2
```

Then find out *who*, from the container's own log group:

```sh
aws logs tail /aws/ecs/bifrost --since 1h --region us-west-2
```

Bifrost logs the request shape (model, tokens, duration), so a single caller
dominating the window is visible there. If it is one caller, throttle or ask
them to back off. If it is everyone, the task is undersized: raise `TASK_CPU`
(and `BIFROST_CONTAINER_CPU` with it) in `deploy-workbench/ecs.ts`. That is a
PR, not a console change — the task definition is Pulumi's.

**Do not raise the alarm's threshold to make it quiet.** The alarm measures the
state users feel. A rescued threshold means the next incident is silent, which
is the exact failure this alarm was built to end.

### 2. Memory pressure: a leak, not load

The threshold is 85% held for the whole thirty minutes, and normal operation is
under a third of that, so a reading this high is not traffic. Graph 24 hours to
tell a climb from a step:

```sh
aws cloudwatch get-metric-statistics \
  --namespace AWS/ECS --metric-name MemoryUtilization \
  --dimensions Name=ServiceName,Value=bifrost Name=ClusterName,Value=bifrost \
  --start-time "$(date -u -d '-24 hours' +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 900 --statistics Maximum --region us-west-2
```

A steady climb is a leak: restarting the task reclaims the memory and buys time,
but the fix is in Bifrost, and a restart is a short outage
(`DEPLOYMENT_MINIMUM_HEALTHY_PERCENT` is 0, so a deploy stops the task before it
starts the replacement). A step that holds is a cache that grew and is not
shrinking; that is worth watching, not necessarily worth acting on. Raising
`TASK_MEMORY` hides either. **Do not** — find out which one it is first.

### 3. ALB-generated 5XX: the shape every outage here has had

This is the alarm that catches the failure where the application logs nothing.
`HTTPCode_ELB_5XX_Count` counts responses the **load balancer** generated —
it gave up on the task — while `HTTPCode_Target_5XX_Count` stays at zero
because Bifrost never returned an error. Thirty in five minutes is above every
routine deploy's stop-before-start gap, so unless a deploy is in flight this is
real.

Check, in this order:

1. **Was a deploy or task replacement in flight?** `gh run list --workflow=deploy-workbench.yml --limit 5`.
   A deploy's 503 gap is by design and lands well under 30.
2. **Was the task pinned?** The CPU alarm above answers this directly; if
   `CPUUtilization` reached 100% in the same five minutes, this is step 1's
   problem and the 5XX is its symptom.
3. **Was the task running?** If `bifrost-gateway-no-running-task` fired too, go
   to step 4 — the 5XX is that outage.
4. **Was the database the reason?** If either `bifrost-db-*` alarm fired, go to
   step 5. That is the branch the 2026-11-23 outage needed and this runbook did
   not have: the task had CPU and memory to spare and was returning 503s
   anyway, because it was waiting on Postgres. If the burst is more than a
   couple of minutes long and neither database alarm is firing, it is still
   worth a glance at step 5's queue depth before the logs — this database's
   queue moved before any alarm was watching it.
5. Otherwise the container's log group around the burst:
   `aws logs tail /aws/ecs/bifrost --since 30m --region us-west-2`.

A `504` instead of `503` means the task accepted the connection and did not
answer in time, which is saturation rather than absence. `HTTPCode_ELB_504_Count`
is zero across this gateway's whole history, so seeing one is new information
and worth saying so in the incident.

### 4. No running task

Twenty minutes with no task, or no `RunningTaskCount` datapoint at all. Both
mean the same thing: nothing is registered behind the load balancer and every
caller is getting a 503. The window is more than twice the longest deploy gap
measured over 47 deploys — one or two five-minute buckets, 8 minutes continuous
at one-minute resolution — so a normal merge cannot have caused it.

```sh
aws ecs describe-services --cluster bifrost --services bifrost --region us-west-2 \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,events:events[0:10]}'
```

Read `events[]`. The deployment circuit breaker rolls back a revision that
cannot become healthy, so a service stuck here is usually a task that starts and
then dies — the events name the stopped reason, and the container's log group
has the last words before it went. The one case with no events at all is a
service that was scaled to zero by hand, which the deploy pipeline will not have
done: check `git log` on `deploy-workbench/ecs.ts` before assuming a bug.

A three-hour version of this happened on 2026-10-26 and nothing paged; that
outage is why this alarm exists.

### 5. The database: the task is up and has capacity, and is waiting on Postgres

This is the branch the 2026-11-23 outage needed and this runbook did not have.
That day the load balancer started returning 5XX at 11:05, the task never lost
`RunningTaskCount`, its CPU averaged 5% of the task over the outage and its
memory maxed at 16%, and the gateway was not serving again until the instance
was resized in the console at 12:42. The thing that was wrong was underneath
the task, and the only way anyone found it was by reading CloudWatch by hand the
next day.

**Which metric, and what each one means.** All three are `AWS/RDS`, all three
carry one dimension, and the value is the instance identifier from
`deploy-workbench/rds.ts`:

```
DBInstanceIdentifier=bifrost-db
```

| Metric | What it is | Routine here | What a bad value means |
|---|---|---|---|
| `FreeableMemory` | bytes of RAM the instance can hand out | 52-110 MiB over the 13 days before the incident, on the 1 GiB class it ran on; 4.5-4.6 GiB free in the hour measured since the 8 GiB class came up | the instance has nothing left to cache with, so reads go to storage and queue there |
| `DiskQueueDepth` | requests waiting on the volume | p99 0.06, max 0.198 over 32 days | the device is behind, whatever its provisioned IOPS say |
| `WriteLatency` | seconds per write, as the instance sees them | ~2 ms median | writes are slow for the same reason the queue is deep |

**A high `DiskQueueDepth` with low `WriteIOPS` is not an IOPS ceiling; it is a
stalled device.** That is the distinction this step exists to make, and the one
the incident was first described without. On 2026-11-23 the queue reached
8.37 while `WriteIOPS` peaked at 61 and `ReadIOPS` at 224 against a 3,000-IOPS
gp3 baseline — 2% and 7% of what the volume was provisioned for, and no higher
than their own routine peaks, with the volume delivering less per request than it
normally does. A volume at its IOPS ceiling shows the IOPS *at* the baseline with
the queue growing behind it; a couple of dozen writes a second with eight queued
behind them means the device is taking hundreds of milliseconds per request, not
that there are too many requests. If you see a deep queue **and** IOPS near
3,000, that is a real ceiling and the answer is provisioned IOPS, which is an
open decision (`docs/bifrost-gateway.md`, the "RDS size and Multi-AZ" question).
A deep queue with IOPS far below the baseline is this instance's storage not
keeping up, which is what the class change was a stopgap for.

Read the seven together, over an hour, and the shape tells you which:

```sh
for m in DiskQueueDepth WriteLatency WriteIOPS ReadIOPS FreeableMemory \
         EBSByteBalance% EBSIOBalance%; do
  echo "== $m"
  aws cloudwatch get-metric-statistics \
    --namespace AWS/RDS --metric-name "$m" \
    --dimensions Name=DBInstanceIdentifier,Value=bifrost-db \
    --start-time "$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --period 300 --statistics Minimum Average Maximum --region us-west-2 \
    --query 'Datapoints[].[Timestamp,Minimum,Average,Maximum]' --output text
done
```

**`EBSByteBalance%` and `EBSIOBalance%` are the ones to read if the queue is
deep.** On 2026-11-23 the byte balance had been draining since about 08:30
(57%), reached 0% at 11:15 and stayed at 0 for the next seventy minutes, while
the IO balance fell from 99% to 73% and held in the low seventies. Both are
burst credits of the **instance** (not the volume — gp3 does not burst), and
byte balance at zero means the instance has no throughput headroom left: that
is the storage stall stated directly, and it is the one graph that would have
made the cause obvious in the first ten minutes. Be aware that this metric also
drains and refills on quiet days as part of ordinary use; the signal is it
sitting at or near zero *while the queue is deep*, not the drain alone.

What to do, in order:

1. **Is a task restart or a migration in flight?** Bifrost runs store migrations
   at boot, and a migration against a small instance looks exactly like this.
   `aws ecs describe-services --cluster bifrost --services bifrost --region us-west-2`
   and the `/aws/ecs/bifrost` log group around the first slow bucket.
2. **Is storage full?** `FreeStorageSpace` under a gigabyte is a different
   incident and the fix is retention, not the class.
3. **Is the memory alarm the one that fired?** `FreeableMemory` at 5% means the
   instance has no page cache; the queue follows from that. Find what is holding
   it — a long-running transaction, a migration, idle connections — before
   touching the instance class. Raising the class buys time and hides the cause,
   and it has already been raised once (#575).
4. **If nothing is holding it, the instance is undersized for the workload.**
   That is a PR against `deploy-workbench/rds.ts`, not a console change: the
   class is Pulumi's, and a console resize is reverted by the next apply unless
   the file agrees with it (that is what #575 was for). Provisioned IOPS and
   throughput and Multi-AZ are open decisions in
   [`bifrost-gateway.md`](./bifrost-gateway.md), not things to change during an
   incident.
5. **Restarting the task does not fix a database problem** and costs an outage
   of its own (`DEPLOYMENT_MINIMUM_HEALTHY_PERCENT` is 0), so do not reach for
   the deploy as the first move here. It changes nothing about the instance.

**Escalation.** Reading these metrics needs no grant beyond what a
`WorkbenchAccess` session has (`cloudwatch:GetMetricStatistics` on `AWS/RDS`
worked for the post-incident measurements in this document). Acting on them is
where it changes: anything that writes to the instance — a parameter group, a
class change applied from the console to stop the bleeding, deleting a runaway
session — needs `/breakglass` and an approval in `#sensitive-access-requests`
([`sheriff.md`](./sheriff.md)). `rds:DescribeDBInstances` is **not** in
`WorkbenchAccess`, so `aws rds describe-db-instances --db-instance-identifier
bifrost-db` fails without an admin session; the console's RDS page needs the
same. Everything this step asks you to read is in CloudWatch and needs neither.

If the queue is deep and none of those five answers explain it, this is a
database performance investigation rather than gateway triage: it belongs in
`docs/bifrost-gateway.md`'s "RDS size and Multi-AZ" question with the window and
the numbers, because the next step is a sizing decision rather than a fix.

A `503` burst with a healthy task and a healthy database is not this step — go
back to step 3 and read the task's own logs.

**Status:** not rehearsed. Written from the 2026-11-23 outage's own CloudWatch
record, with the alarm and the two new metrics chosen from it; the commands
above were run against the account on 2026-11-23 and returned the datapoints
quoted here, but nothing has yet been triaged by following this step during a
real firing.

---

## The Bifrost usage export is failing or has stopped running

**Alarms:** `bifrost-usage-export-failed` and `bifrost-usage-export-never-ran`
(`deploy-workbench/usage-export.ts`).
**Metrics:** `AWS/Lambda` `Errors` (one five-minute period, threshold 1) and
`Invocations` (one **one-day** period, `LessThanThreshold` 1, missing data
treated as breaching). Both publish to the `bifrost-usage-export-alerts` topic,
subscribed to `aws-workbench@goodparty.org`.

**What it means.** The export Lambda reads the gateway's `logs` table and writes
one Parquet object per run for the finance mart. `-failed` means a run started
and threw; `-never-ran` means a day passed with no invocation at all, which is a
different failure: a disabled or deleted rule, a schedule expression that
stopped matching, or a function removed by a bad apply.

**The two are separate on purpose.** `Errors` publishes nothing when a function
is never invoked, so `-failed` is structurally blind to a dead job. Do not
"simplify" the pair into one alarm.

### 1. Which alarm, and when

- **`-never-ran` fires up to a day late.** One day is the alarm's period, so it
  cannot evaluate a day until that day closes. A missed 09:00 run is noticed at
  the earliest the following night. That lag is accepted; if it ever needs to be
  tighter, the answer is a heartbeat metric, not a shorter period.
- **Expect one `-never-ran` page on the day this stack is first applied.** The
  function exists from the apply, nothing invokes it until the 09:00 rule fires,
  and `treatMissingData: breaching` reads that first empty day as a failure. It
  is a false page with a known cause, and it clears itself after the first run.
  Do not "fix" it with `notBreaching`, which would blind the alarm to a deleted
  function for good; if it becomes annoying, the fix is to acknowledge it once
  or to have the deploy invoke the export after the bootstrap provisions.
- **`-never-ran` does not mean the monthly run is due.** The daily rule is
  expected every day. The 90-day run on the 1st is additional.
- **A missed monthly run is not alarmed on its own, and that is an accepted
  gap.** Both
  alarms are per function, so a day whose daily run succeeded looks healthy even
  if the 09:30 monthly run never fired. A monthly run that *threw* raises
  `-failed`, so the uncovered case is a monthly rule that stopped firing while
  the daily one kept working. If you are debugging "the 90-day window has not run
  since a certain date", check the rule before the code:

  ```sh
  aws events list-rules --region us-west-2 \
    --query "Rules[?Name=='bifrost-usage-export-monthly'].{name:Name,schedule:ScheduleExpression,state:State}"
  ```

```sh
aws cloudwatch describe-alarms --region us-west-2 \
  --alarm-name-prefix bifrost-usage-export \
  --query 'MetricAlarms[].{name:AlarmName,state:StateValue,reason:StateReason}'

aws events list-rules --region us-west-2 \
  --query "Rules[?starts_with(Name,'bifrost-usage-export')].{name:Name,schedule:ScheduleExpression,state:State}"
```

A rule whose `state` is `DISABLED` explains `-never-ran` completely.

### 2. The run itself

```sh
aws logs tail /aws/lambda/bifrost-usage-export --since 2d --region us-west-2
```

A successful run logs one line: the window, the row count, the byte count and
the object key. **It never logs a row**, so an absence of per-person data in that
log group is correct and not a sign of truncation.

The failures worth recognising:

- **`not a timestamptz` / `not a decimal`** — a column type changed under the
  export. The value is in the message; the fix is on this side, in
  `deploy-workbench/bifrost/usage-export-core.ts`.
- **`secret ... has no non-empty password`** — the bootstrap has not run, or its
  secret was cleared. See section 4.
- **`AccessDenied` on `s3:PutObject`** — the function's role or the bucket policy
  was edited. The policy admits a role in the **management** account by
  `aws:PrincipalArn`; a role in this account is the wrong one.
- **`password authentication failed for user "bifrost_usage_export"`** — the
  secret and the database disagree. Usually a rotated secret with no matching
  `ALTER ROLE`; see section 4.

### 3. Did anything land?

```sh
aws s3api list-objects-v2 --bucket goodparty-workbench-bifrost-usage \
  --prefix bifrost/logs/ --region us-west-2 \
  --query 'reverse(sort_by(Contents,&LastModified))[0:5].{key:Key,size:Size,when:LastModified}'
```

One object per run, named for the run instant, none overwritten. A gap is a
missed run; a zero-byte object would be a bug, because an empty window writes a
valid empty Parquet file rather than nothing.

### 4. Rotation, and the bootstrap

The export's password lives in `bifrost/usage-export`, written by the bootstrap
Lambda. The deploy invokes that function after every apply and it **no-ops** once
the secret holds a password, so a deploy cannot rotate a working credential.

To rotate deliberately:

1. If the bootstrap's resource has already been removed, restore it (`git revert`
   the PR that removed it) and run `Deploy workbench` once. The secret still holds
   a password, so this provisions nothing.
2. Clear the password, keeping the container: `aws secretsmanager put-secret-value
   --secret-id bifrost/usage-export --secret-string '{}' --region us-west-2`.
   This needs Secrets Manager write in this account, which is `/breakglass` plus an
   approval in `#sensitive-access-requests`.
3. Run `Deploy workbench`. The step sees no password, generates one, alters the
   role and writes it.
4. Confirm the next scheduled run succeeds, then remove the bootstrap again with
   the same PR that removed it the first time.

Do not force-delete the secret: Pulumi owns the container, and a missing one makes
the next refresh recreate it empty.

**Status:** not rehearsed. Written with the alarms; the commands were checked
against the account but have not been run against a real firing.
