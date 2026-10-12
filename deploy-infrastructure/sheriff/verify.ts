import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slack request-signature verification for the break-glass function.
 *
 * Follows the pattern in `delegate/lambdas/verify.ts` rather than importing it:
 * the break-glass Lambda must not depend on the delegate bundle, which is
 * deployed from `delegate/**` and processed untrusted text. Keeping a local
 * copy means a change to the delegate code cannot silently change what this
 * function accepts, and `deploy-infrastructure.yml` does not need a path filter
 * on `delegate/**`.
 *
 * Same five-minute replay window and same constant-time comparison as the
 * delegate pattern.
 */
export const verifySlackWebhook = (
  body: string,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
): boolean => {
  if (!timestamp || !signature) return false;

  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) return false;

  const basestring = `v0:${timestamp}:${body}`;
  const expected = `v0=${createHmac("sha256", secret)
    .update(basestring)
    .digest("hex")}`;

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
};
