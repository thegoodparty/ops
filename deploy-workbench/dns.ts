import * as aws from "@pulumi/aws";

export const WORKBENCH_ZONE_NAME = "workbench.goodparty.org";

/**
 * The workbench account's own DNS zone, the sibling of the infrastructure
 * account's `infra.goodparty.org` (`deploy-infrastructure/dns.ts`).
 *
 * Delegated from `goodparty.org` by an NS record in `deploy/`, the management
 * account's stack. That record is the only change the management account ever
 * makes for this account's names: every record under `workbench.goodparty.org`
 * lives here and is managed here, so a service in this account never needs
 * write access to the production zone. The first name it will hold is
 * `bifrost.workbench.goodparty.org`, the model gateway in
 * `docs/bifrost-gateway.md` (phase 1).
 *
 * The zone is created here and not in `deploy/` because the account that owns
 * the names should own the zone. The parent side is only the delegation.
 *
 * `protect` for the same reason the infrastructure zone carries it: a
 * recreated zone gets new name servers, and the NS record in `deploy/` would
 * still name the old ones, taking every name under this zone out of
 * resolution until that record was changed by hand. The delegation is a
 * staged follow-up (`docs/workbench-account.md`, "Cross-project
 * dependencies"): it names the `workbenchZoneNameServers` output below as
 * constants once this zone has been applied, the way `infra.goodparty.org`
 * was delegated (`docs/infrastructure-account.md`, "DNS").
 */
export const createWorkbenchZone = (args: { provider: aws.Provider }) =>
  new aws.route53.Zone(
    "workbenchZone",
    {
      name: WORKBENCH_ZONE_NAME,
      comment:
        "Delegated from goodparty.org by an NS record in deploy/. Workbench account's own names, starting with bifrost.workbench.goodparty.org.",
    },
    { provider: args.provider, protect: true },
  );
