import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import { WORKBENCH_ALERT_EMAIL } from "./alert-email";
import {
  BIFROST_CLUSTER_NAME,
  BIFROST_SERVICE_NAME,
  TASK_CPU,
  TASK_MEMORY,
} from "./ecs";
import type { BifrostIngress } from "./ingress";

/**
 * The Bifrost gateway's capacity and availability alarms, and the one email
 * wire they share.
 *
 * ## Why these exist
 *
 * The gateway had capacity and availability incidents in the first fortnight of
 * its life that nothing alerted on: the only alarm in this account was
 * `bifrost-vk-janitor-not-converging`, which watches key reconciliation and
 * says nothing about whether the gateway is serving. `ecs.ts` recorded the gap
 * twice, as a deliberate follow-up ("the Logs Insights / metric-filter alarm
 * that would make it a page ... there is no alerting target in this account
 * yet"). This module is that alerting target and four alarms on it.
 *
 * Measured over 2026-10-22..2026-11-06, from CloudWatch:
 *
 * - `CPUUtilization` daily maxima reach the ceiling exactly: 100.31% at
 *   2026-11-03T16:07 local, 100.25% at 2026-11-06T08:47, 100.25% at
 *   2026-11-03T16:37, 99.57% at 2026-10-24T15:47.
 * - Those ceiling moments line up with ALB-generated 5XX bursts: 54 in the
 *   hour of 2026-11-03T16:00, 58 at 2026-11-04T16:00, 44 at 2026-11-06T08:45.
 * - `HTTPCode_Target_5XX_Count` is 0 over the same window. The application
 *   never returns an error. The failures are the load balancer giving up on a
 *   task that is briefly pinned, which is why no application-side signal saw
 *   them.
 *
 * Every alarm below is tuned against that measured window rather than against a
 * round number, and the comment on each names the numbers it was chosen from.
 *
 * ## The task size is imported, never restated
 *
 * `AWS/ECS` `CPUUtilization` and `MemoryUtilization` are percentages of the
 * *task* reservation, so a percentage threshold survives a resize by
 * construction. What does not survive is prose: "90% of the task" means a
 * different number of vCPUs at 512/1024 than at 1024/2048, and a description
 * that hardcoded "0.44 vCPU" would be quietly wrong the moment the task grew.
 * So the descriptions below are built from `TASK_CPU` and `TASK_MEMORY`
 * (imported from `ecs.ts`) through the two helpers under "What a threshold
 * means in vCPUs", and a resize updates them with no edit here.
 *
 * That mattered in practice: PR #484 raised the task from 512/1024 to
 * 1024/2048 while this module was being written, and the only thing the resize
 * had to touch is `ecs.ts`. Nothing in this file names a task size, and
 * `alarms.test.ts` pins that.
 *
 * ## One topic, email only
 *
 * `bifrost-gateway-health` is the account's one gateway-health topic, and its
 * only subscriber is `aws-workbench@goodparty.org`, the group alias the spend
 * alerts and the reconciler's alarm already use (`alert-email.ts`). The wire is
 * copied from `bifrost-vk-janitor.ts`, which is the pattern that already works
 * here: a topic, an email subscription, a topic policy admitting the CloudWatch
 * service principal, and alarms publishing to it.
 *
 * Deliberately **email only**. `index.ts` records "no Slack for now" as a
 * reviewed decision for this account, and a new alarm is not the place to
 * reverse it. No Chatbot, no PagerDuty, no webhook.
 *
 * **The subscription is unconfirmed until someone accepts AWS's email.** Same
 * trap as the janitor's, spelled out there and in the PR that added this file:
 * until then the alarms fire and nobody is told. `AlertTopic` is returned so an
 * operator can read the subscription's state rather than guess.
 *
 * ## What is deliberately absent
 *
 * - **No composite alarms.** The four signals are independent failures with
 *   independent answers: a CPU pin, a memory leak, an ALB with no healthy
 *   target, and the load balancer's own 5XX. A composite would only be
 *   justified if two of them were the same fault seen twice, and the measured
 *   data says they are not (`alarms.test.ts` records the two that look closest:
 *   5XX and CPU pinning coincide, but each also occurs without the other).
 * - **No budget or spend alarm.** `index.ts` already has those.
 * - **No `UnHealthyHostCount` alarm.** The task's availability question offers
 *   it as an alternative to `RunningTaskCount`; the measurements say it cannot
 *   work here. See `AVAILABILITY_METRIC` for the numbers.
 */

/** The topic's name, and the `Project` tag every resource here carries. */
export const BIFROST_GATEWAY_HEALTH_NAME = "bifrost-gateway-health";

/**
 * Five minutes, and the same period for all four alarms.
 *
 * One period is one CloudWatch datapoint, so keeping every period at five
 * minutes keeps every evaluation window a whole number of datapoints and lets
 * the comments below be read as minutes. It is also the granularity the
 * incidents were observed at: the 5XX bursts are five to six minutes long, and
 * a coarse period would smear them into the neighbouring quiet.
 */
export const ALARM_PERIOD_SECONDS = 300;

/**
 * `TASK_CPU` is Fargate's milli-vCPU string and `TASK_MEMORY` is MiB, so the
 * two helpers only move between a percentage and the absolute figure a human
 * wants when an alarm fires. The divisor is Fargate's own unit definition
 * (1024 CPU units to a vCPU), not this task's size: nothing here names how many
 * vCPUs the task has, which is what lets a resize land in `ecs.ts` alone.
 */
export const FARGATE_CPU_UNITS_PER_VCPU = 1024;

export const taskVCpus = (): number => Number(TASK_CPU) / FARGATE_CPU_UNITS_PER_VCPU;
export const taskMemoryMiB = (): number => Number(TASK_MEMORY);

/** "90% of the task" as something a human can hold: "0.90 vCPU". */
export const percentOfTaskCpu = (percent: number): string =>
  `${((taskVCpus() * percent) / 100).toFixed(2)} vCPU`;

/** "85% of the task" as "1741 MiB". */
export const percentOfTaskMemory = (percent: number): string =>
  `${Math.round((taskMemoryMiB() * percent) / 100)} MiB`;

// ---------------------------------------------------------------------------
// 1. Task CPU saturation.
//
// The measurement that decides the shape: over the fortnight, the 5-minute
// `CPUUtilization` maximum crossed 80% on exactly eight buckets, and **no two
// of them were adjacent**. They are single buckets, roughly 25 minutes apart,
// each one a burst of densification that finishes inside its own period:
//
//   2026-10-23T15:50 92.5   2026-10-24T15:50 99.6
//   2026-10-25T15:55 100.0  2026-10-26T12:15 88.6
//   2026-11-03T16:05 99.7   2026-11-03T16:35 100.3
//   2026-11-04T16:40 88.9   2026-11-06T08:45 100.2
//
// That is why one period at 90% would be a false-alarm generator: it would have
// fired eight times in fourteen days on the normal pattern. The signal that is
// worth a page is the *sustained* pin — the state where requests queue and the
// ALB starts giving up — and that is what a window of several periods measures.
//
// `datapointsToAlarm: 3` of `evaluationPeriods: 6` is the window: at least
// three of the last six five-minute buckets must have peaked at 90% or more,
// which is fifteen of the last thirty minutes. A single bucket cannot fire it,
// two cannot fire it, and it does not fire on any of the eight spikes above
// (all of them are 1 of 6). It fires within thirty minutes of a real pin, and
// the simulated check against the fortnight produces zero episodes.
//
// 90% rather than 95%: the task is CPU-bound, so the interesting state starts
// well before the ceiling, and the last 10% of a Fargate task is not headroom
// worth waiting for. It is also the number that stays meaningful across a
// resize, which is the whole reason the metric is a percentage.
// ---------------------------------------------------------------------------
export const CPU_SATURATION_ALARM_NAME = "bifrost-gateway-cpu-saturation";
export const CPU_SATURATION_THRESHOLD_PERCENT = 90;
export const CPU_SATURATION_EVALUATION_PERIODS = 6;
export const CPU_SATURATION_DATAPOINTS_TO_ALARM = 3;

/** How much of the window must be pinned, in minutes, for a reader of the doc. */
export const CPU_SATURATION_BREACH_MINUTES =
  (CPU_SATURATION_DATAPOINTS_TO_ALARM * ALARM_PERIOD_SECONDS) / 60;
export const CPU_SATURATION_WINDOW_MINUTES =
  (CPU_SATURATION_EVALUATION_PERIODS * ALARM_PERIOD_SECONDS) / 60;

export const CPU_SATURATION_ALARM_DESCRIPTION =
  `The Bifrost gateway task has been pinned at ${CPU_SATURATION_THRESHOLD_PERCENT}% or more of its ${taskVCpus()} vCPU (${percentOfTaskCpu(CPU_SATURATION_THRESHOLD_PERCENT)}) for at least ${CPU_SATURATION_BREACH_MINUTES} of the last ${CPU_SATURATION_WINDOW_MINUTES} minutes, so requests are queueing inside the task rather than being served and callers are seeing slow responses or 503s. Answer: docs/runbooks.md, "The Bifrost gateway is saturated or not serving", step 1. Read /aws/ecs/bifrost for the slow requests, then either raise the task size in deploy-workbench/ecs.ts (TASK_CPU and the container reservations together) or cut the load; if it is one caller, throttle them. Do not raise this alarm's threshold: it fires on sustained pinning, which is the state users feel.`;

// ---------------------------------------------------------------------------
// 2. Task memory pressure — a leak detector, not a capacity alarm.
//
// There is no leak today. Over the fortnight the 5-minute `MemoryUtilization`
// maximum peaked at 65.97% (2026-10-25T15:54) and every day since 2026-11-01
// has stayed under 32%; the 99.9th percentile of the whole 1-minute series is
// 43.5% and the median is 12.4%. What that shape means is that memory is not
// steering the task size, and an alarm on it is watching for the one failure
// mode memory has: a slow climb that never comes back down.
//
// So it is set well clear of every normal observation and it must hold for the
// whole window. 85% is above the all-time maximum by nineteen points and above
// the 99.9th percentile by forty-one, and `6 of 6` periods means the task has
// been there for the entire thirty minutes — a leak that is climbing through
// the threshold and a burst that touches it and falls back are different
// things, and only the first is worth a page. A single spike cannot fire it.
//
// Note the resize: `MemoryUtilization` is a percentage of the task, so the
// historical percentages above were measured against the old 1024 MiB and
// halve against the current 2048 MiB. The threshold does not need to move; the
// description's MiB figure follows `TASK_MEMORY` on its own.
// ---------------------------------------------------------------------------
export const MEMORY_PRESSURE_ALARM_NAME = "bifrost-gateway-memory-pressure";
export const MEMORY_PRESSURE_THRESHOLD_PERCENT = 85;
export const MEMORY_PRESSURE_EVALUATION_PERIODS = 6;

export const MEMORY_PRESSURE_WINDOW_MINUTES =
  (MEMORY_PRESSURE_EVALUATION_PERIODS * ALARM_PERIOD_SECONDS) / 60;

export const MEMORY_PRESSURE_ALARM_DESCRIPTION =
  `The Bifrost gateway task has held ${MEMORY_PRESSURE_THRESHOLD_PERCENT}% or more of its ${taskMemoryMiB()} MiB (${percentOfTaskMemory(MEMORY_PRESSURE_THRESHOLD_PERCENT)}) for ${MEMORY_PRESSURE_WINDOW_MINUTES} minutes without dropping back. Normal operation is well under half of that, so a reading this high is a leak or a runaway cache rather than load, and the task is close to being OOM-killed mid-request. Answer: docs/runbooks.md, "The Bifrost gateway is saturated or not serving", step 2. Graph 24 hours of AWS/ECS MemoryUtilization for the bifrost service to see whether it is climbing or stepped, check /aws/ecs/bifrost for the request shape that grew it, and restart the task (a new deployment) to reclaim the memory while you look. Raising the task size buys time and hides the leak; find it first.`;

// ---------------------------------------------------------------------------
// 3. ALB-generated 5XX — the alarm that would have caught all three incidents.
//
// This is the signal the fortnight was missing, and it is worth being precise
// about why: `HTTPCode_ELB_5XX_Count` counts responses the **load balancer**
// generated, not responses a target generated, and `HTTPCode_Target_5XX_Count`
// is zero across the whole window because Bifrost never returned an error. The
// failures were the ALB giving up on a pinned task, so the only metric that
// carries them is this one.
//
// **The metric is only published when the value is nonzero** (AWS's reporting
// criteria for it), so `treatMissingData: "notBreaching"` is not a young-account
// convenience here — it is the correct reading of an absent datapoint. A quiet
// five minutes is a healthy five minutes, and the baseline genuinely is zero.
//
// ## Why one period, and why the threshold is 30
//
// One period, because the incidents are short: the 5-minute buckets that make
// them up are 32, 50 and 44, and a window of two periods at any threshold above
// 20 fires on **nothing** in the fortnight. Requiring two consecutive buckets
// would have missed every incident this alarm exists for, so the window is a
// single bucket and all the care goes into the threshold.
//
// Thirty, because the measured distribution has a gap there. Every 5-minute
// bucket in the fortnight with a nonzero count is one of:
//
//   routine deploys (stop-before-start, by design)   up to 24
//   the three incidents                              32, 44, 50
//
// Nothing at all was measured between 25 and 31. Thirty sits in that gap:
// above every routine deploy's peak, below every incident's first bucket. A
// deploy's 503 window is the deregistration delay plus a ~23s boot
// (`ingress.ts`, `BIFROST_MEASURED_BOOT_SECONDS`), which is seconds to a
// minute, and it lands in the 17-24 range — 47 deploys were checked, and the
// alarm fires on none of them.
//
// At 30 the alarm fires on four buckets in the fortnight: the three incidents,
// and 2026-11-06T17:40 (85), which is the deploy of #484 — the task resize that
// was itself the fix for the saturation. One page in fourteen days, on a deploy
// that replaced the only task during the saturation period, is the cost of
// catching the other three. Twenty would have been eight pages, four of them
// routine deploys.
//
// Dimensions: `LoadBalancer` only. AWS documents `HTTPCode_ELB_5XX_Count` with
// `LoadBalancer` or `AvailabilityZone`+`LoadBalancer` and **no** `TargetGroup`
// form, unlike `HTTPCode_Target_5XX_Count`; a `TargetGroup` dimension here
// would publish nothing and the alarm would sit in `INSUFFICIENT_DATA`
// forever. The `notBreaching` above is exactly what would make that mistake
// silent, which is why `alarms.test.ts` pins the dimension set as well as the
// threshold.
// ---------------------------------------------------------------------------
export const ALB_5XX_ALARM_NAME = "bifrost-gateway-alb-5xx";
export const ALB_5XX_THRESHOLD_COUNT = 30;
export const ALB_5XX_EVALUATION_PERIODS = 1;

export const ALB_5XX_ALARM_DESCRIPTION =
  `The gateway's load balancer returned ${ALB_5XX_THRESHOLD_COUNT} or more 5XX responses in five minutes, five minutes in which Bifrost itself returned none. That is the signature of the ALB giving up on a task that is briefly pinned or not yet healthy, which is how every outage on this gateway has reached its users: they get 503s and the application logs nothing. Answer: docs/runbooks.md, "The Bifrost gateway is saturated or not serving", step 3. Check AWS/ECS CPUUtilization for the bifrost service over the same five minutes (if it is pinned, this is the capacity alarm and the fix is in deploy-workbench/ecs.ts), then whether a deploy or task replacement was in flight, then /aws/ecs/bifrost around the burst. A single bucket above 24 with no deploy in flight is a real incident.`;

// ---------------------------------------------------------------------------
// 4. Availability — there is no running task.
//
// ## Why `RunningTaskCount` and not `UnHealthyHostCount`
//
// The task offers either, on the reasoning that with `desiredCount: 1` they are
// nearly the same signal. Measured, they are not: `UnHealthyHostCount` on the
// Bifrost target group is **identically zero for the whole fortnight**, including
// through the three-hour outage on 2026-10-26. That is documented ALB behaviour,
// not a quirk of this deployment — deregistering a target lowers
// `HealthyHostCount` and does not raise `UnHealthyHostCount`, and with no
// registered target the metric stops being reported at all. An alarm on it
// would never have fired on the worst outage this gateway has had.
//
// `RunningTaskCount` from Container Insights (the cluster has insights enabled,
// `ecs.ts`) is the direct statement of the thing that is wrong: there is no
// task. It reads 1 in the steady state, drops to 0 for one or two buckets during
// a task replacement, and — the part that matters — **stops being published
// entirely** during a real outage, 34 consecutive buckets in the 2026-10-26
// case. That is why this alarm's missing-data treatment is the opposite of the
// other three: for the others an absent datapoint means "nothing happened", and
// here it means "the agent that would have told us stopped".
//
// ## Why 4 consecutive periods, which is the important tuning decision
//
// A deploy takes the task down by design: `DEPLOYMENT_MINIMUM_HEALTHY_PERCENT`
// is 0 and `DEPLOYMENT_MAXIMUM_PERCENT` is 100, so ECS drains the only task
// before starting its replacement. Measured over 47 deploys, that gap is one or
// two five-minute buckets, and the longest continuous run below 1 at 1-minute
// resolution is 8 minutes. Twenty minutes is more than twice that, so **no
// deploy can fire this alarm**, while the real outage would still have paged
// twenty minutes in rather than three hours and a human noticing. That margin —
// 20 minutes against a measured worst case of ~10 — is the whole reason the
// number is 4 and not 2.
//
// The cost is that a genuine `desiredCount: 0` sits unnoticed for twenty
// minutes. That is the right trade for an alarm that must not cry wolf on every
// merge, and the deploy pipeline's own `verify-service.ts` covers the
// shorter-window case: it fails a deploy that does not come back up.
// ---------------------------------------------------------------------------
export const AVAILABILITY_ALARM_NAME = "bifrost-gateway-no-running-task";
export const AVAILABILITY_THRESHOLD_TASKS = 1;
export const AVAILABILITY_EVALUATION_PERIODS = 4;

export const AVAILABILITY_WINDOW_MINUTES =
  (AVAILABILITY_EVALUATION_PERIODS * ALARM_PERIOD_SECONDS) / 60;

export const AVAILABILITY_ALARM_DESCRIPTION =
  `The Bifrost gateway has had no running task for ${AVAILABILITY_WINDOW_MINUTES} minutes, or has stopped reporting a task count for that long, so the endpoint is answering 503 from the load balancer and every caller is failing. That window is deliberately more than twice the longest gap any deploy has produced, so this is not a normal merge. Answer: docs/runbooks.md, "The Bifrost gateway is saturated or not serving", step 4. Run aws ecs describe-services --cluster ${BIFROST_CLUSTER_NAME} --services ${BIFROST_SERVICE_NAME} and read the service events for why the task will not stay up; the deployment circuit breaker rolls back a revision that cannot become healthy, so a service stuck here is usually a task that starts and then dies. scripts/verify-service.ts covers the deploy-time version of this check.`;

// ---------------------------------------------------------------------------
// The topic and its policy.
// ---------------------------------------------------------------------------

/**
 * CloudWatch's service principal is **not** admitted by a topic's default
 * policy, so without this the alarm changes state and nothing is delivered. The
 * condition is the account rather than the four alarm ARNs: naming them would
 * make the policy and the alarms depend on each other for no gain, and
 * `sheriff-lambda.ts` records the same reasoning for the same policy in the
 * infrastructure account.
 *
 * A pure function of the topic ARN so a test can read the document without
 * standing up a Pulumi resource.
 */
export const alertTopicPolicy = (topicArn: string): string =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "CloudWatchAlarms",
        Effect: "Allow",
        Principal: { Service: "cloudwatch.amazonaws.com" },
        Action: "SNS:Publish",
        Resource: topicArn,
        Condition: {
          StringEquals: { "aws:SourceAccount": WORKBENCH_ACCOUNT_ID },
        },
      },
    ],
  });

/**
 * The four alarms, as data.
 *
 * Declared once here and consumed by the loop below, so the test can assert
 * every alarm's full shape without a Pulumi runtime, and so "does every alarm
 * publish to the topic" is a property of one list rather than four copies of
 * `alarmActions`. `namespace`, `metricName` and the trend of each threshold are
 * the parts the comments above argue for; `tags` is filled in by the caller
 * because each alarm's `Name` is its own.
 */
export type AlarmSpec = {
  /** The Pulumi logical name; also the `aws:cloudwatch:Alarm` name. */
  logicalName: string;
  name: string;
  description: string;
  namespace: string;
  metricName: string;
  statistic: "Sum" | "Minimum" | "Maximum";
  dimensions: Record<string, string>;
  comparisonOperator:
    | "GreaterThanOrEqualToThreshold"
    | "LessThanThreshold";
  threshold: number;
  evaluationPeriods: number;
  datapointsToAlarm: number;
  treatMissingData: "notBreaching" | "breaching";
};

/**
 * The dimensions each alarm reads, as names only, so the caller binds them to
 * the resources it actually created rather than to a copied literal. The
 * values come from `ecs.ts`'s constants and from the ingress object, which is
 * what keeps an alarm pointing at the service and load balancer that exist.
 */
export const bifrostServiceDimensions = (): Record<string, string> => ({
  ServiceName: BIFROST_SERVICE_NAME,
  ClusterName: BIFROST_CLUSTER_NAME,
});

/**
 * The dimension map one alarm is created with, resolved from the spec plus the
 * load balancer the ingress actually made. A pure function so
 * `alarms.test.ts` can check what the apply sends without a Pulumi runtime —
 * and the ALB-on-a-`TargetGroup`-dimension mistake is silent (`INSUFFICIENT_DATA`
 * forever), which is why it is checked rather than trusted.
 */
export const alarmDimensions = (
  spec: AlarmSpec,
  loadBalancerDimension: pulumi.Input<string>,
): Record<string, pulumi.Input<string>> =>
  spec.name === ALB_5XX_ALARM_NAME
    ? { LoadBalancer: loadBalancerDimension }
    : spec.dimensions;

/**
 * The four specs. Pure and synchronous so `alarms.test.ts` can read them. The
 * ALB alarm's `dimensions` is empty here on purpose: its one key's value is the
 * load balancer's `arnSuffix`, a resource the spec cannot see, so
 * `alarmDimensions` fills it in at creation time.
 */
export const alarmSpecs = (): AlarmSpec[] => [
  {
    logicalName: "bifrostGatewayCpuSaturationAlarm",
    name: CPU_SATURATION_ALARM_NAME,
    description: CPU_SATURATION_ALARM_DESCRIPTION,
    namespace: "AWS/ECS",
    metricName: "CPUUtilization",
    statistic: "Maximum",
    dimensions: bifrostServiceDimensions(),
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    threshold: CPU_SATURATION_THRESHOLD_PERCENT,
    evaluationPeriods: CPU_SATURATION_EVALUATION_PERIODS,
    datapointsToAlarm: CPU_SATURATION_DATAPOINTS_TO_ALARM,
    treatMissingData: "notBreaching",
  },
  {
    logicalName: "bifrostGatewayMemoryPressureAlarm",
    name: MEMORY_PRESSURE_ALARM_NAME,
    description: MEMORY_PRESSURE_ALARM_DESCRIPTION,
    namespace: "AWS/ECS",
    metricName: "MemoryUtilization",
    statistic: "Maximum",
    dimensions: bifrostServiceDimensions(),
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    threshold: MEMORY_PRESSURE_THRESHOLD_PERCENT,
    evaluationPeriods: MEMORY_PRESSURE_EVALUATION_PERIODS,
    // The whole window, unlike CPU: a leak holds, a burst does not.
    datapointsToAlarm: MEMORY_PRESSURE_EVALUATION_PERIODS,
    treatMissingData: "notBreaching",
  },
  {
    logicalName: "bifrostGatewayAlb5xxAlarm",
    name: ALB_5XX_ALARM_NAME,
    description: ALB_5XX_ALARM_DESCRIPTION,
    namespace: "AWS/ApplicationELB",
    metricName: "HTTPCode_ELB_5XX_Count",
    statistic: "Sum",
    // No `TargetGroup` key, deliberately: AWS does not publish the ELB-5XX
    // counts with that dimension, and adding one yields an alarm that never
    // leaves INSUFFICIENT_DATA. See the comment above the constants.
    dimensions: {},
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    threshold: ALB_5XX_THRESHOLD_COUNT,
    evaluationPeriods: ALB_5XX_EVALUATION_PERIODS,
    datapointsToAlarm: ALB_5XX_EVALUATION_PERIODS,
    treatMissingData: "notBreaching",
  },
  {
    logicalName: "bifrostGatewayNoRunningTaskAlarm",
    name: AVAILABILITY_ALARM_NAME,
    description: AVAILABILITY_ALARM_DESCRIPTION,
    namespace: "ECS/ContainerInsights",
    metricName: "RunningTaskCount",
    statistic: "Minimum",
    dimensions: bifrostServiceDimensions(),
    comparisonOperator: "LessThanThreshold",
    threshold: AVAILABILITY_THRESHOLD_TASKS,
    evaluationPeriods: AVAILABILITY_EVALUATION_PERIODS,
    datapointsToAlarm: AVAILABILITY_EVALUATION_PERIODS,
    // The odd one out. An absent datapoint here is the signal: Container
    // Insights stops publishing `RunningTaskCount` when the service stops
    // reporting, which is exactly the 34-bucket hole in the 2026-10-26 outage.
    treatMissingData: "breaching",
  },
];

export const createBifrostGatewayAlarms = (args: {
  provider: aws.Provider;
  ingress: BifrostIngress;
}) => {
  const { provider, ingress } = args;
  const tags = { Name: BIFROST_GATEWAY_HEALTH_NAME, Project: BIFROST_GATEWAY_HEALTH_NAME };

  // One topic for gateway health, not one per alarm: they answer the same
  // operator question ("is the gateway serving?"), and four topics would be
  // four subscriptions to confirm on four separate AWS emails.
  const alertTopic = new aws.sns.Topic(
    "bifrostGatewayHealthTopic",
    {
      name: BIFROST_GATEWAY_HEALTH_NAME,
      tags,
    },
    { provider },
  );

  // **Unconfirmed until someone clicks the link in AWS's email.** An
  // unconfirmed subscription means a firing alarm is delivered to nobody, and
  // nothing in the apply reports it. `bifrost-vk-janitor.ts` records the same
  // trap for the same reason.
  new aws.sns.TopicSubscription(
    "bifrostGatewayHealthSubscription",
    {
      topic: alertTopic.arn,
      protocol: "email",
      endpoint: WORKBENCH_ALERT_EMAIL,
    },
    { provider },
  );

  const topicPolicy = new aws.sns.TopicPolicy(
    "bifrostGatewayHealthTopicPolicy",
    {
      arn: alertTopic.arn,
      policy: alertTopic.arn.apply(alertTopicPolicy),
    },
    { provider },
  );

  const loadBalancerDimension = ingress.loadBalancer.arnSuffix;

  const alarms = alarmSpecs().map((spec) =>
    new aws.cloudwatch.MetricAlarm(
      spec.logicalName,
      {
        name: spec.name,
        alarmDescription: spec.description,
        namespace: spec.namespace,
        metricName: spec.metricName,
        statistic: spec.statistic,
        dimensions: alarmDimensions(spec, loadBalancerDimension),
        period: ALARM_PERIOD_SECONDS,
        evaluationPeriods: spec.evaluationPeriods,
        datapointsToAlarm: spec.datapointsToAlarm,
        threshold: spec.threshold,
        comparisonOperator: spec.comparisonOperator,
        treatMissingData: spec.treatMissingData,
        // Every alarm publishes to the one topic. This line is the wiring the
        // whole module exists for, and a mistake in it fails silently, which is
        // why `alarms.test.ts` asserts it for all four.
        alarmActions: [alertTopic.arn],
        tags: { Name: spec.name },
      },
      // The topic and, more importantly, its policy must exist before an alarm
      // can publish: an alarm whose policy is not yet in place changes state and
      // SNS rejects the publish, which is a page lost rather than an apply
      // failure. `alertTopic` alone would leave that ordering implicit, so the
      // policy is named too.
      { provider, dependsOn: [alertTopic, topicPolicy] },
    ),
  );

  return {
    alertTopic,
    alarms,
    cpuSaturationAlarm: alarms[0],
    memoryPressureAlarm: alarms[1],
    alb5xxAlarm: alarms[2],
    availabilityAlarm: alarms[3],
  };
};
