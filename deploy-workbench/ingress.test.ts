import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { WORKBENCH_ZONE_NAME } from "./dns";
import {
  ADMIN_PATH_PATTERNS,
  ADMIN_RULE_PRIORITY,
  ALB_IDLE_TIMEOUT_SECONDS,
  BIFROST_ALB_NAME,
  BIFROST_HEALTH_CHECK_PATH,
  BIFROST_HOSTNAME,
  BIFROST_TARGET_GROUP_NAME,
  HTTPS_LISTENER_RULES,
  INFERENCE_PATH_PATTERNS,
  INFERENCE_RULE_PRIORITY,
  OAUTH2_CALLBACK_PATH_PATTERNS,
  OAUTH2_CALLBACK_RULE_PRIORITY,
  OAUTH2_PROXY_HEALTH_CHECK_PATH,
  OAUTH2_PROXY_TARGET_GROUP_NAME,
  TARGET_GROUPS,
  TARGET_GROUP_DEREGISTRATION_DELAY_SECONDS,
  TARGET_GROUP_HEALTHY_THRESHOLD,
  TARGET_GROUP_HEALTH_CHECK_INTERVAL_SECONDS,
  TARGET_GROUP_HEALTH_CHECK_TIMEOUT_SECONDS,
  TARGET_GROUP_UNHEALTHY_THRESHOLD,
  HEALTH_PATH_PATTERNS,
  HEALTH_RULE_PRIORITY,
  TLS_POLICY,
} from "./ingress";
import {
  BIFROST_PORT,
  HTTP_PORT,
  HTTPS_PORT,
  OAUTH2_PROXY_PORT,
} from "./network";

/**
 * The ingress module's constants, checked without standing up a Pulumi
 * resource. The resources themselves are exercised by the CI `pulumi preview`
 * on the pull request; what a unit test can usefully pin is the name, the two
 * target group ports and health checks, and the wiring back into `index.ts`
 * and `network.ts` that the plan depends on.
 */

const INGRESS_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "ingress.ts"),
  "utf8",
);
const INDEX_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "index.ts"),
  "utf8",
);

/**
 * The source of one named resource's constructor call, from its logical-name
 * literal to the next `new aws.` (or the end of the file). Enough to tell
 * whether an argument belongs to that resource rather than a sibling, which a
 * bare `includes` on the whole file cannot.
 */
const resourceBlock = (logicalName: string): string => {
  const marker = `"${logicalName}"`;
  const start = INGRESS_SOURCE.indexOf(marker);
  assert.ok(start >= 0, `ingress.ts has no resource named ${logicalName}`);
  const rest = INGRESS_SOURCE.slice(start);
  const next = rest.indexOf("new aws.", 1);
  return next >= 0 ? rest.slice(0, next) : rest;
};

describe("bifrost ingress", () => {
  it("names the gateway under the delegated workbench zone", () => {
    assert.equal(BIFROST_HOSTNAME, "bifrost.workbench.goodparty.org");
    // Derived, not spelled twice: a zone rename must move the record with it.
    assert.equal(BIFROST_HOSTNAME, `bifrost.${WORKBENCH_ZONE_NAME}`);
  });

  it("has one target group per container, with the upstream health checks", () => {
    assert.deepEqual(
      TARGET_GROUPS.map((group) => ({
        name: group.name,
        port: group.port,
        path: group.healthCheckPath,
      })),
      [
        { name: "bifrost", port: BIFROST_PORT, path: "/health" },
        {
          name: "bifrost-oauth2-proxy",
          port: OAUTH2_PROXY_PORT,
          path: "/ping",
        },
      ],
    );
    assert.equal(BIFROST_TARGET_GROUP_NAME, "bifrost");
    assert.equal(OAUTH2_PROXY_TARGET_GROUP_NAME, "bifrost-oauth2-proxy");
    assert.equal(BIFROST_HEALTH_CHECK_PATH, "/health");
    assert.equal(OAUTH2_PROXY_HEALTH_CHECK_PATH, "/ping");
  });

  it("listens on the ports item 5 pinned for the listeners", () => {
    assert.equal(HTTP_PORT, 80);
    assert.equal(HTTPS_PORT, 443);
  });

  it("takes the target group ports from network.ts rather than a second copy", () => {
    // The port literals live in network.ts; this module must import them, or
    // the target group and the security group that admits the ALB would agree
    // only by coincidence.
    for (const name of [
      "BIFROST_PORT",
      "OAUTH2_PROXY_PORT",
      "HTTP_PORT",
      "HTTPS_PORT",
    ]) {
      assert.ok(
        INGRESS_SOURCE.includes(name),
        `ingress.ts does not reference ${name} from network.ts`,
      );
    }
  });

  it("keeps the ALB and target group names inside AWS's 32-character limit", () => {
    assert.ok(BIFROST_ALB_NAME.length <= 32, BIFROST_ALB_NAME);
    assert.match(BIFROST_ALB_NAME, /^[a-zA-Z0-9-]+$/);
    for (const group of TARGET_GROUPS) {
      assert.ok(
        group.name.length <= 32,
        `${group.name} is longer than 32 characters`,
      );
      assert.match(group.name, /^[a-zA-Z0-9-]+$/);
    }
  });

  it("sets an ALB idle timeout long enough for time-to-first-token", () => {
    // AWS's default is 60 seconds, which a thinking model can exceed before
    // its first token; the ALB would then 504 the request.
    assert.equal(ALB_IDLE_TIMEOUT_SECONDS, 3600);
    assert.ok(ALB_IDLE_TIMEOUT_SECONDS > 60);
    // The ALB's maximum, so a future edit cannot set something AWS rejects.
    assert.ok(ALB_IDLE_TIMEOUT_SECONDS <= 4000);
    assert.ok(
      INGRESS_SOURCE.includes("idleTimeout: ALB_IDLE_TIMEOUT_SECONDS"),
      "the ALB must set idleTimeout from ALB_IDLE_TIMEOUT_SECONDS",
    );
  });

  it("keeps the replacement gap short: the target group timing is pinned", () => {
    // The provider defaults are 300s of deregistration and 30s-interval checks
    // with three successes. The service is stop-before-start, so the first is
    // most of a seven-and-a-half-minute 503 on every apply and the second adds
    // another 60 to 90 seconds. Both are pinned so a change to the outage shape
    // is a visible diff.
    assert.equal(TARGET_GROUP_DEREGISTRATION_DELAY_SECONDS, 30);
    assert.ok(
      TARGET_GROUP_DEREGISTRATION_DELAY_SECONDS < 300,
      "the deregistration delay must be well below the 300s default",
    );
    assert.equal(TARGET_GROUP_HEALTH_CHECK_INTERVAL_SECONDS, 10);
    assert.equal(TARGET_GROUP_HEALTH_CHECK_TIMEOUT_SECONDS, 5);
    assert.equal(TARGET_GROUP_HEALTHY_THRESHOLD, 2);
    assert.equal(TARGET_GROUP_UNHEALTHY_THRESHOLD, 3);

    for (const setting of [
      "deregistrationDelay: TARGET_GROUP_DEREGISTRATION_DELAY_SECONDS",
      "interval: TARGET_GROUP_HEALTH_CHECK_INTERVAL_SECONDS",
      "timeout: TARGET_GROUP_HEALTH_CHECK_TIMEOUT_SECONDS",
      "healthyThreshold: TARGET_GROUP_HEALTHY_THRESHOLD",
      "unhealthyThreshold: TARGET_GROUP_UNHEALTHY_THRESHOLD",
    ]) {
      assert.ok(
        INGRESS_SOURCE.includes(setting),
        `ingress.ts does not set ${setting}`,
      );
    }

    // Every group gets the same timing: the sidecar sits in front of the admin
    // surface, so a slow group there is the same outage by another name.
    assert.equal(TARGET_GROUPS.length, 2);
  });

  it("raises the listener TLS floor above the provider default", () => {
    assert.equal(TLS_POLICY, "ELBSecurityPolicy-TLS13-1-2-2021-06");
  });

  it("is wired into index.ts with the network and the zone", () => {
    assert.ok(
      INDEX_SOURCE.includes("createBifrostIngress"),
      "index.ts does not create the ingress",
    );
    assert.ok(
      INDEX_SOURCE.includes("zone: workbenchZone"),
      "index.ts does not pass the workbench zone to the ingress",
    );
    assert.ok(
      INDEX_SOURCE.includes("network,"),
      "index.ts does not pass the item 5 network to the ingress",
    );
  });

  it("fails closed: the HTTPS default action points at oauth2-proxy, not Bifrost", () => {
    // Item 9 adds the path rules below, and none of them re-points the default.
    // An unmatched path still goes through the authenticating proxy, so there
    // is no path on this listener that reaches Bifrost without oauth2-proxy
    // deciding first.
    const httpsBlock = resourceBlock("bifrostHttpsListener");
    const defaultActions = httpsBlock.match(
      /defaultActions:\s*\[([\s\S]*?)\n\s*\],/,
    );
    assert.ok(defaultActions, "the HTTPS listener must declare defaultActions");
    assert.ok(
      defaultActions[1].includes("targetGroupArn: oauth2ProxyTargetGroup.arn"),
      "the HTTPS listener default action must forward to oauth2-proxy",
    );
    assert.ok(
      !defaultActions[1].includes("bifrostTargetGroup"),
      "the HTTPS listener default action must never forward to Bifrost",
    );
  });

  it("splits the admin surface from inference by path, as the plan specifies", () => {
    // The routing table in "Protecting the admin surface": `/oauth2/*` and the
    // admin paths to the proxy on 4180, the inference prefixes to Bifrost on
    // 8080, and `/health` to Bifrost so a harness and the ALB health check
    // never meet a browser redirect. `/metrics` is not routed directly: with
    // Bifrost's dashboard auth off it has no credential of its own, so it falls
    // to the proxy default instead.
    assert.deepEqual(
      HTTPS_LISTENER_RULES.map((rule) => ({
        key: rule.key,
        priority: rule.priority,
        paths: [...rule.pathPatterns],
        target: rule.target,
      })),
      [
        {
          key: "oauth2Callback",
          priority: OAUTH2_CALLBACK_RULE_PRIORITY,
          paths: ["/oauth2/*"],
          target: "oauth2Proxy",
        },
        {
          key: "admin",
          priority: ADMIN_RULE_PRIORITY,
          paths: ["/", "/api/*"],
          target: "oauth2Proxy",
        },
        {
          key: "inference",
          priority: INFERENCE_RULE_PRIORITY,
          paths: ["/v1/*", "/anthropic/*", "/openai/*", "/genai/*"],
          target: "bifrost",
        },
        {
          key: "health",
          priority: HEALTH_RULE_PRIORITY,
          paths: ["/health"],
          target: "bifrost",
        },
      ],
    );
    // Priorities are unique, which ALB requires on a listener, and ascending in
    // the order above.
    const priorities = HTTPS_LISTENER_RULES.map((rule) => rule.priority);
    assert.equal(new Set(priorities).size, priorities.length);
    assert.deepEqual(priorities, [...priorities].sort((a, b) => a - b));
  });

  it("leaves no admin or login path that reaches Bifrost without oauth2-proxy", () => {
    // The property the fail-closed default buys: the only paths that reach
    // Bifrost directly are the enumerated inference ones plus `/health`, and
    // none of them is the admin surface, a login endpoint or `/metrics`.
    // `/health` is the one deliberate exception (the ALB's own health check
    // needs it unauthenticated), not a bypass.
    const bifrostPaths = HTTPS_LISTENER_RULES.filter(
      (rule) => rule.target === "bifrost",
    ).flatMap((rule) => [...rule.pathPatterns]);
    assert.deepEqual(
      [...bifrostPaths].sort(),
      [
        "/genai/*",
        "/health",
        "/openai/*",
        "/v1/*",
        "/anthropic/*",
      ].sort(),
    );
    for (const forbidden of ["/", "/api/*", "/oauth2/*"]) {
      assert.ok(
        !bifrostPaths.includes(forbidden),
        `${forbidden} must go through oauth2-proxy, not straight to Bifrost`,
      );
    }

    // And the proxy rules cover the admin surface and the login endpoints.
    const proxyPaths = HTTPS_LISTENER_RULES.filter(
      (rule) => rule.target === "oauth2Proxy",
    ).flatMap((rule) => [...rule.pathPatterns]);
    assert.deepEqual(
      [...proxyPaths].sort(),
      ["/", "/api/*", "/oauth2/*"].sort(),
    );
    assert.deepEqual(
      [...ADMIN_PATH_PATTERNS],
      ["/", "/api/*"],
    );
    assert.deepEqual([...OAUTH2_CALLBACK_PATH_PATTERNS], ["/oauth2/*"]);
    assert.deepEqual([...INFERENCE_PATH_PATTERNS], [
      "/v1/*",
      "/anthropic/*",
      "/openai/*",
      "/genai/*",
    ]);
    assert.deepEqual([...HEALTH_PATH_PATTERNS], ["/health"]);

    // An ALB path-pattern condition accepts at most five values; more is an
    // apply-time error rather than a routing surprise.
    for (const rule of HTTPS_LISTENER_RULES) {
      assert.ok(
        rule.pathPatterns.length <= 5,
        `${rule.key} has ${rule.pathPatterns.length} path values; ALB allows at most 5`,
      );
    }
  });

  it("fails if any listener rule sends a non-inference path directly to Bifrost", () => {
    // The edge invariant this change rests on. With `governance.auth_config`
    // disabled, Bifrost's own dashboard auth no longer gates anything, so a
    // path that reaches 8080 directly is a path whose only credential is a
    // virtual key — or nothing at all. The allowed direct paths are therefore
    // enumerated here by hand, in the plan's terms, and never computed by
    // subtracting the admin paths from the rule table: a route added at a
    // Bifrost bump has to be argued for in this list, which is the review the
    // test exists to force.
    const ALLOWED_DIRECT_TO_BIFROST = [
      // Inference: the four provider-shaped prefixes the harness table names,
      // each gated by `client.enforce_auth_on_inference: true`.
      "/v1/*",
      "/anthropic/*",
      "/openai/*",
      "/genai/*",
      // The one allowed exception: the ALB's target-group health check cannot
      // authenticate, and Bifrost whitelists `/health` itself.
      "/health",
    ] as const;

    const directPaths = HTTPS_LISTENER_RULES.filter(
      (rule) => rule.target === "bifrost",
    ).flatMap((rule) => [...rule.pathPatterns]);
    assert.deepEqual(
      [...directPaths].sort(),
      [...ALLOWED_DIRECT_TO_BIFROST].sort(),
      "a listener rule sends a path to Bifrost that is not one of the enumerated direct paths",
    );

    // The other direction, enumerated too: every prefix Bifrost registers that
    // is not inference, and therefore must never be direct. `/metrics` is the
    // one this change removed; the rest are Bifrost's own admin and transport
    // surfaces, which the HTTPS listener's default action sends to the proxy.
    // The list is read from the pinned tag's route registrations
    // (`transports/bifrost-http` at `v2.3.0`, recorded in the PR body).
    for (const forbidden of [
      "/metrics",
      "/api/*",
      "/",
      "/oauth2/*",
      "/ws",
      "/mcp",
      "/mcp/*",
      "/realtime",
      "/agents/a2a/*",
      "/.well-known/*",
      "/cursor/*",
      "/litellm/*",
      "/cohere/*",
      "/langchain/*",
      "/pydanticai/*",
      "/bedrock/*",
      "/typesafe/*",
      "/openai_passthrough/*",
      "/anthropic_passthrough/*",
      "/genai_passthrough/*",
      "/chatgpt_passthrough/*",
      "/azure_passthrough/*",
      "/runware_passthrough/*",
    ]) {
      assert.ok(
        !directPaths.includes(forbidden),
        `${forbidden} must go through oauth2-proxy, not straight to Bifrost`,
      );
    }

    // The failure direction stays closed: a path no rule matches is the
    // listener's default action, and that action is the proxy. Without this
    // half, removing a direct rule would not make a path safe — it would only
    // make the next rule the one that leaks.
    const httpsBlock = resourceBlock("bifrostHttpsListener");
    const defaultActions = httpsBlock.match(
      /defaultActions:\s*\[([\s\S]*?)\n\s*\],/,
    );
    assert.ok(defaultActions, "the HTTPS listener must declare defaultActions");
    assert.ok(
      defaultActions[1].includes("targetGroupArn: oauth2ProxyTargetGroup.arn"),
      "the default action must forward to oauth2-proxy",
    );
    assert.ok(
      !defaultActions[1].includes("bifrostTargetGroup"),
      "the default action must never forward to Bifrost",
    );

    // And the rules themselves come only from the table above: a rule created
    // with a literal path in the resource call would bypass this whole test.
    assert.ok(
      INGRESS_SOURCE.includes(
        "conditions: [{ pathPattern: { values: [...spec.pathPatterns] } }]",
      ),
      "listener rules must take their paths from HTTPS_LISTENER_RULES, not from a literal that this test cannot see",
    );
    assert.equal(
      INGRESS_SOURCE.match(/new aws\.lb\.ListenerRule\(/g)?.length,
      1,
      "there must be exactly one ListenerRule construction, mapped over HTTPS_LISTENER_RULES",
    );
  });

  it("creates the rules against the listener and both target groups", () => {
    // The rules are what make the two target groups attachable: ECS refuses to
    // register a target into a group no listener or rule references, which is
    // why item 8 could not register at all.
    assert.ok(
      INGRESS_SOURCE.includes("new aws.lb.ListenerRule("),
      "ingress.ts does not create the listener rules",
    );
    assert.ok(
      INGRESS_SOURCE.includes("listenerArn: httpsListener.arn"),
      "the rules must attach to the HTTPS listener",
    );
    assert.ok(
      INGRESS_SOURCE.includes("priority: spec.priority"),
      "the rules must use the priorities in HTTPS_LISTENER_RULES",
    );
    assert.ok(
      INGRESS_SOURCE.includes("targetGroupArn: ruleTargetGroupArns[spec.target]"),
      "each rule must forward to the target group its spec names",
    );
    // Both groups are named by the mapping, so no rule can accidentally point
    // at a third target or at a string literal.
    assert.ok(
      INGRESS_SOURCE.includes("bifrost: bifrostTargetGroup.arn") &&
        INGRESS_SOURCE.includes("oauth2Proxy: oauth2ProxyTargetGroup.arn"),
      "the rule target mapping must name both target groups",
    );
    // The rules are returned, because the ECS service takes them as an explicit
    // dependency before it registers the task.
    assert.ok(INGRESS_SOURCE.includes("listenerRules,"));
  });

  it("pins both Route 53 records to the workbench zone", () => {
    // Assert each named resource's own argument block, not a bare substring:
    // a whole-file `includes` would still pass if the validation record dropped
    // the zone and only the alias kept it, and a validation record in the wrong
    // zone leaves the certificate pending forever.
    for (const logicalName of [
      "bifrostCertificateValidationRecord",
      "bifrostAliasRecord",
    ]) {
      assert.ok(
        resourceBlock(logicalName).includes("zoneId: zone.zoneId"),
        `${logicalName} is not created in the workbench zone`,
      );
    }
    assert.ok(
      INGRESS_SOURCE.includes("validationRecordFqdns: [validationRecord.fqdn]"),
      "the certificate validation must reference the record's fqdn, or Pulumi can create the listener before ACM has validated",
    );
  });
});
