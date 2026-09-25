// Scoped agent tokens. Design spec: bugboss/docs/architecture.md, "What
// bounds an agent":
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

/**
 * `expiresInSeconds` is required, deliberately.
 *
 * It used to be optional and no caller passed one, so every token was good
 * for the life of the Boss process. The intended revocation was process
 * scope — a restart rotates the secret — which holds for restarts and not
 * for the case the threat model actually names: a child that leaks its token
 * keeps a working credential against the running Boss long after its
 * incident closed.
 */
export const mintAgentToken = (
  secret: string,
  claims: AgentTokenClaims,
  expiresInSeconds: number,
): string =>
  jwt.sign({ attempt: claims.attempt }, secret, {
    algorithm: ALGORITHM,
    audience: AUDIENCE,
    subject: claims.incidentId,
    expiresIn: expiresInSeconds,
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
  // jwt.verify rejects an `exp` in the past but accepts one that is absent, so
  // a token minted without an expiry would verify forever. Checked here rather
  // than trusted to the mint site, since this is the gate.
  if (typeof payload.exp !== "number") {
    throw new TokenError("agent token carries no expiry");
  }
  return {
    incidentId: payload.sub,
    attempt: typeof payload.attempt === "number" ? payload.attempt : 0,
  };
};
