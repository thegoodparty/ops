import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { WORKBENCH_ZONE_NAME } from "./dns";
import {
  BIFROST_PORT,
  createWorkbenchNetwork,
  HTTP_PORT,
  HTTPS_PORT,
  OAUTH2_PROXY_PORT,
} from "./network";

/**
 * The ingress the Bifrost gateway is reached through. Phase 1 item 6 of
 * `docs/bifrost-gateway.md`; the "TLS and DNS" part of its "Network, TLS and
 * ingress" section is the requirement this file implements.
 *
 * What this module owns:
 *
 * - Owns: the internet-facing Application Load Balancer, its two target groups
 *   (Bifrost on 8080, oauth2-proxy on 4180), the HTTPS listener with the ACM
 *   certificate, the HTTP listener that redirects to HTTPS, the ACM
 *   certificate and its DNS validation record in the workbench zone, and the
 *   Route 53 alias for `bifrost.workbench.goodparty.org`.
 * - Owns since item 9: the four HTTPS listener rules that split inference from
 *   the admin surface — `/oauth2/*` and the admin paths to oauth2-proxy, the
 *   inference prefixes and health/metrics to Bifrost — and the rule set that
 *   makes both target groups associated with a listener, which is what lets
 *   item 9 register the ECS task against them.
 *
 * The HTTPS listener's default action still points at oauth2-proxy and is not
 * re-pointed by the rules. That keeps the fail-closed property the rules
 * inherit: a path no rule matches still goes through the authenticating proxy,
 * never straight to Bifrost, and Bifrost is reachable only on the paths the
 * rules enumerate below. Item 8 could not register the task because no rule
 * referenced either group; item 9 supplies the rules and the registration
 * together.
 *
 * Everything takes the explicit provider this project requires. The workbench
 * stack disables the default provider (`deploy.sh`), so a resource that omits
 * `{ provider }` fails the apply rather than landing in the management account.
 */

/**
 * The network phase 1 item 5 created. The ALB takes its subnets and its
 * security group from here rather than re-creating either; the shape comes
 * from the module's return type so the two cannot drift.
 */
type WorkbenchNetwork = ReturnType<typeof createWorkbenchNetwork>;

/**
 * The public name, derived from the zone name rather than spelled twice. The
 * zone is `workbench.goodparty.org` (`dns.ts`), delegated from the production
 * zone; this record is the only name in the account so far.
 */
export const BIFROST_HOSTNAME = `bifrost.${WORKBENCH_ZONE_NAME}`;

/**
 * The health checks the target groups use. Bifrost serves `/health`; the
 * oauth2-proxy sidecar serves `/ping`. Both are the upstream images' own
 * liveness endpoints, not paths this repo invents, so they cannot drift from
 * the containers' behavior.
 */
export const BIFROST_HEALTH_CHECK_PATH = "/health";
export const OAUTH2_PROXY_HEALTH_CHECK_PATH = "/ping";

/** ALB and target group names; account-unique and <= 32 characters. */
export const BIFROST_ALB_NAME = "bifrost";
export const BIFROST_TARGET_GROUP_NAME = "bifrost";
export const OAUTH2_PROXY_TARGET_GROUP_NAME = "bifrost-oauth2-proxy";

/**
 * The target groups, in the same shape `network.ts` uses for `SUBNETS`: a
 * table the test can pin and the create function can map over, so the port a
 * group listens on is the one the security group and the task definition
 * agree with rather than a second copy.
 *
 * `targetType: "ip"` is what Fargate needs: an `awsvpc` task has no instance
 * to register, only an elastic network interface with a private IP.
 */
export type TargetGroupSpec = {
  /** Logical-name fragment for the Pulumi resource. */
  key: string;
  /** ALB target group name. */
  name: string;
  port: number;
  healthCheckPath: string;
};

/**
 * The HTTPS listener's path rules, as data.
 *
 * Item 9's routing, from "Protecting the admin surface" in
 * `docs/bifrost-gateway.md`:
 *
 * - `/oauth2/*` is oauth2-proxy's own endpoints (login start, Google callback,
 *   sign-out). It has to reach the proxy without a session, which is why it is
 *   its own rule rather than part of the catch-all.
 * - The admin surface — Bifrost's dashboard at `/` and its management API at
 *   `/api/*` — is oauth2-proxy's, so a browser or a script is authenticated
 *   before Bifrost ever sees the request. The HTTPS listener's default action
 *   already points there; the explicit rule is what makes the intent visible
 *   and what the "nothing bypasses oauth2-proxy" test asserts against, rather
 *   than relying on a default nobody reads.
 * - The inference prefixes go straight to Bifrost, so a harness never meets a
 *   browser redirect. These are the four provider-shaped paths in the plan's
 *   harness table.
 * - `/health` and `/metrics` also belong on Bifrost: `/health` is item 12's
 *   end-to-end proof through the ALB, and `/metrics` is scraped without a
 *   Google session and stays on Bifrost's own basic auth (plan,
 *   "Observability"). They are a separate rule from the inference prefixes
 *   because an ALB `path-pattern` condition accepts at most five values.
 *
 * Priorities are explicit and ascending in the order above; the paths are
 * disjoint, so the order is documentation rather than a precedence
 * requirement. `HTTPS_LISTENER_RULES` is exported so the test can pin every
 * priority, path pattern and target without parsing the resource calls.
 */
export const OAUTH2_CALLBACK_PATH_PATTERNS = ["/oauth2/*"] as const;
export const ADMIN_PATH_PATTERNS = ["/", "/api/*"] as const;
export const INFERENCE_PATH_PATTERNS = [
  "/v1/*",
  "/anthropic/*",
  "/openai/*",
  "/genai/*",
] as const;
export const TELEMETRY_PATH_PATTERNS = ["/health", "/metrics"] as const;

export const OAUTH2_CALLBACK_RULE_PRIORITY = 10;
export const ADMIN_RULE_PRIORITY = 20;
export const INFERENCE_RULE_PRIORITY = 30;
export const TELEMETRY_RULE_PRIORITY = 40;

/** Which target group a rule forwards to, by the key `TARGET_GROUPS` uses. */
export type ListenerRuleTarget = "bifrost" | "oauth2Proxy";

export type ListenerRuleSpec = {
  /** Logical-name fragment for the Pulumi `ListenerRule` resource. */
  key: string;
  priority: number;
  pathPatterns: readonly string[];
  target: ListenerRuleTarget;
};

export const HTTPS_LISTENER_RULES: ListenerRuleSpec[] = [
  {
    key: "oauth2Callback",
    priority: OAUTH2_CALLBACK_RULE_PRIORITY,
    pathPatterns: OAUTH2_CALLBACK_PATH_PATTERNS,
    target: "oauth2Proxy",
  },
  {
    key: "admin",
    priority: ADMIN_RULE_PRIORITY,
    pathPatterns: ADMIN_PATH_PATTERNS,
    target: "oauth2Proxy",
  },
  {
    key: "inference",
    priority: INFERENCE_RULE_PRIORITY,
    pathPatterns: INFERENCE_PATH_PATTERNS,
    target: "bifrost",
  },
  {
    key: "telemetry",
    priority: TELEMETRY_RULE_PRIORITY,
    pathPatterns: TELEMETRY_PATH_PATTERNS,
    target: "bifrost",
  },
];

export const TARGET_GROUPS: TargetGroupSpec[] = [
  {
    key: "bifrost",
    name: BIFROST_TARGET_GROUP_NAME,
    port: BIFROST_PORT,
    healthCheckPath: BIFROST_HEALTH_CHECK_PATH,
  },
  {
    key: "oauth2Proxy",
    name: OAUTH2_PROXY_TARGET_GROUP_NAME,
    port: OAUTH2_PROXY_PORT,
    healthCheckPath: OAUTH2_PROXY_HEALTH_CHECK_PATH,
  },
];

/**
 * The listener's TLS policy.
 *
 * The provider's default is `ELBSecurityPolicy-2016-08`, which still offers
 * TLS 1.0. This is a public endpoint that every coding harness depends on, and
 * the harnesses are all modern clients, so the floor is raised to TLS 1.2 with
 * TLS 1.3 offered. Pinned by name rather than left to the default for the same
 * reason the region and the account are constants: the default can move, and a
 * silent downgrade of a public listener is not something to discover later.
 */
export const TLS_POLICY = "ELBSecurityPolicy-TLS13-1-2-2021-06";

/**
 * The ALB's idle timeout.
 *
 * AWS's default is 60 seconds, which is far too short for this endpoint. The
 * ALB fronts a model gateway, and a thinking model can spend minutes before
 * the first token, during which the connection carries no bytes at all; at 60
 * seconds the ALB closes it with a 504 before any output arrives. The timeout
 * has to cover time-to-first-token, not the whole response: once tokens stream
 * the connection is not idle and the timer resets.
 *
 * One hour. `docs/bifrost-gateway.md` names no figure, so this is chosen to
 * exceed any realistic time-to-first-token by an order of magnitude, while
 * stopping short of the 4000-second ALB maximum, which would hold a dead
 * connection for over an hour. It also matches the ALB's own `clientKeepAlive`
 * default of 3600, so the keep-alive cadence and the idle limit are the same
 * number. If a real request ever approaches it, it is a one-line change and
 * the maximum is 4000.
 */
export const ALB_IDLE_TIMEOUT_SECONDS = 3600;

export const createBifrostIngress = (args: {
  provider: aws.Provider;
  /** The workbench zone, phase 0 item 2; validation and the alias live in it. */
  zone: aws.route53.Zone;
  network: WorkbenchNetwork;
}) => {
  const { provider, zone, network } = args;

  /**
   * The ALB itself. Internet-facing, in the two public subnets, with the
   * security group item 5 created for exactly this. `internal` is spelled out
   * rather than left to the default because "is this reachable from the
   * internet" is the property the plan's threat model rests on: the endpoint is
   * public and the virtual key, not the network, is the control.
   */
  const loadBalancer = new aws.lb.LoadBalancer(
    "bifrostAlb",
    {
      name: BIFROST_ALB_NAME,
      loadBalancerType: "application",
      internal: false,
      // Sized for a thinking model's time-to-first-token; see the constant.
      idleTimeout: ALB_IDLE_TIMEOUT_SECONDS,
      securityGroups: [network.albSecurityGroup.id],
      subnets: network.publicSubnetIds,
      tags: { Name: BIFROST_ALB_NAME },
    },
    { provider },
  );

  const targetGroups = TARGET_GROUPS.map(
    (spec) =>
      new aws.lb.TargetGroup(
        `${spec.key}TargetGroup`,
        {
          name: spec.name,
          port: spec.port,
          protocol: "HTTP",
          // Fargate tasks are registered by IP; see the type comment above.
          targetType: "ip",
          vpcId: network.vpc.id,
          healthCheck: {
            path: spec.healthCheckPath,
            protocol: "HTTP",
            matcher: "200",
          },
          tags: { Name: spec.name },
        },
        { provider },
      ),
  );
  const [bifrostTargetGroup, oauth2ProxyTargetGroup] = targetGroups;

  /**
   * The certificate for the one name. DNS validation, not email: the
   * `workbench.goodparty.org` zone is this account's (`dns.ts`) and the NS
   * delegation from `goodparty.org` is live, so ACM can see the validation
   * record without a human clicking a link. Validation blocks the HTTPS
   * listener below: the listener references the validation resource's ARN, so
   * Pulumi does not create a listener against a certificate that is still
   * `PENDING_VALIDATION`.
   */
  const certificate = new aws.acm.Certificate(
    "bifrostCertificate",
    {
      domainName: BIFROST_HOSTNAME,
      validationMethod: "DNS",
      tags: { Name: BIFROST_HOSTNAME },
    },
    { provider },
  );

  /**
   * The one validation option a single-domain certificate produces. `apply`
   * rather than an index access because the options are known only after the
   * certificate is created; the three fields are read the same way.
   */
  const domainValidation = certificate.domainValidationOptions.apply(
    (options) => options[0],
  );

  const validationRecord = new aws.route53.Record(
    "bifrostCertificateValidationRecord",
    {
      zoneId: zone.zoneId,
      name: domainValidation.apply((option) => option.resourceRecordName),
      type: domainValidation.apply((option) => option.resourceRecordType),
      records: [
        domainValidation.apply((option) => option.resourceRecordValue),
      ],
      ttl: 60,
      // The record is not one we chose the name of, and a re-run can find a
      // stale one; overwrite rather than fail.
      allowOverwrite: true,
    },
    { provider },
  );

  const certificateValidation = new aws.acm.CertificateValidation(
    "bifrostCertificateValidation",
    {
      certificateArn: certificate.arn,
      validationRecordFqdns: [validationRecord.fqdn],
    },
    { provider },
  );

  /**
   * HTTPS. The default action points at oauth2-proxy, the plan's catch-all
   * ("everything else falls through to oauth2-proxy"), not at Bifrost. Item 9
   * adds the path rules below without re-pointing it, which is what keeps the
   * listener fail-closed: an unmatched path is still authenticated by the proxy
   * before it can reach the gateway, and Bifrost is reachable only on the
   * inference and telemetry paths the rules enumerate. There is deliberately
   * no rule that sends `/api/*` or the dashboard to Bifrost directly; that is
   * the bypass this default is here to prevent.
   */
  const httpsListener = new aws.lb.Listener(
    "bifrostHttpsListener",
    {
      loadBalancerArn: loadBalancer.arn,
      port: HTTPS_PORT,
      protocol: "HTTPS",
      certificateArn: certificateValidation.certificateArn,
      sslPolicy: TLS_POLICY,
      defaultActions: [
        {
          type: "forward",
          targetGroupArn: oauth2ProxyTargetGroup.arn,
        },
      ],
    },
    { provider },
  );

  /**
   * The path rules from `HTTPS_LISTENER_RULES`, created against the listener
   * above and the two target groups created above it.
   *
   * These are also what makes the target groups attachable: ECS's
   * `CreateService` refuses a target group that no listener or listener rule
   * references (`InvalidParameterException: The target group with targetGroupArn
   * ... does not have an associated load balancer`), which is why item 8 could
   * not register the task. The oauth2-proxy group is referenced by the
   * listener's default action and by the two proxy rules; the Bifrost group by
   * the inference and telemetry rules. `ecs.ts` takes these resources as a
   * dependency of the service so the rules exist before ECS registers the task,
   * rather than relying on Pulumi's incidental ordering.
   */
  const ruleTargetGroupArns: Record<ListenerRuleTarget, pulumi.Output<string>> =
    {
      bifrost: bifrostTargetGroup.arn,
      oauth2Proxy: oauth2ProxyTargetGroup.arn,
    };

  const listenerRules = HTTPS_LISTENER_RULES.map(
    (spec) =>
      new aws.lb.ListenerRule(
        `${spec.key}ListenerRule`,
        {
          listenerArn: httpsListener.arn,
          priority: spec.priority,
          conditions: [{ pathPattern: { values: [...spec.pathPatterns] } }],
          actions: [
            { type: "forward", targetGroupArn: ruleTargetGroupArns[spec.target] },
          ],
        },
        { provider },
      ),
  );

  /**
   * HTTP, redirecting to HTTPS. Nothing is served in the clear; the listener
   * exists so a harness that starts on `http://` is moved to the TLS endpoint
   * rather than timing out, and so the name does not answer with a connection
   * error over port 80.
   */
  const httpListener = new aws.lb.Listener(
    "bifrostHttpListener",
    {
      loadBalancerArn: loadBalancer.arn,
      port: HTTP_PORT,
      protocol: "HTTP",
      defaultActions: [
        {
          type: "redirect",
          redirect: {
            protocol: "HTTPS",
            port: String(HTTPS_PORT),
            statusCode: "HTTP_301",
            host: "#{host}",
            path: "/#{path}",
            query: "#{query}",
          },
        },
      ],
    },
    { provider },
  );

  /**
   * The alias. Route 53 points the name at the ALB's own name and zone id
   * rather than a copied IP, so the record follows the ALB across a
   * replacement. `evaluateTargetHealth` is on; an ALB alias is the documented
   * case where Route 53 can act on the load balancer's health.
   */
  const dnsRecord = new aws.route53.Record(
    "bifrostAliasRecord",
    {
      zoneId: zone.zoneId,
      name: BIFROST_HOSTNAME,
      type: "A",
      aliases: [
        {
          name: loadBalancer.dnsName,
          zoneId: loadBalancer.zoneId,
          evaluateTargetHealth: true,
        },
      ],
    },
    { provider },
  );

  /**
   * The object index.ts binds and `ecs.ts` consumes. The two target groups are
   * what the ECS service registers against, and `listenerRules` is what makes
   * them registrable; the ALB, listeners and record are returned so a later
   * change has the ingress in hand rather than reaching back into this module.
   */
  return {
    loadBalancer,
    bifrostTargetGroup,
    oauth2ProxyTargetGroup,
    listenerRules,
    certificate,
    certificateValidation,
    httpsListener,
    httpListener,
    dnsRecord,
  };
};

/** The ingress object `ecs.ts` consumes, so the two modules cannot drift. */
export type BifrostIngress = ReturnType<typeof createBifrostIngress>;
