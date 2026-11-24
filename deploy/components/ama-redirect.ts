import * as aws from "@pulumi/aws";

const domain = "ama.goodparty.org";
const zoneId = "Z10392302OXMPNQLPO07K";
const destination = "https://www.menti.com/aluap833u5p2";

export const createAmaRedirect = () => {
  const certificateProvider = new aws.Provider("amaCertificateRegion", {
    region: "us-east-1",
  });
  const certificate = new aws.acm.Certificate("amaRedirectCertificate", {
    domainName: domain,
    validationMethod: "DNS",
  }, { provider: certificateProvider });

  const validation = certificate.domainValidationOptions.apply(([option]) => option);
  const validationRecord = new aws.route53.Record("amaRedirectCertificateValidation", {
    zoneId,
    name: validation.resourceRecordName,
    type: validation.resourceRecordType,
    records: [validation.resourceRecordValue],
    ttl: 300,
  });
  const validatedCertificate = new aws.acm.CertificateValidation("amaRedirectCertificateReady", {
    certificateArn: certificate.arn,
    validationRecordFqdns: [validationRecord.fqdn],
  }, { provider: certificateProvider });

  const redirect = new aws.cloudfront.Function("amaRedirect", {
    runtime: "cloudfront-js-2.0",
    publish: true,
    code: `function handler() {
  return {
    statusCode: 302,
    headers: {
      location: { value: ${JSON.stringify(destination)} },
      'cache-control': { value: 'no-store' }
    }
  };
}`,
  });

  const distribution = new aws.cloudfront.Distribution("amaRedirect", {
    enabled: true,
    aliases: [domain],
    isIpv6Enabled: true,
    priceClass: "PriceClass_100",
    origins: [{
      originId: "unused-origin",
      domainName: "goodparty.org",
      customOriginConfig: {
        httpPort: 80,
        httpsPort: 443,
        originProtocolPolicy: "https-only",
        originSslProtocols: ["TLSv1.2"],
      },
    }],
    defaultCacheBehavior: {
      targetOriginId: "unused-origin",
      viewerProtocolPolicy: "redirect-to-https",
      allowedMethods: ["GET", "HEAD"],
      cachedMethods: ["GET", "HEAD"],
      cachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
      functionAssociations: [{
        eventType: "viewer-request",
        functionArn: redirect.arn,
      }],
    },
    restrictions: { geoRestriction: { restrictionType: "none" } },
    viewerCertificate: {
      acmCertificateArn: validatedCertificate.certificateArn,
      sslSupportMethod: "sni-only",
      minimumProtocolVersion: "TLSv1.2_2021",
    },
  });

  for (const type of ["A", "AAAA"]) {
    new aws.route53.Record(`amaRedirect-${type}`, {
      zoneId,
      name: domain,
      type,
      aliases: [{
        name: distribution.domainName,
        zoneId: distribution.hostedZoneId,
        evaluateTargetHealth: false,
      }],
    });
  }
};
