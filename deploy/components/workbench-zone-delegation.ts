import * as aws from "@pulumi/aws";

const GOODPARTY_ZONE_ID = "Z10392302OXMPNQLPO07K";

// Delegates workbench.goodparty.org to the zone the workbench account owns
// (deploy-workbench/dns.ts), so services there name themselves without any
// write access to this zone. Constants rather than a stack reference, per
// docs/workbench-account.md "Cross-project dependencies". They change only if
// that zone is recreated, which its `protect` prevents.
export const WORKBENCH_ZONE_NAME_SERVERS = [
  "ns-1208.awsdns-23.org",
  "ns-1633.awsdns-12.co.uk",
  "ns-171.awsdns-21.com",
  "ns-809.awsdns-37.net",
];

export const createWorkbenchZoneDelegation = () =>
  new aws.route53.Record("workbenchZoneDelegation", {
    zoneId: GOODPARTY_ZONE_ID,
    name: "workbench.goodparty.org",
    type: "NS",
    ttl: 3600,
    records: WORKBENCH_ZONE_NAME_SERVERS,
  });
