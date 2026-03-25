import { createHmac, timingSafeEqual } from "crypto";

export const verifySlackWebhook = (
  body: string,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string
): boolean => {
  if (!timestamp || !signature) return false;

  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) return false;

  const basestring = `v0:${timestamp}:${body}`;
  const expected = `v0=${createHmac("sha256", secret).update(basestring).digest("hex")}`;

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
};
