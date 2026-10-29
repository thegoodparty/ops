import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

/**
 * How the mint Lambda finds the Bifrost task, and why this exists at all.
 *
 * Step 3 of `docs/bifrost-virtual-keys.md` says the function "calls the task on
 * 8080 directly" — `/api` through the ALB is behind oauth2-proxy and Google
 * SSO, which a Lambda cannot pass (decision 3). What step 3's plan did not
 * name is the address: the task's ENI private IP changes on every replacement
 * (the service is stop-before-start, so every deploy), so a literal IP in the
 * function's environment is a mint that breaks at the next deploy, and the
 * task's `privateDnsName` is `ip-10-0-11-135...`, i.e. the IP again.
 *
 * The deployment has no service discovery today: `docs/bifrost-gateway.md`
 * records "no service discovery" as a *deliberate* choice, but for the
 * ALB-to-sidecar hop, where the two containers share one network namespace and
 * `127.0.0.1:8080` is the answer. Nothing reaches the task from outside that
 * namespace, which is exactly what the mint has to do. So this module adds the
 * smallest mechanism that gives the task a stable name inside the VPC:
 *
 * - a Cloud Map private DNS namespace, `workbench.local`, in this VPC;
 * - one Cloud Map service, `bifrost`, with A records;
 * - and the ECS service registers itself into it (`serviceRegistries` in
 *   `ecs.ts`), so the record follows the task across replacements.
 *
 * The result is `bifrost.workbench.local:8080`, which resolves only inside the
 * VPC (the namespace is private), so the gateway's admin API stays reachable
 * exactly where it was: from the private subnets, and not from the internet.
 * The security group rule is still the thing that decides who may connect
 * (`bifrost-vk-mint.ts`'s ingress rule on `bifrost-task`); DNS is not a control.
 *
 * Alternatives considered and rejected, recorded so the next reader does not
 * re-derive them:
 *
 * - **The ALB.** `/api` is routed to oauth2-proxy by design, and a rule that
 *   sent `/api/governance/*` straight to Bifrost would be a public path to the
 *   admin API — the opposite of what the setup lock exists for.
 * - **Look the task's IP up at run time** through `ecs:DescribeTasks` plus
 *   `ec2:DescribeNetworkInterfaces`. It works, but it puts two more grants on
 *   the function, adds a cache whose invalidation is the interesting part, and
 *   makes the mint depend on the ECS control plane being reachable from the
 *   VPC. A DNS record maintained by the scheduler is the same information with
 *   neither.
 * - **A second, internal ALB.** A whole load balancer to front one task from
 *   one caller; the task group's cost and the listener wiring are the reason
 *   not to.
 *
 * The TTL is 10 seconds because a replacement changes the answer: the task
 * stops before its successor starts, so a stale record is already a
 * connection refused and 10 seconds is short enough that the mint's retry (a
 * second call, a minute later, from the cache's perspective) sees the new one.
 */

/** The private namespace. Private to this VPC; not resolvable from outside it. */
export const BIFROST_DISCOVERY_NAMESPACE = "workbench.local";

/** The Cloud Map service name, and the ECS service's name. */
export const BIFROST_DISCOVERY_SERVICE_NAME = "bifrost";

/**
 * The name the mint Lambda calls. `bifrost.workbench.local` inside the VPC only
 * — the port is `network.ts`'s `BIFROST_PORT`, appended by the caller so the
 * two cannot disagree.
 */
export const BIFROST_DISCOVERY_DNS_NAME = `${BIFROST_DISCOVERY_SERVICE_NAME}.${BIFROST_DISCOVERY_NAMESPACE}`;

/** Long enough to notice a replacement, short enough that it costs one retry. */
export const BIFROST_DISCOVERY_TTL_SECONDS = 10;

export const createBifrostDiscovery = (args: {
  provider: aws.Provider;
  vpcId: pulumi.Input<string>;
}) => {
  const { provider, vpcId } = args;
  const tags = { Name: BIFROST_DISCOVERY_DNS_NAME };

  // `PrivateDnsNamespace` creates and owns the Route 53 private hosted zone;
  // nothing here declares a zone, so there is no second thing to clean up.
  const namespace = new aws.servicediscovery.PrivateDnsNamespace(
    "bifrostDiscoveryNamespace",
    {
      name: BIFROST_DISCOVERY_NAMESPACE,
      description:
        "Private DNS for the Bifrost task in the workbench VPC: how the vk-mint Lambda reaches the gateway's admin API on 8080 (step 3 of docs/bifrost-virtual-keys.md).",
      vpc: vpcId,
      tags,
    },
    { provider },
  );

  // A records, because the caller wants an address and not a hostname/port
  // pair (SRV). Fargate's awsvpc tasks register their ENI address, which is
  // what the Lambda's security-group rule admits.
  const service = new aws.servicediscovery.Service(
    "bifrostDiscoveryService",
    {
      name: BIFROST_DISCOVERY_SERVICE_NAME,
      description:
        "The Bifrost task's own address in the workbench VPC. Registered by the ECS service; consumed by the vk-mint Lambda.",
      dnsConfig: {
        namespaceId: namespace.id,
        dnsRecords: [
          { ttl: BIFROST_DISCOVERY_TTL_SECONDS, type: "A" },
        ],
      },
      // ECS registers and deregisters the task through Cloud Map, which uses
      // the custom-health-check configuration: a task that stops updating is
      // marked unhealthy, and a replacement is registered without waiting for
      // a DNS TTL alone. One failure is enough for a single-task service —
      // there is no second instance to hide behind, and the task's own ECS
      // health check is what decides.
      healthCheckCustomConfig: { failureThreshold: 1 },
      tags,
    },
    { provider },
  );

  return { namespace, service, dnsName: BIFROST_DISCOVERY_DNS_NAME };
};

export type BifrostDiscovery = ReturnType<typeof createBifrostDiscovery>;
