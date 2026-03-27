import * as aws from "@pulumi/aws";

export const createPlaywrightReportsBucket = () => {
  const bucket = new aws.s3.BucketV2("playwrightReportsBucket", {
    bucket: "gp-playwright-reports",
  });

  const publicAccessBlock = new aws.s3.BucketPublicAccessBlock(
    "playwrightReportsPublicAccess",
    {
      bucket: bucket.id,
      blockPublicAcls: false,
      blockPublicPolicy: false,
      ignorePublicAcls: false,
      restrictPublicBuckets: false,
    }
  );

  new aws.s3.BucketPolicy(
    "playwrightReportsPolicy",
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

  new aws.s3.BucketLifecycleConfigurationV2("playwrightReportsLifecycle", {
    bucket: bucket.id,
    rules: [
      {
        id: "expire-old-reports",
        status: "Enabled",
        expiration: { days: 30 },
      },
    ],
  });

  new aws.s3.BucketCorsConfigurationV2("playwrightReportsCors", {
    bucket: bucket.id,
    corsRules: [
      {
        allowedHeaders: ["*"],
        allowedMethods: ["GET"],
        allowedOrigins: ["https://trace.playwright.dev"],
        exposeHeaders: ["Content-Length", "Content-Type"],
        maxAgeSeconds: 3600,
      },
    ],
  });

  return { bucket };
};
