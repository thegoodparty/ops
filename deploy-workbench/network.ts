import * as aws from "@pulumi/aws";

/**
 * The network the Bifrost gateway runs in. Phase 1 item 5 of
 * `docs/bifrost-gateway.md`; its "Network, TLS and ingress" section is the
 * requirement this file implements.
 *
 * What this module owns, and what it deliberately leaves to later items:
 *
 * - Owns: the VPC, two public subnets and two private subnets across two
 *   explicit availability zones, an internet gateway, one NAT gateway and
 *   its elastic IP, the public and private route tables and their
 *   associations, the RDS DB subnet group, and the three security groups.
 * - Does not own: the ALB, target groups, listeners, ACM certificate or
 *   Route 53 record (item 6); the RDS instance (item 7); the ECS cluster,
 *   task definition or service (item 8). The ALB security group is created
 *   now only so the task security group can reference it; nothing is
 *   attached to it yet.
 *
 * Everything takes the explicit provider that this project requires. The
 * workbench stack disables the default provider (`deploy.sh`), so a resource
 * that omits `{ provider }` fails the apply rather than landing in the
 * management account.
 */

/**
 * The one region the workbench SCP permits. Named rather than discovered, for
 * the same reason the account id is a constant: `DenyOutsideHomeRegion` in
 * `deploy-org/policies.ts` makes anything else an `AccessDenied`, and the
 * plan pins region and account explicitly everywhere else.
 */
export const REGION = "us-west-2";

/**
 * The account's VPC. It has only the AWS-created default VPC today; this is a
 * new one, because the default VPC's subnets are shared with whatever else
 * ever lands in the account and its CIDR is not ours to size.
 *
 * `/16` with `/24` per subnet is the layout the plan calls for. The numbers
 * are not shared with any other VPC this account can reach: the workbench SCP
 * denies cross-account access, so there is nothing to avoid colliding with,
 * and no peering is planned. Public subnets take the low `0.x` and private the
 * `10.x`, so the two halves of the VPC are distinguishable at a glance and
 * there is room to add a second pair of subnets without renumbering.
 */
export const VPC_CIDR = "10.0.0.0/16";

/**
 * The two availability zones, named rather than discovered.
 *
 * Discovered AZs would be account- and region-specific and would make a
 * subnet's CIDR depend on which zone `us-west-2a` happened to map to; the
 * repo pins account and region as constants for the same reason. Two zones
 * is what the ALB and the RDS subnet group require; the gateway is a single
 * Fargate task by design, so more zones buy nothing.
 */
export const AVAILABILITY_ZONES = ["us-west-2a", "us-west-2b"] as const;

/** One public and one private subnet per availability zone. */
export type SubnetSpec = {
  az: (typeof AVAILABILITY_ZONES)[number];
  /** Logical-name suffix, so the pair is `...A` and `...B` in state. */
  suffix: "A" | "B";
  publicCidr: string;
  privateCidr: string;
};

export const SUBNETS: SubnetSpec[] = [
  {
    az: "us-west-2a",
    suffix: "A",
    publicCidr: "10.0.0.0/24",
    privateCidr: "10.0.10.0/24",
  },
  {
    az: "us-west-2b",
    suffix: "B",
    publicCidr: "10.0.1.0/24",
    privateCidr: "10.0.11.0/24",
  },
];

/**
 * The container ports, named because the security groups, the task
 * definition (item 8) and the target groups (item 6) all have to agree on
 * them. Bifrost listens on 8080 and the oauth2-proxy sidecar on 4180, per
 * "Protecting the admin surface".
 */
export const BIFROST_PORT = 8080;
export const OAUTH2_PROXY_PORT = 4180;

/** The ALB listeners (item 6) and the database port (item 7). */
export const HTTP_PORT = 80;
export const HTTPS_PORT = 443;
export const POSTGRES_PORT = 5432;

/**
 * The name RDS gives the subnet group, and the one the item 7 instance will
 * reference. RDS subnet group names are account-unique and lowercase.
 */
export const DATABASE_SUBNET_GROUP_NAME = "bifrost-db";

export const createWorkbenchNetwork = (args: { provider: aws.Provider }) => {
  const { provider } = args;

  const vpc = new aws.ec2.Vpc(
    "workbenchVpc",
    {
      cidrBlock: VPC_CIDR,
      // Both on for the same reason: RDS and any future interface VPC
      // endpoint need the VPC's DNS to resolve, and an ALB target's
      // registered name is resolved through it.
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: { Name: "workbench" },
    },
    { provider },
  );

  /**
   * Public subnets carry the ALB. `mapPublicIpOnLaunch` is on because that is
   * what makes them public subnets rather than merely routed ones; the ALB's
   * own nodes do not need it, but a subnet with no route to an internet
   * gateway is the failure that is hard to see from a target group's health.
   */
  const publicSubnets = SUBNETS.map(
    (spec) =>
      new aws.ec2.Subnet(
        `workbenchPublicSubnet${spec.suffix}`,
        {
          vpcId: vpc.id,
          cidrBlock: spec.publicCidr,
          availabilityZone: spec.az,
          mapPublicIpOnLaunch: true,
          tags: { Name: `workbench-public-${spec.az}` },
        },
        { provider },
      ),
  );

  /**
   * Private subnets carry the Fargate task and the RDS instance. No public
   * IP, and the only route out is the NAT below.
   */
  const privateSubnets = SUBNETS.map(
    (spec) =>
      new aws.ec2.Subnet(
        `workbenchPrivateSubnet${spec.suffix}`,
        {
          vpcId: vpc.id,
          cidrBlock: spec.privateCidr,
          availabilityZone: spec.az,
          tags: { Name: `workbench-private-${spec.az}` },
        },
        { provider },
      ),
  );

  const internetGateway = new aws.ec2.InternetGateway(
    "workbenchInternetGateway",
    {
      vpcId: vpc.id,
      tags: { Name: "workbench" },
    },
    { provider },
  );

  /**
   * One NAT gateway, in the first public subnet, shared by both private
   * subnets.
   *
   * The plan offers "NAT (or VPC endpoints)"; NAT is the choice because the
   * task has to reach the model provider APIs, which are on the public
   * internet and no endpoint can front. ECR, Secrets Manager, CloudWatch and
   * S3 then ride the same route rather than needing four interface/gateway
   * endpoints and their grants.
   *
   * One, not one per AZ. The gateway is a single Fargate task by design (OSS
   * Bifrost is single-node), so a NAT failure and an AZ failure both take the
   * same one task down; a second NAT would roughly double the network cost to
   * protect an availability the workload cannot use. The account is
   * deliberately not SLO-bearing.
   */
  const natEip = new aws.ec2.Eip(
    "workbenchNatEip",
    {
      domain: "vpc",
      tags: { Name: "workbench-nat" },
    },
    { provider },
  );

  const natGateway = new aws.ec2.NatGateway(
    "workbenchNatGateway",
    {
      allocationId: natEip.allocationId,
      subnetId: publicSubnets[0].id,
      tags: { Name: "workbench-nat" },
    },
    {
      provider,
      // Explicit rather than inferred. A public NAT gateway needs the
      // internet gateway attached before it can be created, but nothing in
      // the NAT's own inputs references the IGW, so Pulumi could order the
      // create the other way and fail. The same ordering matters on destroy:
      // without this the IGW can be detached while the NAT still exists.
      // The route tables reference the IGW, but they are created after the
      // NAT and do not order it.
      dependsOn: [internetGateway],
    },
  );

  /**
   * Route tables. The public table sends everything to the internet gateway;
   * the private table sends everything to the NAT. Both subnets in a tier
   * share the one table, which is all the routing this topology needs.
   */
  const publicRouteTable = new aws.ec2.RouteTable(
    "workbenchPublicRouteTable",
    {
      vpcId: vpc.id,
      tags: { Name: "workbench-public" },
    },
    { provider },
  );

  new aws.ec2.Route(
    "workbenchPublicDefaultRoute",
    {
      routeTableId: publicRouteTable.id,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: internetGateway.id,
    },
    { provider },
  );

  const privateRouteTable = new aws.ec2.RouteTable(
    "workbenchPrivateRouteTable",
    {
      vpcId: vpc.id,
      tags: { Name: "workbench-private" },
    },
    { provider },
  );

  new aws.ec2.Route(
    "workbenchPrivateDefaultRoute",
    {
      routeTableId: privateRouteTable.id,
      destinationCidrBlock: "0.0.0.0/0",
      natGatewayId: natGateway.id,
    },
    { provider },
  );

  const publicRouteTableAssociations = publicSubnets.map(
    (subnet, index) =>
      new aws.ec2.RouteTableAssociation(
        `workbenchPublicRouteTableAssociation${SUBNETS[index].suffix}`,
        {
          subnetId: subnet.id,
          routeTableId: publicRouteTable.id,
        },
        { provider },
      ),
  );

  const privateRouteTableAssociations = privateSubnets.map(
    (subnet, index) =>
      new aws.ec2.RouteTableAssociation(
        `workbenchPrivateRouteTableAssociation${SUBNETS[index].suffix}`,
        {
          subnetId: subnet.id,
          routeTableId: privateRouteTable.id,
        },
        { provider },
      ),
  );

  /**
   * The DB subnet group RDS requires. It spans both private subnets, which is
   * what lets a future Multi-AZ instance fail over and what item 7 will
   * reference. Created here rather than in item 7 because it is a network
   * fact, not a database one, and because the RDS instance cannot be created
   * without it.
   */
  const databaseSubnetGroup = new aws.rds.SubnetGroup(
    "workbenchDatabaseSubnetGroup",
    {
      name: DATABASE_SUBNET_GROUP_NAME,
      description:
        "Private subnets for the Bifrost gateway's RDS instance (phase 1 item 7).",
      subnetIds: privateSubnets.map((subnet) => subnet.id),
      tags: { Name: DATABASE_SUBNET_GROUP_NAME },
    },
    { provider },
  );

  /**
   * Security groups.
   *
   * Each group is created bare and every rule is its own resource. That is
   * the provider's documented best practice, and here it is also what avoids
   * a reference cycle: the task group's ingress names the ALB group and the
   * ALB group's egress names the task group, so neither can be declared
   * entirely inside the other. `aws.vpc.SecurityGroup*Rule` resources carry
   * one CIDR or one referenced group each, which is also why they are used
   * instead of the older `aws.ec2.SecurityGroupRule`.
   *
   * With no inline rules, the provider removes the `ALLOW ALL` egress rule
   * AWS adds to every new group, so a group with no egress rule has none —
   * which is exactly what the database group wants.
   */
  const albSecurityGroup = new aws.ec2.SecurityGroup(
    "bifrostAlbSecurityGroup",
    {
      name: "bifrost-alb",
      description:
        "Bifrost gateway ALB: 80 and 443 from the internet. Phase 1 item 6 attaches the listeners.",
      vpcId: vpc.id,
      tags: { Name: "bifrost-alb" },
    },
    { provider },
  );

  const taskSecurityGroup = new aws.ec2.SecurityGroup(
    "bifrostTaskSecurityGroup",
    {
      name: "bifrost-task",
      description:
        "Bifrost gateway Fargate task: 8080 (Bifrost) and 4180 (oauth2-proxy) from the ALB only.",
      vpcId: vpc.id,
      tags: { Name: "bifrost-task" },
    },
    { provider },
  );

  const databaseSecurityGroup = new aws.ec2.SecurityGroup(
    "bifrostDatabaseSecurityGroup",
    {
      name: "bifrost-database",
      description:
        "Bifrost gateway RDS instance: 5432 from the task only, no egress.",
      vpcId: vpc.id,
      tags: { Name: "bifrost-database" },
    },
    { provider },
  );

  // ALB ingress: 443 and 80 from anywhere. 80 exists only to redirect to 443
  // (item 6); it is opened now so the listener can be added without touching
  // the group.
  new aws.vpc.SecurityGroupIngressRule(
    "bifrostAlbIngressHttps",
    {
      securityGroupId: albSecurityGroup.id,
      description: "https from the internet",
      ipProtocol: "tcp",
      fromPort: HTTPS_PORT,
      toPort: HTTPS_PORT,
      cidrIpv4: "0.0.0.0/0",
    },
    { provider },
  );

  new aws.vpc.SecurityGroupIngressRule(
    "bifrostAlbIngressHttp",
    {
      securityGroupId: albSecurityGroup.id,
      description: "http from the internet, redirected to https",
      ipProtocol: "tcp",
      fromPort: HTTP_PORT,
      toPort: HTTP_PORT,
      cidrIpv4: "0.0.0.0/0",
    },
    { provider },
  );

  // ALB egress, scoped to the two container ports on the task. The ALB
  // reaches nothing else, so a compromised or misconfigured listener cannot
  // use it as a pivot.
  new aws.vpc.SecurityGroupEgressRule(
    "bifrostAlbEgressBifrost",
    {
      securityGroupId: albSecurityGroup.id,
      description: "bifrost on the task",
      ipProtocol: "tcp",
      fromPort: BIFROST_PORT,
      toPort: BIFROST_PORT,
      referencedSecurityGroupId: taskSecurityGroup.id,
    },
    { provider },
  );

  new aws.vpc.SecurityGroupEgressRule(
    "bifrostAlbEgressOauth2Proxy",
    {
      securityGroupId: albSecurityGroup.id,
      description: "oauth2-proxy on the task",
      ipProtocol: "tcp",
      fromPort: OAUTH2_PROXY_PORT,
      toPort: OAUTH2_PROXY_PORT,
      referencedSecurityGroupId: taskSecurityGroup.id,
    },
    { provider },
  );

  // Task ingress: the two container ports, from the ALB group, plus one
  // exception declared elsewhere. This is the "nothing else may be reachable
  // inbound to the task" requirement: there is no rule from a CIDR, so a
  // request that did not come through the ALB is refused at the group even
  // before a virtual key is checked.
  //
  // The exception is 8080 from the vk-mint Lambda's own group, added by
  // `bifrost-vk-mint.ts` (step 3 of docs/bifrost-virtual-keys.md) because
  // `/api` through the ALB is behind oauth2-proxy and Google SSO, which a
  // Lambda cannot pass. It is still a referenced group and not a CIDR, so it
  // admits exactly that function; the reasoning and the rejected alternatives
  // are in that module's header.
  //
  // The group's own `description` above still says "from the ALB only", and is
  // deliberately left alone. `description` is ForceNew on this resource, so
  // editing the string replaces the group — and with it every rule below, the
  // database's ingress and both of the ALB's egress rules, which is a gateway
  // outage for a sentence. The accurate description of the exception is on the
  // rule itself (`bifrostTaskIngressVkMint`); a wording fix here belongs with a
  // change that is replacing the group anyway.
  new aws.vpc.SecurityGroupIngressRule(
    "bifrostTaskIngressBifrost",
    {
      securityGroupId: taskSecurityGroup.id,
      description: "bifrost from the ALB only",
      ipProtocol: "tcp",
      fromPort: BIFROST_PORT,
      toPort: BIFROST_PORT,
      referencedSecurityGroupId: albSecurityGroup.id,
    },
    { provider },
  );

  new aws.vpc.SecurityGroupIngressRule(
    "bifrostTaskIngressOauth2Proxy",
    {
      securityGroupId: taskSecurityGroup.id,
      description: "oauth2-proxy from the ALB only",
      ipProtocol: "tcp",
      fromPort: OAUTH2_PROXY_PORT,
      toPort: OAUTH2_PROXY_PORT,
      referencedSecurityGroupId: albSecurityGroup.id,
    },
    { provider },
  );

  /**
   * Task egress: everything, to the internet through the NAT and to RDS
   * inside the VPC. ECR pulls, Secrets Manager reads, CloudWatch writes and
   * the provider APIs all need it, and the provider destinations are on the
   * public internet, so a CIDR-scoped egress rule is not possible. The task
   * is not a pivot into the database or the ALB: ingress to both is
   * group-referenced above.
   */
  new aws.vpc.SecurityGroupEgressRule(
    "bifrostTaskEgressAll",
    {
      securityGroupId: taskSecurityGroup.id,
      description:
        "all outbound: ECR, Secrets Manager, CloudWatch and provider APIs via NAT, Postgres in the VPC",
      ipProtocol: "-1",
      cidrIpv4: "0.0.0.0/0",
    },
    { provider },
  );

  // Database ingress: 5432 from the task group only. No egress rule is
  // declared for this group, so it has none: RDS answers on the connection it
  // accepted and never initiates one, and the database is not allowed out to
  // the internet.
  new aws.vpc.SecurityGroupIngressRule(
    "bifrostDatabaseIngressPostgres",
    {
      securityGroupId: databaseSecurityGroup.id,
      description: "postgres from the task only",
      ipProtocol: "tcp",
      fromPort: POSTGRES_PORT,
      toPort: POSTGRES_PORT,
      referencedSecurityGroupId: taskSecurityGroup.id,
    },
    { provider },
  );

  /**
   * The object later items consume. The subnet ids and the three groups are
   * what items 6, 7 and 8 need; the rest is returned so a future change has
   * the whole network in hand rather than reaching back into this module.
   */
  return {
    vpc,
    publicSubnets,
    privateSubnets,
    publicSubnetIds: publicSubnets.map((subnet) => subnet.id),
    privateSubnetIds: privateSubnets.map((subnet) => subnet.id),
    internetGateway,
    natGateway,
    publicRouteTable,
    privateRouteTable,
    publicRouteTableAssociations,
    privateRouteTableAssociations,
    databaseSubnetGroup,
    albSecurityGroup,
    taskSecurityGroup,
    databaseSecurityGroup,
  };
};
