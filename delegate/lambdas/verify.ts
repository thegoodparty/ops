import { createHmac, timingSafeEqual } from "crypto";

export const verifyGithubWebhook = (
  body: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean => {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const expected =
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
};
