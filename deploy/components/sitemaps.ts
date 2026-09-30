import * as aws from "@pulumi/aws";

export interface SitemapsConfig {
  // The account's GitHub OIDC provider ARN. Looked up in index.ts (it already
  // exists in this account, trusted by clickup-bot-ci-invoker-prod) rather
  // than created here.
  oidcProviderArn: string;
}

// gp-marketing's workflow presents this subject; kept as `:*` on purpose so
// any ref (including workflow_dispatch) can publish, per the ticket's
// tradeoff note. Tightening to `:ref:refs/heads/develop` would block that.
const GP_MARKETING_SUBJECT = "repo:thegoodparty/gp-marketing:*";

/**
 * The public-read bucket the people-sitemaps generator publishes to, plus the
 * GitHub Actions role gp-marketing's publish workflow assumes to write to it.
 * Modeled on `createPlaywrightReportsBucket` for the bucket and
 * `webhookLambdaRole` (webhooks.ts) for the role shape.
 */
export const createSitemapsBucket = (config: SitemapsConfig) => {
  const bucket = new aws.s3.BucketV2("sitemapsBucket", {
    bucket: "gp-marketing-sitemaps",
  });

  const publicAccessBlock = new aws.s3.BucketPublicAccessBlock(
    "sitemapsPublicAccess",
    {
      bucket: bucket.id,
      blockPublicAcls: false,
      blockPublicPolicy: false,
      ignorePublicAcls: false,
      restrictPublicBuckets: false,
    }
  );

  new aws.s3.BucketPolicy(
    "sitemapsPolicy",
    {
      bucket: bucket.id,
      policy: bucket.arn.apply((arn) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "PublicReadGetObject",
              Effect: "Allow",
              Principal: "*",
              Action: "s3:GetObject",
              Resource: `${arn}/*`,
            },
          ],
        })
      ),
    },
    { dependsOn: [publicAccessBlock] }
  );

  // Versioning is the rollback mechanism (TDD): a bad publish can be reverted
  // to the prior version without regenerating shards.
  new aws.s3.BucketVersioningV2("sitemapsVersioning", {
    bucket: bucket.id,
    versioningConfiguration: { status: "Enabled" },
  });

  new aws.s3.BucketLifecycleConfigurationV2("sitemapsLifecycle", {
    bucket: bucket.id,
    rules: [
      {
        id: "expire-noncurrent-versions",
        status: "Enabled",
        noncurrentVersionExpiration: { noncurrentDays: 30 },
      },
    ],
  });

  // Assumable only by gp-marketing's workflows via the account's existing
  // OIDC provider. S3-only, scoped to this bucket: no delete, no other repo.
  const publisherRole = new aws.iam.Role("sitemapsPublisherRole", {
    name: "gp-marketing-sitemaps-publisher",
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Federated: config.oidcProviderArn },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            },
            StringLike: {
              "token.actions.githubusercontent.com:sub": GP_MARKETING_SUBJECT,
            },
          },
        },
      ],
    }),
    inlinePolicies: [
      {
        name: "sitemaps-publish",
        policy: bucket.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["s3:PutObject", "s3:GetObject"],
                Resource: `${arn}/*`,
              },
              {
                Effect: "Allow",
                Action: "s3:ListBucket",
                Resource: arn,
              },
            ],
          })
        ),
      },
    ],
  });

  return { bucket, publisherRole };
};
