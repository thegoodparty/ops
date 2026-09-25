# mcp

An MCP server so a person can ask BugBoss questions from Claude Code, and
file a bug report as a signal.

## It is optional and fails closed at startup

Without `BUGBOSS_MCP_JWT_SECRET` and the Google client id and secret, the
server never mounts and the Boss logs `mcp_not_configured`. Everything in
the alert path works without it.

`config.ts` throws at startup on an empty JWT secret or a missing Google
credential, so it cannot mount half-configured.

## Stateless is the only legal mode

MCP spec 2026-07-28 removed sessions, `initialize` and GET SSE. Do not
reintroduce per-connection state.

## Authorization

BugBoss is both the resource server and its own authorization server. Google
is the identity provider only: the flow exchanges a code at `/callback`,
checks the ID token, and mints BugBoss's own token.

Three claim checks, all of which must pass:

- `hd` — the Google Workspace hosted domain
- `email_verified`
- the email's suffix against `BUGBOSS_WORKSPACE_DOMAIN`

Setting the Google consent screen to **Internal** is the stronger control
and costs nothing, but the claim checks are independent of it — a
misconfigured consent screen does not silently open this up.

Token verification uses an explicit HS256 allowlist, which is what blocks
`alg: none` and algorithm confusion.

**Signature verification on the Google ID token is deliberately skipped**
(`jwt.decode`). That is spec-defensible: OIDC Core 3.1.3.7 step 6 permits it
for a token fetched over a direct back-channel, and `exchangeCode` is a
server-to-server POST that never touches the browser redirect. Do not copy
this pattern anywhere the token arrives via a redirect.

## Routes and one trap

Google does not support Dynamic Client Registration, so the OAuth client is
**pre-registered**. The 401 carries a `WWW-Authenticate` challenge with
`resource_metadata`, which is how a client discovers where to authenticate.

**Unverified:** whether that header survives the ALB. It is asserted in a
test at the Node layer, but API Gateway REST is known to rename it and kill
discovery silently. Worth checking with `curl -i` through the real ALB
before relying on the MCP path.

A trailing slash on a root route has bitten this codebase before — it
resolves to the `:id` sibling and 404s every request. Watch `joinPath`.

## Writes

The read surface runs arbitrary SQL through the **read-only** connection.
The one write is `report_signal`, which files a human bug report and goes
through the same `place` path as any other source — so it is triaged, and it
can never be suppressed.
