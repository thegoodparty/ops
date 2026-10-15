import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const GOODPARTY_ZONE_ID = "Z10392302OXMPNQLPO07K";

/**
 * The workbench stack, whose `workbenchZoneNameServers` output names the four
 * name servers of the `workbench.goodparty.org` zone that
 * `deploy-workbench/dns.ts` creates.
 */
export const WORKBENCH_STACK_NAME = "organization/workbench/main";

/** The output `deploy-workbench/index.ts` exports for this record. */
export const WORKBENCH_ZONE_NAME_SERVERS_OUTPUT = "workbenchZoneNameServers";

/** The delegated name. Must match `WORKBENCH_ZONE_NAME` in `deploy-workbench/dns.ts`. */
export const WORKBENCH_ZONE_DELEGATION_NAME = "workbench.goodparty.org";

/**
 * Delegates `workbench.goodparty.org` to the zone the workbench account owns
 * (`deploy-workbench/dns.ts`), so services there name themselves without any
 * write access to the production zone. The sibling of
 * `infra-zone-delegation.ts`, and the only management-account change the
 * gateway plan needs.
 *
 * A `StackReference` here, not the hardcoded constants
 * `infra-zone-delegation.ts` uses, and the difference is deliberate rather
 * than an oversight. The infrastructure zone already existed when its NS
 * record was written, so its name servers could be captured as constants
 * (`docs/infrastructure-account.md`, "DNS"). The workbench zone is created in
 * the same change that delegates it, so its name servers do not exist yet to
 * hardcode: any value written here would be a guess, and a wrong delegation
 * breaks ACM certificate validation in phase 1 in a way that reads as an ACM
 * problem. The reference reads the real output at apply time, so the record
 * is correct the first time it is created.
 *
 * This is the one case where "constants rather than a StackReference" in
 * `docs/workbench-account.md` "Cross-project dependencies" does not apply.
 * That rule is about account ids, which are immutable and known before any
 * apply; a zone's name servers are neither. The ordering the rule warns
 * about still holds: `deploy-workbench` must be applied before `deploy`, or
 * the record has no name servers to write. `getOutput` rather than
 * `requireOutput` so a preview of this stack still renders while the
 * workbench zone is pending: the two stacks are applied independently, and
 * every PR previews `deploy/` whether or not `deploy-workbench/` has run. If
 * the output is absent at apply time the value is empty and the record
 * create fails, rather than leaving a delegation with no name servers.
 */
export const createWorkbenchZoneDelegation = () => {
  const workbench = new pulumi.StackReference("workbenchStack", {
    name: WORKBENCH_STACK_NAME,
  });

  return new aws.route53.Record("workbenchZoneDelegation", {
    zoneId: GOODPARTY_ZONE_ID,
    name: WORKBENCH_ZONE_DELEGATION_NAME,
    type: "NS",
    ttl: 3600,
    records: workbench.getOutput(WORKBENCH_ZONE_NAME_SERVERS_OUTPUT),
  });
};
