# Bifrost metrics into Grafana Cloud

> This document is the plan for scraping the Bifrost gateway's Prometheus
> endpoint into Grafana Cloud, so the fleet's token and cost usage can be
> charted per engineer and per model without a query path into the gateway's
> database. It extends [`bifrost-gateway.md`](./bifrost-gateway.md) (the
> gateway), [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md) (the
> per-person key) and [`bifrost-reconciler.md`](./bifrost-reconciler.md) (how a
> change reaches a running task). It changes no infrastructure. A PR that
> implements a step names this document and the step in its body; progress is
> derived from those PRs and is not written here (decision 11 of
> [`plan-gated-merges.md`](./plan-gated-merges.md)):
>
> ```
> Plan: docs/bifrost-metrics.md
> Step: 1
> ```

**This plan is the enabling infrastructure and stops there.** It gets Bifrost's
counters into Grafana Cloud, proves they arrived, and leaves a working data
path. It does **not** define a dashboard: no panel, no chart layout, no
dashboard JSON. The visualisation is a follow-on change that builds on a
verified pipeline, and it belongs with the Grafana provisioning that already
exists rather than being invented here.

> **The Grafana half is not new.** There is a pre-existing Grafana plan and a
> working implementation in `thegoodparty/omni`: `components/grafana.ts`
> provisions datasources, folders, dashboards, alert rules and contact points
> through `@pulumiverse/grafana`, against the `goodparty` stack (id
> `1532096`). This plan reuses it rather than building a parallel path. See
> "The existing Grafana provisioning" below for what it gives us, what
> credentials it needs, and which of its pieces this work has to touch.

Phase 3 of `bifrost-gateway.md` has carried an unwritten item 15 since the
gateway was designed: *"Wire `/metrics` into CloudWatch (agent scrape) or the
chosen metrics path."* It also explains why that is not free. `/metrics` has no
ALB rule (`deploy-workbench/ingress.ts:145-153`) because the credential that
used to front it no longer exists, and the default listener action sends it to
`oauth2-proxy`, which a machine cannot pass. The note's conclusion is that the
scraper has to read the endpoint from inside the network. This plan is the
"chosen metrics path" that note left open, and it is the first thing to want the
endpoint, so it builds it.

## Objective and success criteria

Get per-engineer, per-model token and cost usage off the gateway and into the
Grafana stack the org already runs, without giving anything outside the VPC a
query path into the gateway's Postgres instance.

Success, in the order it should be proven:

1. **The endpoint is readable from inside the network.** A request to
   `http://bifrost.workbench.local:8080/metrics` from a container in the private
   subnets returns the Prometheus exposition text, with no credential. If it
   does not, this plan is wrong and step 1 stops it before anything is built.
2. **The series carry the dimensions.** `bifrost_input_tokens_total`,
   `bifrost_output_tokens_total` and `bifrost_cost_total` arrive in Grafana
   Cloud carrying `virtual_key_name` and `model` labels, so
   `sum by (virtual_key_name, model) (increase(bifrost_input_tokens_total[24h]))`
   is non-empty and its parts sum to the ungrouped total.
3. **No credential reaches the database.** Nothing in the scrape path holds
   Postgres credentials, and no wire carries anything but counter text. The
   endpoint's payload has no prompt or completion content in it by construction,
   not by a filter.
4. **The gateway's own reservation is unchanged.** The scraper runs in its own
   task with its own memory, and `BIFROST_CONTAINER_MEMORY` does not move. The
   arithmetic in `deploy-workbench/ecs.test.ts` (676 MiB peak plus two 71 MiB
   password-command forks inside 896 MiB) still holds untouched.
5. **A restart costs one sample, and it is visible.** `increase()` across a task
   replacement loses at most one scrape interval, and an unmatched counter reset
   is observable rather than silent.
6. **The data is reachable from the existing Grafana stack.** The counters are
   queryable in Explore against the `grafanacloud-prom` datasource on the
   `goodparty` stack, which is where the pre-existing provisioning already
   reads from, so a follow-on dashboard is a resource in
   `components/grafana.ts` and not a new integration.

Explicitly out of scope, and both are deliberate:

- **The dashboard.** No panel, no chart, no dashboard JSON. This plan ends at a
  verified data path; the visualisation is the next change, built on top of it.
  Success criterion 6 is the seam: it proves the follow-on has somewhere to
  land.
- **The Slack delivery.** Whether that is a Grafana alert rule, a scheduled
  report, or something in `gp-pi` is a delivery decision this plan does not
  make and does not depend on.

## Why scrape, and not the two alternatives

The gateway already records everything the usage question needs. `logs_store`
is on and points at the workbench RDS instance
(`deploy-workbench/bifrost/config.json:24-42`), and the `logs` table has
`model`, `prompt_tokens`, `completion_tokens`, `cost`, `virtual_key_id` and
`virtual_key_name` per request (`framework/logstore/tables.go:310-466` at the
pinned `transports/v2.4.0`). So the question is only how to read it. Three ways
were weighed.

**Read the Postgres directly, through Grafana's Private Data Source Connect.**
PDC is the documented answer for a private data source and it is on every
Grafana Cloud plan including the free tier. It is rejected here. It puts a
standing database credential in a third-party system, into an instance whose
`logs` table also carries a `content_summary` column
(`tables.go:414`) that is empty only because `disable_content_logging` is on
(`config.json:45`). That makes the column allowlist a security control enforced
by a system we do not operate, and the mitigation is a read-only role plus a
view plus the discipline to keep them in step with Bifrost's migrations. This
plan trades a small amount of fidelity for removing that whole class of
problem.

**Render the chart from the admin API and post it.** A job beside the janitor
Lambda already has the VPC attachment, the setup token and a schedule
(`deploy-workbench/bifrost-vk-janitor.ts:411-470`,
`bifrost/vk-janitor-contract.ts:83-89`), and `/api/logs/rankings/by-dimension`
answers the per-key question. That is the cheapest thing that ships a chart,
and it stays the fallback if this plan stalls. It is rejected as the primary
because it produces a picture and not a data path: there is no history beyond
Bifrost's 90-day purge, no interactive dashboard, and every new question means a
new code change. It also reads the database, which is the thing the previous
paragraph just argued against.

**Scrape `/metrics` into Mimir.** This is the plan. The endpoint already exists
and is already populated, the labels are already the chart, and the scraper
holds no credential that can read data, only one that can write metrics.

The deciding fact is that the telemetry plugin is **default-on**. It is
registered first and unconditionally in `loadBuiltinPlugins`
(`transports/bifrost-http/server/plugins.go:236-253`): *"Default-on: absent
PluginConfig entry is treated as enabled... Only an explicit `Enabled=false`
disables it."* `config.json` has no `plugins` block at all, so nothing has
disabled it, and `metricsEnabled` defaults to true
(`plugins/telemetry/main.go:779`). The counters are being recorded right now;
nothing reads them.

## The existing Grafana provisioning

The Grafana half of this does not need designing. `thegoodparty/omni` already
provisions the `goodparty` Grafana Cloud stack declaratively, in
`packages/gp-api/deploy/components/grafana.ts`, through `@pulumiverse/grafana`
(`^2.20.0`). What that gives this plan:

| Piece | Where | What this work uses it for |
| --- | --- | --- |
| Pulumi Grafana provider | `grafana:url = https://goodparty.grafana.net`, `grafana:stackId = 1532096` (`infra-cli.ts:202-211`) | The same stack, so the metrics instance is already addressable |
| Auth | `GRAFANA_AUTH`, an SSM parameter `grafana-shared-service-account-token`, fetched per run (`infra-cli.ts:93,169`) | Read-only use for verification; not needed by the scraper |
| Prometheus datasource | uid `grafanacloud-prom` (`grafana.ts:42`) | Where the counters appear |
| Folders and dashboards | `grafana.oss.Folder` / `grafana.oss.Dashboard`, e.g. `grafana.ts:377-390` | Where the follow-on dashboard goes |
| Contact points and alert routing | `grafana.ts`, `components/alerting/` | Where a Slack delivery would go later |

So the config to plumb is smaller than the first draft of this plan assumed, and
the credentials split cleanly into two sides:

**Write side, in AWS (this plan's step 4).** The scraper needs one thing Grafana
owner: a Cloud Access Policy token scoped to `metrics:write` on the workbench's
metrics instance. That is a *push* credential, unrelated to the
`GRAFANA_AUTH` service-account token above, which is a *read and admin*
credential for the stack. Keeping them separate matters: the scraper must not
hold a token that can edit dashboards or read other instances.

**Read side, already in place.** Querying the data, and later adding a
dashboard, uses the existing `GRAFANA_AUTH` service account from `omni`'s
deploy path. Nothing new is required, and no dashboard resource should be added
to `ops` at all: the provisioning lives in `omni`, next to the app whose metrics
sit beside these.

One thing this plan does *not* change: `omni`'s Grafana provider is scoped to
the `gp-api` Pulumi stack, and `ops` has no Grafana provider. This plan
deliberately adds none. The scrape is infrastructure and belongs in `ops`; the
dashboards belong in the stack that already owns them.

## What the endpoint carries

The labels are the reason this works, and they are worth stating exactly. At the
pinned tag, `virtual_key_name` and `model` are both `TierMetric`, the tier the
registry defines as *"bounded, safe as labels on any backend"*
(`core/schemas/enrichment.go:52-62`). Every token and cost counter is built
with `bifrostLabels()`, which includes them
(`plugins/telemetry/main.go:542,550,600`).

| Counter | Labels that matter | Source |
| --- | --- | --- |
| `bifrost_input_tokens_total` | `virtual_key_name`, `model`, `provider` | `telemetry/main.go:539`, labels at `:542` |
| `bifrost_output_tokens_total` | same | `:547`, labels at `:550` |
| `bifrost_cost_total` | same | `:597`, labels at `:600` |
| `bifrost_cache_read_input_tokens_total` | same | `:565`, labels at `:568` |

`virtual_key_name` is the person's lowercase email, because that is what the
mint sets as the key's name (`deploy-workbench/bifrost/vk-mint-core.ts:205`,
`:408`). So per-engineer attribution needs no join table and no second
identity system. This is the property `bifrost-gateway.md` relies on when it
says "who spent what" does not need Enterprise.

Two consequences worth knowing before a chart is drawn, both of which will look
like bugs otherwise:

- **`model` splits one Fireworks model into three.** `gp-pi` sends the role
  names `worker-default` and `coordinator-default` alongside the catalog name,
  and all three resolve to one DeepSeek wire id
  (`deploy-workbench/bifrost/config.json`, the `fireworks` alias block). Unlike
  the SQL path there is no `canonical_model_name` label to fall back on, so a
  grouping on `model` shows three slices of the same model. Group on `provider`
  for an honest Fireworks-versus-Bedrock split, or collapse the role names with
  `label_replace` in the query. This is a decision for the dashboard change.
- **`cost` is the gateway's estimate, not the bill.** Item 16 of
  `bifrost-gateway.md` (reconcile against a week of provider billing, add
  pricing overrides) is still open, and the expected first disagreement is the
  Fireworks US-only premium. The panel should say so, when there is one.

## Shape

One ECS service in the workbench account, in the same private subnets the
gateway runs in, running Grafana Alloy. It scrapes the gateway over Cloud Map,
does one relabeling pass, and remote-writes to Grafana Cloud's Prometheus
endpoint. Nothing reads the database and nothing is exposed to the internet.

```
                       private subnets, workbench account
  +----------------+        :8080        +--------------------+
  | bifrost task   | <------------------ | alloy task         |
  | /metrics       |   Cloud Map DNS     | prometheus.scrape  |
  +----------------+                     | relabel (allowlist)|
                                         | remote_write (WAL) |
                                         +---------+----------+
                                                   | 443 out via NAT
                                                   v
                                         Grafana Cloud / Mimir
```

**Why a separate task and not a sidecar in the gateway's task.** A sidecar is
the cheaper shape on paper: it shares the task's network namespace, reads
`127.0.0.1:8080`, and needs no new security-group rule. It is rejected for three
reasons, in order of weight.

1. **Its WAL dies with the task.** Alloy buffers scraped samples in a
   write-ahead log before remote-writing them. In a sidecar that log is on the
   task's ephemeral storage, which is destroyed with the task, and a task is
   replaced on every deploy. The buffer that exists to survive a transient
   failure would itself be lost at exactly the moment it is useful.
2. **It competes with Bifrost's reservation.** The gateway's container is at
   896 MiB of a 1024 MiB task, and the arithmetic behind that number is
   measured, not assumed: 676 MiB peak plus two concurrent 71 MiB
   `aws-cli` forks is 818 MiB, leaving 78 MiB
   (`deploy-workbench/ecs.test.ts:2006-2068`). A third container means both a
   memory and a CPU reservation, because the two existing ones already sum to
   the task's 448 + 64 = 512 CPU (`ecs.ts:253-259`), and taking either from
   Bifrost moves a number that was sized deliberately.
3. **Lifecycle coupling.** Restarting the scraper to change a relabel rule
   would restart the gateway. That is backwards: the scraper exists to observe
   the gateway, and it should not be able to interrupt it.

The cost of the separate task is a third exception to "8080 from the ALB only".
That invariant has two named exceptions already, both from Lambda security
groups (`bifrost-vk-mint.ts`, `bifrost-vk-janitor.ts:426-441`), and the plan
below makes this the third in the same shape: a rule on `bifrost-task` whose
source is the scraper's own group, so it admits that task and nothing else in
the VPC.

**This contradicts a note already in the repo, and the contradiction is the
decision.** `ingress.ts:149-152` says nothing scrapes `/metrics` yet and that
"the future scraper has to read it over loopback from a sidecar instead of over
the ALB". The second half is a fact: over the ALB is impossible without a
credential a machine cannot hold, and this plan agrees. "From a sidecar" was a
shape assumed while writing a comment about why a route was being removed, not a
measured preference, and it was chosen before anyone had a reason to weigh the
WAL and the reservation. Reading it over loopback *from a sidecar in the same
task* is exactly the option rejected above. The loopback reading is still
available to a separate task when it happens to land on the same host, and is
not relied on: one gateway task means at most one same-host scraper, so the
Cloud Map round trip is what the design is built on. This plan and the comment
are inconsistent until a later PR amends that comment to point here.

**Why Alloy and not Prometheus.** Alloy is the current agent; `prometheus` with
a `remote_write` block would also work. Alloy's config is a component graph in
one file, it has the relabeling and the WAL built in, and it is what Grafana
Cloud's own onboarding generates. It also leaves the door open to a
`loki.source.journal` or an OTLP receiver later without a second agent.

## Undercounting, stated exactly

This is the honest part, and it is a design constraint rather than a footnote.
Three ways data can be lost, and what each costs.

**Counter reset on task replacement.** The gateway's counters are in-process
and start at zero. Every deploy replaces the task (stop-before-start, per
`bifrost-reconciler.md`), so every deploy resets them. PromQL's `increase()` is
reset-aware: it sees the drop, treats it as a reset, and credits the pre-reset
cumulative plus the post-reset value. What it cannot recover is the increment
between the last successful scrape and process death. **At most one scrape
interval, per restart, and it does not accumulate.**

At a 15-second interval that is 5,760 scrapes a day, so two deploys a day loses
two of them. If the fleet burns 50M tokens a day, one deploy is about 8,700
tokens, roughly 0.017%, and it is invisible on a chart whose y-axis is millions.
This is why step 6 sets `scrape_interval = "15s"` rather than leaving the
60-second default: it is a free factor-of-four on the one error the design
cannot remove.

**Draining cannot fix it.** The obvious mitigation, letting the scraper do a
final read before the process dies, does not work, and the reason is in the
shutdown path rather than in Alloy. fasthttp's `Shutdown` closes the listeners
first and then waits for connections to return to idle, so from the moment
shutdown begins the endpoint is refused its next scrape. And ECS sends SIGTERM
to every container in a task at once, with no ordering between them, so a
sidecar could not be sequenced ahead of the gateway even if the listener stayed
open. The 120-second stop timeout (`ecs.ts:285`) is a budget for in-flight
model requests and the governance budget dump, not a scrape window.

**The push gateway is worse.** The gateway can push to a `push_gateway_url` and
does a final push on shutdown (`plugins/telemetry/main.go:1739-1764`), which
looks like the exact answer. It is not: a pushgateway holds only the last value
per group, so `rate()` and `increase()` over it are meaningless, and Prometheus
documents it as unsuitable for counters. It would make the final sample exact
and destroy the ability to use it.

**A gap is different from a reset, and is the case to alarm on.** If the
scraper is down, or Grafana Cloud refuses writes, `increase()` cannot invent
the missing window. That is a hole rather than a rounding error. Two rules
cover it: `up{job="bifrost"} == 0` for more than a few minutes, and an
unexplained change in the counter reset count (which is also how an unexpected
gateway restart becomes visible).

**What this means for the number.** Mimir is a sampled aggregate with a bounded
error; the `logs` table is an exact per-request ledger with a 90-day life. For
"who used what during the rollover" the difference is not visible. For a figure
that must match an invoice, the answer is the database while it is inside 90
days, and this plan does not change that. It is worth writing that sentence
next to the retention note in `bifrost-gateway.md` so the trade is on the record
rather than rediscovered at a finance review.

## Card

The scraper's footprint is small and fixed, which is what makes the separate
task cheap.

| | Value | Why |
| --- | --- | --- |
| CPU | 256 units | Alloy relabeling a few thousand series is idle work |
| Memory | 512 MiB | WAL and the scrape buffer; the WAL is bounded by `truncate_frequency` |
| Task definition | 256 / 512 | Fargate's smallest pair at that CPU |
| Scrape interval | 15s | The undercount argument above |
| Retention (Grafana) | 14 days free, 13 months on Pro | See step 2 |

The rule that matters for cost is the allowlist, and it is a **named list, not a
`bifrost_*` glob** (seed step 3). The endpoint carries 32 metrics, 28 `bifrost_*`
and 4 `http_*`, and the ones dangerous to cardinality are not the `http_*`
family the first draft of this plan singled out. They are the **histograms**,
because a histogram's series count is its label sets multiplied by its buckets,
and six of the eight Bifrost histograms carry the full `bifrostLabels()` set,
which includes `virtual_key_name` and `model`:

| Metric | Buckets | Series per label set |
| --- | --- | --- |
| `bifrost_upstream_latency_seconds` | 22 (`telemetry/main.go:266-269`) | 24 (22 + `_sum` + `_count`) |
| `bifrost_overhead_latency_microseconds` | 18 (`:277-280`) | 20 |
| `bifrost_stream_first_token_latency_seconds` | multi | 20+ |
| `bifrost_stream_inter_token_latency_seconds` | multi | 20+ |
| `http_request_duration_seconds`, `http_request_size_bytes`, `http_response_size_bytes` | 8 each | 10 each, labelled by `path` |
| `bifrost_overhead_component_microseconds`, `bifrost_a2a_client_operation_duration_seconds`, `bifrost_mcp_client_operation_duration_seconds`, `bifrost_relay_operation_duration_seconds` | multi | 20+ each |

At a plausible 100 label sets on this fleet (10 keys x 9 models, times the
`provider` / `status_code` splits), the four latency histograms alone are around
2,800 series, against about 400 for the 17 counters. A blanket `bifrost_*` rule
fits inside the free tier and then quietly triples the bill on Pro, and it does
so for metrics this plan does not chart.

So the allowlist is the counters, named one by one, and it is written out.
Anything a later use case wants is an added line with its own cardinality
argument.

### What is not forwarded

Stated as a list, because "does this ship all the telemetry" has an answer that
is easy to get wrong in either direction.

**Forwarded**: all seventeen `bifrost_*` counters, with `virtual_key_name`,
`model`, `provider` and the rest of the bounded label set. A counter costs one
series per label set, so the whole family is the cheap half of the endpoint.
Between them they carry input and output tokens, cost, cache reads and writes,
upstream and success request counts, error counts, retries, and the
routing-overhead counters.

**Not forwarded**, and each for a reason:

- **Every histogram.** `bifrost_upstream_latency_seconds`,
  `bifrost_overhead_latency_microseconds`,
  `bifrost_overhead_component_microseconds`,
  `bifrost_stream_first_token_latency_seconds`,
  `bifrost_stream_inter_token_latency_seconds`,
  `bifrost_a2a_client_operation_duration_seconds`,
  `bifrost_mcp_client_operation_duration_seconds`,
  `bifrost_relay_operation_duration_seconds`. Cardinality, per the table above.
  These are for latency work rather than the usage chart, and adding one later
  is a line in the allowlist with its own argument.
- **The whole `http_*` family.** Labelled by `path`, the one label here that is
  unbounded in principle, and useless for this chart.
- **Gauges**: `bifrost_active_requests`, `bifrost_provider_key_up`, and
  `bifrost_request_retries` where it is a gauge. Cheap, but nothing charts them
  yet, so they are the easiest thing to add later.
- **Everything Bifrost records but does not expose as a metric.** This is the
  omission that matters, and it is why this plan is a data path rather than a
  chart. The per-request record in the `logs` table (per-request
  latency, `stop_reason`, `selected_key_name`, `user_agent`, `app`, session id,
  `cache_debug`) is **not** on `/metrics`; only aggregates are. A question
  needing per-request detail is answered by the admin API or SQL inside the
  90-day retention, not by this pipeline.
- **Prompts, completions or any request content.** Not a policy on top of the
  endpoint: the endpoint does not carry them. That is the whole argument for
  scraping over PDC.

Two of these are decisions a reviewer could reasonably reverse, and the list is
written out so that is visible rather than presented as inevitable.

## Steps

Each step is a PR unless it says otherwise.

### Phase 1 — prove the endpoint (do this first, and cheaply)

1. **Confirm `/metrics` is readable and populated, from inside the VPC.** This
   is the gate: everything below assumes it, and nothing below is worth
   starting if it fails. The trace says it should work. The endpoint is
   registered on the bare router with the plain middleware chain
   (`transports/bifrost-http/server/server.go:3228`), while the OSS setup lock
   is appended to `apiMiddlewares` (`:3650`) and passed only to
   `RegisterAPIRoutes` (`:3698`), which gates paths under `/api/`
   (`transports/bifrost-http/handlers/middlewares.go:43`). `/metrics` is not
   under `/api/`. That is a reading of the source and not an execution of it,
   and the distinction is the whole reason this step is separate.

   The account has no bastion and no ECS Exec, so the read has to happen from
   inside: a one-off ECS task, or the bootstrap container's shell, or a
   temporary debug container in the gateway's task definition. What to capture
   in the PR body, as text and not a screenshot:

   - the first lines of the response, to show it is exposition text and not an
     HTML login page
   - `count(bifrost_input_tokens_total)` and the label names on one sample, to
     prove `virtual_key_name` and `model` are present and non-empty
   - the total number of series, which is the input to step 6's allowlist and
     to the metrics-instance decision

   If the endpoint is locked rather than open, stop and amend this plan: the
   design becomes "Alloy holds the setup token", which is a different security
   conversation and not a smaller one.

2. **Decide the metrics instance, with the series count in hand.** The org runs
   the `goodparty` stack; what is being chosen is a metrics instance on it, and
   the plan tier it sits under. Free is 10,000 active series with 14-day
   retention and 3 visualization users; Pro is a $19/month platform fee with
   13-month retention. Fourteen days cannot span a rollover window, so unless
   the answer is "we only care about this fortnight", this is Pro, and the
   reason is retention rather than series. Step 1's count turns this from an
   estimate into an arithmetic check; the Grafana user question is separate and
   is the one still open.

3. **Seed the allowlist from the measured series count.** The list of
   counters and the per-metric series counts go in this step's PR body, from
   step 1's capture. This is the cheap review that decides the bill: a reviewer
   sees the arithmetic and can disagree with it before there is an Alloy config
   to argue with. It also turns step 2's plan decision from an estimate into a
   number.

4. **The `bifrost/grafana-alloy` secret, filled out of band.** This is the
   credential plumbing, and it is the whole of what has to be handed to Grafana
   on the write side. Same shape as `bifrost/gateway` and
   `bifrost/oauth2-proxy`, the two containers `fill-secrets.sh` already manages:
   Pulumi owns the read grant and a committed script writes the value, so no
   token is in the repo and a `preview` never reads one. Extend
   `deploy-workbench/bifrost/fill-secrets.sh` rather than adding a fourth
   script, and add the keys to its header, its `--check` output and its
   `--force` behaviour.

   Three keys, and it is worth being exact about what each is for:

   - `GRAFANA_PROM_URL`: the metrics instance's `remote_write` endpoint. Not
     secret, but deployment-specific, and it belongs beside the token so the two
     cannot drift.
   - `GRAFANA_PROM_USERNAME`: the metrics instance ID, which is the basic-auth
     username. Identifies the instance; not secret on its own.
   - `GRAFANA_PROM_TOKEN`: a Cloud Access Policy token, scope `metrics:write` on
     that instance only. The actual secret.

   The scope is the security boundary. This token must not be the
   `grafana-shared-service-account-token` that `omni`'s deploy reads
   (`infra-cli.ts:169`): that one can administer the stack. A `metrics:write`
   token cannot read other instances, cannot query, cannot edit a dashboard, and
   is revoked in Grafana Cloud without an AWS change. It deserves the same
   treatment as the Brave secret, for the same reason.

   The read side needs nothing new. Verification in step 9 uses the service
   account that already exists.

### Phase 2 — scrape

5. **The Alloy image, pinned by digest.** A derived image is not needed if a
   committed config can be mounted, but it is the house pattern for exactly
   this problem and it gives a content-addressed tag:
   `deploy-workbench/alloy-image.ts` next to `bifrost-image.ts`,
   `pg-password-image.ts` and `oauth2-proxy-image.ts`, with the same shape (pin
   in one module, committed `alloy.Dockerfile`, tag hashed over the committed
   inputs, `deploy-workbench.yml` builds before it applies, a drift test that
   fails if any of them disagree). At the time of writing the upstream release
   is `v1.21.3`; pin the digest, not the tag, in the same PR that adds it.

6. **The committed Alloy config**, `deploy-workbench/alloy/config.alloy`, as
   data rather than a string in a task definition so it can be reviewed:

   - `prometheus.scrape "bifrost"` with `targets` of
     `bifrost.workbench.local:8080` (the Cloud Map name,
     `deploy-workbench/discovery.ts:56-66`), `metrics_path = "/metrics"`,
     `scrape_interval = "15s"`, and a `job` label of `bifrost`
   - `discovery.relabel` with an **explicit allowlist** of the 17 counters,
     not a `bifrost_*` glob, for the cardinality reason under "Card" above.
     `http_*` is absent from the list and so is every histogram. Seed step 3
     writes the list; step 1's series count confirms it.
   - `prometheus.remote_write "cloud"` to the endpoint from step 4, reading the
     instance ID and token from the environment
   - `logging { level = "warn" }`, so a busy scrape loop does not fill a log
     group

   The config file is the reviewable artifact; the task definition should read
   it rather than inline it, the same way `ecs.ts` reads `config.json` and
   injects it as `BIFROST_CONFIG`.

7. **The service.** An ECS service, its own task definition, a security group
   with egress 8080 to the task and 443 out through the NAT, and a new ingress
   rule on `bifrost-task` whose source is the scraper's group. That rule is the
   third exception to the ALB-only invariant: it must name the rule's reason in
   the same terms the other two do (`bifrost-vk-janitor.ts:426-441` is the
   shape), `ingress.test.ts` should pin it, and the `network.ts` comment that
   currently reads "from the ALB only" needs the amendment rather than a silent
   contradiction. A CloudWatch log group at 30 days, matching the gateway's.
   `desired_count: 1`; there is one gateway, so a second scraper would duplicate
   every sample.

   Nothing here touches the gateway's task definition. Success criterion 4 is
   the check: `BIFROST_CONTAINER_MEMORY` and the sum tests in `ecs.test.ts` are
   unchanged in the diff.

8. **Alarms, in the same PR as the service.** A metric-filter alarm on
   `up{job="bifrost"} == 0`, or an ECS service alarm on running-versus-desired,
   so a dead scraper is a page and not a quiet week. `bifrost-gateway.md` already
   notes that this account has no alerting target yet and that a
   metric-filter alarm is the follow-up that turns a failure into a page; this
   is the first thing in the deployment that would benefit from one.

### Phase 3 — prove the data path, and stop

9. **Prove the data before anything is built on it.** In Grafana Explore on the
   `grafanacloud-prom` datasource, three readings, recorded in the PR body:

   - `up{job="bifrost"}` is 1
   - `sum by (virtual_key_name) (increase(bifrost_input_tokens_total[1h]))` is
     non-empty, and the names are addresses rather than blank
   - the grouped total equals the ungrouped total, which is the check that the
     relabel allowlist has not dropped a series that the sum depends on

   If the `virtual_key_name` labels come back empty, stop: that is governance
   not stamping identity onto the request, which is a `config.json` or
   `enforce_auth_on_inference` question and not a scraping one.

10. **Reconcile once, against the database.** For one closed day, compare the
    per-key totals with `GET /api/logs/rankings?dimension=virtual_key` for the
    same window (or the equivalent SQL inside the 90-day retention). The
    expected result is agreement within a scrape interval plus whatever the
    matview refresh adds. A disagreement larger than that is a real finding and
    worth stopping for: it would mean the counters and the log store disagree
    about what a request is.

That is the end of this plan. A dashboard is the next change, and it is a
`grafana.oss.Dashboard` in `omni`'s `components/grafana.ts` rather than anything
in this repository; the two open questions it will have to answer are recorded
under "Deferred to the dashboard change" below so the follow-on does not
rediscover them.

## Security, stated plainly

- **The scrape path holds no data-read credential.** The Alloy task can read
  counters and write metrics. It cannot read the gateway's database, cannot read
  prompts, and does not hold the setup token. The endpoint it reads serves
  counter text and nothing else.
- **Content is structurally out of reach, not filtered.** There is no
  `content_summary` equivalent on `/metrics`; the payload is a counter
  exposition (see "What the endpoint carries"). This is the property that made
  scraping preferable to PDC, and it should not be traded away later for a
  richer dashboard.
- **The Grafana token is write-only and instance-scoped.** `metrics:write` on
  one metrics instance. It cannot read the stack, cannot query, and revoking it
  in Grafana Cloud stops the writes without an AWS change.
- **`/metrics` becomes reachable inside the VPC from one more principal.** The
  new ingress rule is group-referenced, so it admits the scraper's task and
  nothing else; it does not widen 8080 to the VPC CIDR, which would be the
  tempting shortcut and is not acceptable.
- **Per-developer figures are sensitive, and this plan makes them queryable.**
  It ships no dashboard, but it does put per-engineer token counts into the
  `goodparty` Grafana stack, where anyone with a Grafana user can query them in
  Explore. That is a real widening of exposure even without a panel: it is
  persistent, linkable, and browsable by everyone with access. Whoever owns the
  Grafana users should decide who that is before step 9 runs, and the
  dashboard change should carry the context that the number measures model
  choice and task mix as much as effort (a developer who legitimately fans out
  eight workers shows eight times the tokens). A team aggregate is the smaller
  disclosure and answers the rollover question on its own; per-developer is a
  second decision, not the default.

## What this plan does not claim

- **That costs are correct.** They are the gateway's catalog estimates, and
  item 16 of `bifrost-gateway.md` is the reconciliation that would make them
  trustworthy. They are fine for a trend and not for a budget.
- **That the history is long enough.** Grafana Cloud's retention is the bound
  now, not Bifrost's 90 days, and it starts at the first scrape. Anything before
  step 7 lands is not in Mimir and cannot be backfilled from it.
- **That `/metrics` is open.** Step 1 is the proof and it has not been run. It
  is deliberately the first step and deliberately its own PR.
- **That `http_*` or the latency histograms should stay unscraped forever.**
  Dropping them is a cost decision for this use case, and it is the decision
  most likely to be revisited. `bifrost_upstream_latency_seconds` is the obvious
  first candidate, at 24 series per label set; that is a line in the allowlist
  with its own cardinality argument, not a change of shape.

## Settled in review

1. **The scraper lives in `deploy-workbench/`.** Decided. It is the gateway's
   observability and shares its network and its Cloud Map name, so it belongs
   beside `ecs.ts` and `network.ts` rather than in `deploy-infrastructure/`.
   The Grafana *stack* being an org-wide service does not make this task one:
   the task only reads a workbench VPC address and pushes to an external
   endpoint. Step 7 is unambiguous on this.
2. **The dashboard is not part of this plan.** Decided. This is the enabling
   infrastructure only; the visualisation is a follow-on change in `omni`'s
   `components/grafana.ts`, where the Grafana provisioning already lives. The
   former "should the JSON be provisioned or applied by hand" question
   dissolves: it is a `grafana.oss.Dashboard` resource in a stack that exists.

## Open questions

1. **Who owns the Grafana users?** Free is 3 visualization users. If more than a
   handful of people should look at this, that is a Pro decision with a
   per-user price, and it is the same question as who may see per-developer
   figures. This survives review because it is a money and access question, not
   a technical one.

## Deferred to the dashboard change

Not this plan's decisions, recorded so the follow-on does not rediscover them:

- **How `model` is grouped.** `gp-pi` sends `worker-default` and
  `coordinator-default` alongside the catalog name and all three resolve to one
  DeepSeek wire id, so a naive `sum by (model)` shows three slices of one model.
  Either group on `provider` or `label_replace` the role names together.
- **Whether the panel says the cost line is an estimate.** It should, since
  item 16 of `bifrost-gateway.md` is the reconciliation and it is still open.
- **Whether per-developer figures are shown, or only a team aggregate.** A
  dashboard is more exposed than a posted chart: persistent, linkable, and
  browsable by everyone with Grafana access. The team aggregate is the smaller
  disclosure and answers the rollover question on its own.
