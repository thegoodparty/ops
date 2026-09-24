// Scoped agent tokens. Design spec: docs/bugboss/design.md, "Authentication":
// "A scoped token on a local socket or loopback HTTP, carrying incidentId ->
// that one incident."
//
// Co-location is what makes this load-bearing. An agent used to be its own ECS
// task with its own role; now it shares a container with the Slack token, the
// GitHub token and S3 write credentials, and it reads attacker-writable log
// lines for a living. The token is the reason a fully compromised agent can
// still only corrupt one record: every tool call derives its incident from the
// token, never from an argument.

import jwt from "jsonwebtoken";

const AUDIENCE = "bugboss-toolapi";
const ALGORITHM = "HS256";

export interface AgentTokenClaims {
  incidentId: string;
  /** The dispatcher attempt this token was minted for. */
  attempt: number;
}

export class TokenError extends Error {}

export const mintAgentToken = (
  secret: string,
  claims: AgentTokenClaims,
  expiresInSeconds?: number,
): string =>
  jwt.sign({ attempt: claims.attempt }, secret, {
    algorithm: ALGORITHM,
    audience: AUDIENCE,
    subject: claims.incidentId,
    ...(expiresInSeconds === undefined ? {} : { expiresIn: expiresInSeconds }),
  });

export const verifyAgentToken = (
  secret: string,
  token: string,
): AgentTokenClaims => {
  let payload: jwt.JwtPayload | string;
  try {
    payload = jwt.verify(token, secret, {
      audience: AUDIENCE,
      algorithms: [ALGORITHM],
    });
  } catch (err) {
    throw new TokenError(`invalid agent token: ${(err as Error).message}`);
  }

  if (typeof payload === "string" || !payload.sub) {
    throw new TokenError("agent token carries no incident");
  }
  return {
    incidentId: payload.sub,
    attempt: typeof payload.attempt === "number" ? payload.attempt : 0,
  };
};
