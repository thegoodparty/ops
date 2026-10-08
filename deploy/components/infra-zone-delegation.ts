import * as aws from "@pulumi/aws";

const GOODPARTY_ZONE_ID = "Z10392302OXMPNQLPO07K";

// Delegates infra.goodparty.org to the zone the infrastructure account owns
// (deploy-infrastructure/dns.ts), so services there name themselves without
// any write access to this zone. Constants rather than a stack reference, per
// docs/workbench-account.md "Cross-project dependencies". They change only if
// that zone is recreated, which its `protect` prevents.
export const INFRA_ZONE_NAME_SERVERS = [
  "ns-1429.awsdns-50.org",
  "ns-1823.awsdns-35.co.uk",
  "ns-482.awsdns-60.com",
  "ns-973.awsdns-57.net",
];

export const createInfraZoneDelegation = () =>
  new aws.route53.Record("infraZoneDelegation", {
    zoneId: GOODPARTY_ZONE_ID,
    name: "infra.goodparty.org",
    type: "NS",
    ttl: 3600,
    records: INFRA_ZONE_NAME_SERVERS,
  });
