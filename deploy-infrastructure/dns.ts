import * as aws from "@pulumi/aws";

export const INFRA_ZONE_NAME = "infra.goodparty.org";

/**
 * The account's own DNS zone, shared by every service in this account.
 *
 * Delegated from `goodparty.org` by an NS record in `deploy/`, the management
 * account's stack. That record is the only change the management account
 * ever makes for this account's names: every record under
 * `infra.goodparty.org` lives here and is managed here, so a service in this
 * account never needs write access to the production zone.
 */
export const createInfraZone = (args: { provider: aws.Provider }) =>
  new aws.route53.Zone(
    "infraZone",
    {
      name: INFRA_ZONE_NAME,
      comment:
        "Delegated from goodparty.org by an NS record in deploy/. Shared by every service in the infrastructure account.",
    },
    /**
     * Protected because a recreated zone gets new name servers, and the NS
     * record in `deploy/` still names the old ones: every name under
     * `infra.goodparty.org` stops resolving until that record is changed.
     */
    { provider: args.provider, protect: true },
  );
