import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import {
  ALB_5XX_ALARM_DESCRIPTION,
  ALB_5XX_ALARM_NAME,
  ALB_5XX_EVALUATION_PERIODS,
  ALB_5XX_THRESHOLD_COUNT,
  ALARM_PERIOD_SECONDS,
  AVAILABILITY_ALARM_DESCRIPTION,
  AVAILABILITY_ALARM_NAME,
  AVAILABILITY_EVALUATION_PERIODS,
  AVAILABILITY_THRESHOLD_TASKS,
  AVAILABILITY_WINDOW_MINUTES,
  BIFROST_GATEWAY_HEALTH_NAME,
  CPU_SATURATION_ALARM_DESCRIPTION,
  CPU_SATURATION_ALARM_NAME,
  CPU_SATURATION_BREACH_MINUTES,
  CPU_SATURATION_DATAPOINTS_TO_ALARM,
  CPU_SATURATION_EVALUATION_PERIODS,
  CPU_SATURATION_THRESHOLD_PERCENT,
  CPU_SATURATION_WINDOW_MINUTES,
  MEMORY_PRESSURE_ALARM_DESCRIPTION,
  MEMORY_PRESSURE_ALARM_NAME,
  MEMORY_PRESSURE_EVALUATION_PERIODS,
  MEMORY_PRESSURE_THRESHOLD_PERCENT,
  MEMORY_PRESSURE_WINDOW_MINUTES,
  alarmDimensions,
  alarmSpecs,
  alertTopicPolicy,
  bifrostServiceDimensions,
  percentOfTaskCpu,
  percentOfTaskMemory,
  taskMemoryMiB,
  taskVCpus,
} from "./alarms";
import { WORKBENCH_ALERT_EMAIL } from "./alert-email";
import {
  BIFROST_CLUSTER_NAME,
  BIFROST_SERVICE_NAME,
  TASK_CPU,
  TASK_MEMORY,
} from "./ecs";
import { VK_JANITOR_ALERT_EMAIL } from "./bifrost-vk-janitor";

/**
 * The gateway-health alarm module, pinned without standing up Pulumi — the same
 * shape as `bifrost-vk-janitor.test.ts`.
 *
 * The point of these alarms is that they are *wired*: an alarm with no
 * `alarmActions`, a topic policy that does not admit CloudWatch, or a
 * `LoadBalancer` dimension typo all fail silently. The alarm changes state, the
 * console looks right, and nobody is told. None of those is an apply error and
 * a `pulumi preview` shows nothing, so the assertions below are the only thing
 * that catches them.
 *
 * The thresholds are pinned as values as well as read through the specs,
 * because the numbers are argued from a measured fortnight (`alarms.ts` has the
 * measurements) and a later edit that moves one should have to change a test.
 */

const SOURCE = fs.readFileSync(path.resolve(__dirname, "alarms.ts"), "utf8");

/**
 * The module's code with its comments removed.
 *
 * Half the assertions here are about what the module does *not* contain, and
 * the comments deliberately discuss the rejected options by name ("no Slack for
 * now", the `UnHealthyHostCount` that would never fire, #484's 512/1024). A
 * raw-source `doesNotMatch` would fail on the explanation rather than on the
 * code, so the absence checks read this instead.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /^\s*\/\/.*$/gm,
  "",
);
const INDEX_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "index.ts"),
  "utf8",
);
const ECS_SOURCE = fs.readFileSync(path.resolve(__dirname, "ecs.ts"), "utf8");
const RUNBOOKS = fs.readFileSync(
  path.resolve(__dirname, "../docs/runbooks.md"),
  "utf8",
);

describe("the shared alert address", () => {
  it("is one constant in one place, imported rather than restated", () => {
    assert.equal(WORKBENCH_ALERT_EMAIL, "aws-workbench@goodparty.org");
    // The janitor's alarm and this module's topic must agree; before this
    // module there were two copies, and `index.ts`'s spend alerts a third.
    assert.equal(VK_JANITOR_ALERT_EMAIL, WORKBENCH_ALERT_EMAIL);
    assert.match(INDEX_SOURCE, /const SPEND_ALERT_EMAIL = WORKBENCH_ALERT_EMAIL;/);
  });

  it("is not written out in the alarm, janitor or index modules", () => {
    // A literal in any of the three is a copy waiting to drift. Only
    // `alert-email.ts` may spell it.
    for (const [file, source] of [
      ["alarms.ts", SOURCE],
      ["index.ts", INDEX_SOURCE],
      [
        "bifrost-vk-janitor.ts",
        fs.readFileSync(
          path.resolve(__dirname, "bifrost-vk-janitor.ts"),
          "utf8",
        ),
      ],
    ] as const) {
      assert.doesNotMatch(
        source,
        /["']aws-workbench@goodparty\.org["']/,
        `${file} spells the alert address out; import WORKBENCH_ALERT_EMAIL instead`,
      );
    }
  });
});

describe("the topic and its policy", () => {
  it("is one topic named bifrost-gateway-health", () => {
    assert.equal(BIFROST_GATEWAY_HEALTH_NAME, "bifrost-gateway-health");
    assert.match(SOURCE, /new aws\.sns\.Topic\(/);
    assert.match(SOURCE, /name: BIFROST_GATEWAY_HEALTH_NAME/);
    // One topic, not one per alarm: the module creates exactly one.
    assert.equal((SOURCE.match(/new aws\.sns\.Topic\(/g) ?? []).length, 1);
  });

  it("subscribes the workbench address by email, which is the only subscriber", () => {
    assert.match(SOURCE, /new aws\.sns\.TopicSubscription\(/);
    assert.match(SOURCE, /protocol: "email"/);
    assert.match(SOURCE, /endpoint: WORKBENCH_ALERT_EMAIL/);
    // Email only. `index.ts` records "no Slack for now" as a reviewed decision
    // for this account, and an alarm is not the place to reverse it.
    assert.doesNotMatch(CODE, /protocol: "(sqs|lambda|https|sms)"/);
    assert.doesNotMatch(CODE, /chatbot|pagerduty|slack|webhook/i);
  });

  it("lets the CloudWatch principal publish, conditioned on this account only", () => {
    const policy = JSON.parse(
      alertTopicPolicy("arn:aws:sns:us-west-2:024901689212:bifrost-gateway-health"),
    ) as {
      Statement: Array<{
        Principal?: { Service?: string };
        Action?: string;
        Condition?: Record<string, Record<string, string>>;
      }>;
    };
    const statement = policy.Statement.find(
      (s) => s.Principal?.Service === "cloudwatch.amazonaws.com",
    );
    assert.ok(
      statement,
      "the default topic policy does not admit the CloudWatch principal, so without this the alarm fires and nothing is delivered",
    );
    assert.equal(statement.Action, "SNS:Publish");
    // The account, not the alarm ARNs: naming them would make the policy and
    // the alarms depend on each other.
    assert.deepEqual(statement.Condition, {
      StringEquals: { "aws:SourceAccount": WORKBENCH_ACCOUNT_ID },
    });
    assert.doesNotMatch(CODE, /aws:SourceArn/);
  });

  it("attaches the policy to the topic it describes", () => {
    assert.match(SOURCE, /new aws\.sns\.TopicPolicy\(/);
    assert.match(SOURCE, /arn: alertTopic\.arn/);
    assert.match(SOURCE, /policy: alertTopic\.arn\.apply\(alertTopicPolicy\)/);
    // Bound to a name so the alarms can depend on it; the reviewer is right
    // that a resource the alarms do not wait for is an ordering bug.
    assert.match(SOURCE, /const topicPolicy = new aws\.sns\.TopicPolicy\(/);
  });
});

describe("all four alarms are wired to the topic", () => {
  it("declares exactly four, and every one publishes to alertTopic", () => {
    const specs = alarmSpecs();
    assert.equal(specs.length, 4);
    // One `alarmActions` in the source, inside the loop, so a fourth alarm
    // cannot be added without it.
    const actions = SOURCE.match(/alarmActions:\s*\[([^\]]*)\]/g) ?? [];
    assert.equal(actions.length, 1, "expected exactly one alarmActions line");
    assert.match(actions[0], /alertTopic\.arn/);
    // The loop covers every spec.
    assert.match(SOURCE, /alarmSpecs\(\)\.map\(/);
  });

  it("names the four alarms so a runbook can name them back", () => {
    const names = alarmSpecs().map((spec) => spec.name);
    assert.deepEqual(names, [
      "bifrost-gateway-cpu-saturation",
      "bifrost-gateway-memory-pressure",
      "bifrost-gateway-alb-5xx",
      "bifrost-gateway-no-running-task",
    ]);
    // The service-level ticket names the topic; the runbook names each alarm.
    for (const name of names) {
      assert.ok(
        RUNBOOKS.includes(`\`${name}\``),
        `docs/runbooks.md does not name ${name}`,
      );
    }
  });

  it("gives every alarm a distinct logical name and a real description", () => {
    const specs = alarmSpecs();
    assert.equal(new Set(specs.map((s) => s.logicalName)).size, 4);
    assert.equal(new Set(specs.map((s) => s.name)).size, 4);
    for (const spec of specs) {
      assert.ok(
        spec.description.length > 200,
        `${spec.name}'s description is too short to say what happened and what to do`,
      );
      // AWS's limit on an alarm description. `bifrost-vk-janitor.ts` records
      // what a too-long description costs on the neighbouring resource.
      assert.ok(
        spec.description.length <= 1023,
        `${spec.name}'s description is ${spec.description.length} characters; AWS's limit is 1023`,
      );
      // Each one points a responder at the section that answers it.
      assert.match(spec.description, /docs\/runbooks\.md/);
    }
  });

  it("describes what happened, not only what the metric is", () => {
    // The janitor's description is the model: a sentence about the state, then
    // the answer. A description that only restates the metric name tells a
    // woken human nothing.
    assert.match(CPU_SATURATION_ALARM_DESCRIPTION, /pinned/);
    assert.match(MEMORY_PRESSURE_ALARM_DESCRIPTION, /leak/);
    assert.match(ALB_5XX_ALARM_DESCRIPTION, /5XX/);
    assert.match(AVAILABILITY_ALARM_DESCRIPTION, /no running task/);
  });

  it("does not restate a number in prose that it also interpolates", () => {
    // A description that interpolates a constant and then spells the same
    // figure out by hand goes stale on the next tuning change, and the first
    // draft of two of these did exactly that ("above 24" beside a threshold of
    // 30, "Twenty minutes" beside an interpolated window). Every figure that is
    // a constant in this module must arrive by interpolation; anything else
    // numeric and spelled out is a copy.
    const interpolated = new Set([
      String(ALB_5XX_THRESHOLD_COUNT),
      String(CPU_SATURATION_THRESHOLD_PERCENT),
      String(MEMORY_PRESSURE_THRESHOLD_PERCENT),
      String(CPU_SATURATION_BREACH_MINUTES),
      String(CPU_SATURATION_WINDOW_MINUTES),
      String(MEMORY_PRESSURE_WINDOW_MINUTES),
      String(AVAILABILITY_WINDOW_MINUTES),
    ]);
    for (const spec of alarmSpecs()) {
      // Strip what is allowed to be there: the interpolated constants, the
      // task-derived figures (which come from TASK_CPU/TASK_MEMORY through
      // helpers, so they follow a resize rather than going stale), and a lookup
      // span an operator is told to graph (`24 hours`), which is advice about
      // the console and not a value this module tunes.
      const prose = spec.description
        .replace(new RegExp(`\\b(${[...interpolated].join("|")})\\b`, "g"), "<value>")
        .replace(/\d+(\.\d+)? vCPU/g, "<vcpu>")
        .replace(/\d+ MiB/g, "<mib>")
        .replace(/\b\d+ (minutes|hours)\b/g, "<span>")
        // HTTP status codes are the vocabulary of the failure, not a tuned
        // value: 503 and 5XX describe what a caller saw.
        .replace(/\b[45]\d\d\b/g, "<status>");
      const stray = prose.match(/\b\d{2,}\b/g) ?? [];
      assert.deepEqual(
        stray,
        [],
        `${spec.name}'s description spells out ${stray.join(", ")}; interpolate the constant instead so it cannot go stale`,
      );
    }
  });
});

describe("the CPU saturation alarm", () => {
  it("does not fire on a single five-minute bucket", () => {
    // The measured pattern: eight 5-minute buckets above 80% in the fortnight,
    // no two adjacent. One period at 90% fires eight times in fourteen days.
    assert.equal(CPU_SATURATION_THRESHOLD_PERCENT, 90);
    assert.equal(CPU_SATURATION_EVALUATION_PERIODS, 6);
    assert.equal(CPU_SATURATION_DATAPOINTS_TO_ALARM, 3);
    assert.ok(
      CPU_SATURATION_DATAPOINTS_TO_ALARM > 1,
      "a datapointsToAlarm of 1 is the single-bucket alarm this window exists to avoid",
    );
    assert.ok(CPU_SATURATION_DATAPOINTS_TO_ALARM <= CPU_SATURATION_EVALUATION_PERIODS);
    // Fifteen of the last thirty minutes.
    assert.equal(CPU_SATURATION_BREACH_MINUTES, 15);
    assert.equal(CPU_SATURATION_WINDOW_MINUTES, 30);
  });

  it("reads the service's own AWS/ECS CPUUtilization, with both dimensions", () => {
    const spec = alarmSpecs().find((s) => s.name === CPU_SATURATION_ALARM_NAME);
    assert.ok(spec);
    assert.equal(spec.namespace, "AWS/ECS");
    assert.equal(spec.metricName, "CPUUtilization");
    assert.equal(spec.statistic, "Maximum");
    assert.deepEqual(spec.dimensions, {
      ServiceName: BIFROST_SERVICE_NAME,
      ClusterName: BIFROST_CLUSTER_NAME,
    });
    assert.equal(spec.comparisonOperator, "GreaterThanOrEqualToThreshold");
    assert.equal(spec.treatMissingData, "notBreaching");
  });
});

describe("the memory pressure alarm", () => {
  it("is a leak detector: high, and held for the whole window", () => {
    // Measured: all-time max 65.97%, 99.9th percentile 43.5%, median 12.4%.
    // 85 is clear of every observation; holding all six periods is what
    // separates a leak from a burst.
    assert.equal(MEMORY_PRESSURE_THRESHOLD_PERCENT, 85);
    assert.equal(MEMORY_PRESSURE_EVALUATION_PERIODS, 6);
    assert.equal(MEMORY_PRESSURE_WINDOW_MINUTES, 30);
    const spec = alarmSpecs().find((s) => s.name === MEMORY_PRESSURE_ALARM_NAME);
    assert.ok(spec);
    assert.equal(spec.metricName, "MemoryUtilization");
    assert.equal(
      spec.datapointsToAlarm,
      spec.evaluationPeriods,
      "memory must breach every period in the window; a burst that touches the threshold is not a leak",
    );
    assert.ok(
      MEMORY_PRESSURE_THRESHOLD_PERCENT > 66,
      "the threshold must clear the all-time maximum of 65.97%",
    );
  });
});

describe("the ALB 5XX alarm", () => {
  it("is set above every routine deploy and below every measured incident", () => {
    // Measured 5-minute buckets: routine deploys peak at 24, the three
    // incidents are 32, 44 and 50, and nothing at all sits between 25 and 31.
    assert.equal(ALB_5XX_THRESHOLD_COUNT, 30);
    assert.ok(ALB_5XX_THRESHOLD_COUNT > 24, "would fire on routine deploys");
    assert.ok(ALB_5XX_THRESHOLD_COUNT <= 32, "would have missed the smallest incident");
  });

  it("uses one period, because the incidents are shorter than two", () => {
    // Requiring two consecutive breaching buckets fires on nothing in the
    // fortnight at any threshold above 20 — the incidents are one bucket each.
    assert.equal(ALB_5XX_EVALUATION_PERIODS, 1);
    const spec = alarmSpecs().find((s) => s.name === ALB_5XX_ALARM_NAME);
    assert.ok(spec);
    assert.equal(spec.datapointsToAlarm, ALB_5XX_EVALUATION_PERIODS);
    assert.equal(spec.statistic, "Sum");
    assert.equal(spec.namespace, "AWS/ApplicationELB");
    assert.equal(spec.metricName, "HTTPCode_ELB_5XX_Count");
  });

  it("cannot publish with a TargetGroup dimension, so it has none", () => {
    // AWS documents HTTPCode_ELB_5XX_Count with LoadBalancer (or
    // AvailabilityZone + LoadBalancer) and no TargetGroup form, unlike
    // HTTPCode_Target_5XX_Count. A TargetGroup here yields an alarm stuck in
    // INSUFFICIENT_DATA, and `notBreaching` makes that silent.
    const spec = alarmSpecs().find((s) => s.name === ALB_5XX_ALARM_NAME);
    assert.ok(spec);
    assert.deepEqual(spec.dimensions, {});
    assert.deepEqual(
      alarmDimensions(spec, "app/bifrost/abc123"),
      { LoadBalancer: "app/bifrost/abc123" },
      "the alarm must read HTTPCode_ELB_5XX_Count off the load balancer",
    );
    // The other three keep their service dimensions. This is what makes the
    // empty `dimensions` above a statement about the ALB metric rather than a
    // spec that lost its dimensions.
    const cpu = alarmSpecs().find((s) => s.name === CPU_SATURATION_ALARM_NAME);
    assert.ok(cpu);
    assert.deepEqual(alarmDimensions(cpu, "app/bifrost/abc123"), {
      ServiceName: BIFROST_SERVICE_NAME,
      ClusterName: BIFROST_CLUSTER_NAME,
    });
  });

  it("takes the load balancer from the ingress object, not a literal", () => {
    // `app/bifrost/<id>` changes when the ALB is replaced, so a copied literal
    // is a silent INSUFFICIENT_DATA. index.ts passes the ingress it created.
    assert.match(SOURCE, /ingress\.loadBalancer\.arnSuffix/);
    assert.match(INDEX_SOURCE, /createBifrostGatewayAlarms\(\{ provider, ingress \}\)/);
    assert.doesNotMatch(CODE, /"app\/bifrost\//);
  });

  it("treats an absent datapoint as healthy, which is the correct reading", () => {
    // The metric is only published when nonzero, so a quiet five minutes
    // publishes nothing and the baseline genuinely is zero.
    const spec = alarmSpecs().find((s) => s.name === ALB_5XX_ALARM_NAME);
    assert.ok(spec);
    assert.equal(spec.treatMissingData, "notBreaching");
  });
});

describe("the availability alarm", () => {
  it("counts running tasks, not unhealthy hosts", () => {
    // UnHealthyHostCount on this target group is identically zero for the whole
    // fortnight, including through the three-hour outage: deregistering a
    // target lowers HealthyHostCount and does not raise UnHealthyHostCount. An
    // alarm on it would never have fired on the worst outage this gateway had.
    assert.equal(AVAILABILITY_ALARM_NAME, "bifrost-gateway-no-running-task");
    const spec = alarmSpecs().find((s) => s.name === AVAILABILITY_ALARM_NAME);
    assert.ok(spec);
    assert.equal(spec.namespace, "ECS/ContainerInsights");
    assert.equal(spec.metricName, "RunningTaskCount");
    assert.equal(spec.statistic, "Minimum");
    assert.equal(spec.comparisonOperator, "LessThanThreshold");
    assert.equal(spec.threshold, AVAILABILITY_THRESHOLD_TASKS);
    assert.ok(
      !alarmSpecs().some((s) => s.metricName === "UnHealthyHostCount"),
      "UnHealthyHostCount does not report a missing target, so it cannot be the availability signal",
    );
  });

  it("waits longer than any deploy's stop-before-start gap", () => {
    // stop-before-start is by design (`DEPLOYMENT_MINIMUM_HEALTHY_PERCENT` 0,
    // `DEPLOYMENT_MAXIMUM_PERCENT` 100): measured over 47 deploys the gap spans
    // one or two five-minute buckets, and the longest continuous run below 1
    // task at 1-minute resolution is 8 minutes. Twenty minutes is more than
    // twice that, so no deploy can fire it.
    assert.equal(AVAILABILITY_EVALUATION_PERIODS, 4);
    assert.equal(AVAILABILITY_WINDOW_MINUTES, 20);
    assert.ok(
      AVAILABILITY_WINDOW_MINUTES >= 16,
      "a window shorter than twice the measured 8-minute worst case pages on ordinary merges",
    );
    const spec = alarmSpecs().find((s) => s.name === AVAILABILITY_ALARM_NAME);
    assert.ok(spec);
    assert.equal(spec.datapointsToAlarm, spec.evaluationPeriods);
  });

  it("treats an absent datapoint as breaching, unlike the other three", () => {
    // The one place the opposite treatment is correct: Container Insights stops
    // publishing RunningTaskCount when the service stops reporting, which is a
    // 34-bucket hole in the 2026-10-26 outage. Silence is the signal.
    const spec = alarmSpecs().find((s) => s.name === AVAILABILITY_ALARM_NAME);
    assert.ok(spec);
    assert.equal(spec.treatMissingData, "breaching");
    assert.equal(
      alarmSpecs().filter((s) => s.treatMissingData === "breaching").length,
      1,
      "exactly one alarm treats missing data as breaching",
    );
    // The cluster has insights enabled, or RunningTaskCount is never published.
    assert.match(ECS_SOURCE, /containerInsights"?,?\s*value: "enabled"|name: "containerInsights", value: "enabled"/);
  });
});

describe("the task size is imported, never restated", () => {
  it("builds every vCPU and MiB figure in the descriptions from ecs.ts", () => {
    assert.equal(taskVCpus(), Number(TASK_CPU) / 1024);
    assert.equal(taskMemoryMiB(), Number(TASK_MEMORY));
    // The description text is what an operator reads at 3am, and it must follow
    // #484's 1024/2048 without an edit here.
    assert.ok(CPU_SATURATION_ALARM_DESCRIPTION.includes(percentOfTaskCpu(90)));
    assert.ok(MEMORY_PRESSURE_ALARM_DESCRIPTION.includes(percentOfTaskMemory(85)));
    assert.match(SOURCE, /from "\.\/ecs"/);
    assert.match(SOURCE, /TASK_CPU/);
    assert.match(SOURCE, /TASK_MEMORY/);
  });

  it("names no task size of its own", () => {
    // Anything here that looks like a size is a copy that the resize will not
    // reach. The percentages and the period are the only numbers allowed;
    // FARGATE_CPU_UNITS_PER_VCPU is Fargate's unit, not this task's size.
    assert.doesNotMatch(CODE, /\b(512|2048)\b/, "a task size is restated in alarms.ts");
    assert.doesNotMatch(CODE, /0\.(44|48|5|96)\s*vCPU/, "a vCPU count is restated in alarms.ts");
    assert.doesNotMatch(CODE, /\b896\b|\b448\b/, "a container reservation is restated in alarms.ts");
  });

  it("follows a resize rather than pinning today's numbers", () => {
    // The helpers are functions of the imported constant, so the values below
    // are computed, not remembered — the assertion is that they agree.
    const specs = alarmSpecs();
    for (const spec of specs) {
      assert.doesNotMatch(spec.description, /0\.44|0\.5 vCPU|1024 MiB/);
    }
  });
});

describe("the alarm module's shape", () => {
  it("uses one period everywhere, so every window is a whole number of datapoints", () => {
    assert.equal(ALARM_PERIOD_SECONDS, 300);
    assert.match(SOURCE, /period: ALARM_PERIOD_SECONDS/);
    assert.equal(CPU_SATURATION_WINDOW_MINUTES % 5, 0);
    assert.equal(MEMORY_PRESSURE_WINDOW_MINUTES % 5, 0);
    assert.equal(AVAILABILITY_WINDOW_MINUTES % 5, 0);
  });

  it("takes the provider like every other resource in this project", () => {
    // The workbench provider is not the default one and `deploy.sh` disables
    // the default, so an omitted provider is an apply failure, not a resource
    // in the wrong account.
    assert.match(SOURCE, /\{ provider \}/);
    // The alarms wait for the policy, not only the topic: a policy that lands
    // after the first alarm costs a page rather than failing the apply.
    assert.match(SOURCE, /\{ provider, dependsOn: \[alertTopic, topicPolicy\] \}/);
  });

  it("tags what it creates as the surrounding resources are tagged", () => {
    assert.match(SOURCE, /Name: BIFROST_GATEWAY_HEALTH_NAME/);
    assert.match(SOURCE, /Project: BIFROST_GATEWAY_HEALTH_NAME/);
    // Each alarm is tagged with its own name, so the console shows which is
    // which rather than four identical tags.
    assert.match(SOURCE, /tags: \{ Name: spec\.name \}/);
  });

  it("adds no composite alarm and no budget", () => {
    // Four independent failures with four independent answers; a composite
    // would only be justified if two were the same fault seen twice. Spend
    // alarms already exist in index.ts.
    assert.doesNotMatch(CODE, /CompositeAlarm/);
    assert.doesNotMatch(CODE, /budgets/i);
  });
});
