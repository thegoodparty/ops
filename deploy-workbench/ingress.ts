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
 * What this module owns, and what it deliberately leaves to later items:
 *
 * - Owns: the internet-facing Application Load Balancer, its two target groups
 *   (Bifrost on 8080, oauth2-proxy on 4180), the HTTPS listener with the ACM
 *   certificate, the HTTP listener that redirects to HTTPS, the ACM
 *   certificate and its DNS validation record in the workbench zone, and the
 *   Route 53 alias for `bifrost.workbench.goodparty.org`.
 * - Does not own: the path rules that split inference from the admin surface
 *   (item 9). The HTTPS listener has a default action because a listener must
 *   have one; it forwards to Bifrost, the gateway target, so the endpoint is
 *   reachable as soon as item 8 registers the task. Item 9 adds the
 *   `/oauth2/*`, admin-path and inference-prefix rules on top, and is the item
 *   that decides whether the catch-all stays on Bifrost or moves to
 *   oauth2-proxy. Neither target group has targets until item 8.
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
   * HTTPS. The default action forwards to Bifrost; the path rules that split
   * inference from the admin surface are item 9's, and this is the target that
   * makes the gateway reachable before those rules exist. See the module
   * comment.
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
          targetGroupArn: bifrostTargetGroup.arn,
        },
      ],
    },
    { provider },
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
   * The object index.ts binds and item 9 consumes. The two target groups are
   * what the ECS service registers against; the ALB, listeners and record are
   * returned so a later change has the ingress in hand rather than reaching
   * back into this module.
   */
  return {
    loadBalancer,
    bifrostTargetGroup,
    oauth2ProxyTargetGroup,
    certificate,
    certificateValidation,
    httpsListener,
    httpListener,
    dnsRecord,
  };
};
