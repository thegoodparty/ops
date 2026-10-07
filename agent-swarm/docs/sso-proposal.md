# SSO for delegate-swarm.goodparty.org (agent-swarm v1.163.0)

Source read: `docs-site/content/docs/(documentation)/guides/self-hosted-sso.mdx`,
`examples/sso/docker-compose.sso.yml`, `examples/sso/oauth2-proxy.cfg`,
`examples/sso/native-oidc.env.example`, `src/http/auth.ts`, `src/http/users.ts`,
`src/be/users.ts`, `src/http/pages-public.ts`, `src/http/core.ts`.

## 1. Does the API consume proxy identity headers? No.

- `src/http/auth.ts:26-69` is the whole HTTP auth resolver. It reads only the
  `Authorization: Bearer` header (`extractBearer`, lines 13-18) plus the
  `x-page-session`/`x-page-id` pair for page sessions (lines 33-49). Three
  bearer kinds: the shared `API_KEY` -> `kind: "operator"` (line 50), an
  `aswt_` user token -> `kind: "user"` (lines 53-58), an `aseph_` agent
  session token -> `kind: "agent"` (lines 60-65). Anything else -> `null`
  (401).
- `grep -rni "x-forwarded-user|x-forwarded-email|x-auth-request" src/` returns
  nothing. There is no env var that enables trusting headers. The example
  compose says so explicitly: `examples/sso/docker-compose.sso.yml:30-32`
  "`SSO_TRUSTED_HEADER=X-Forwarded-Email` ... Proposed, not yet implemented.
  Track DES-445", and `examples/sso/native-oidc.env.example:3-7` says the
  native OIDC middleware (`src/http/oidc.ts`) does not exist.
- The doc's own decision table (`self-hosted-sso.mdx:14-19`) confirms: Mode 1
  "all authenticated users share the operator key"; Mode 2 "forwards identity
  headers ... ready to be consumed when the app adds header-based attribution".

So: oauth2-proxy can only gate access. The SPA still needs a bearer. Two
choices for what people type into the SPA's connection form:

- the shared `API_KEY` (everyone is `operator`, no per-user attribution), or
- a per-user `aswt_` token. An admin mints one with
  `POST /api/users/{id}/mcp-tokens` (`src/http/users.ts:336-361`, plaintext
  returned once; `src/be/users.ts:432-453` `aswt_` + 24 base62). The SPA then
  calls `GET /api/whoami` (`src/http/users.ts:149-170`) and locks the tab to
  that user. Hand it out as
  `https://delegate-swarm.goodparty.org/?apiUrl=https://delegate-swarm.goodparty.org&apiKey=aswt_...`
  (`apps/ui/src/hooks/use-config.ts:118-135` stores it tab-locally in
  sessionStorage). Users are created with `POST /api/users`
  (`src/http/users.ts:191`). This is the only per-user identity path today.

Env var names: none exist for header trust. Only `API_KEY`, `RBAC_ENABLED`
(default true, two roles `admin`/`requester`, everyone is admin, no
assignment API: `self-hosted-sso.mdx:22`).

## 2. Pages (`authMode=authed`) and apps

Same bearer identity, not the proxy's.

- Authed pages need a `page_session` cookie minted by
  `POST /api/pages/:id/launch`, which is itself a bearer-authed REST call
  (`src/http/pages-public.ts:401-406`, comment at lines 350-357). With no
  cookie: 401; cookie for another page: 403 (lines 384-398). The cookie is
  verified by `verifyPageSession` (`src/http/auth.ts:38`) and, when it carries
  a `uid`, resolves to that user (lines 43-46).
- Page code calls the API through `/@swarm/api/*` (`src/http/page-proxy.ts:37-106`)
  using the page session. Public pages (`authMode=public`) are served at
  `/p/{id}` with a 30-minute public cache (`pages-public.ts:54,601`).
- Apps are ordinary `/api/apps*` routes gated by RBAC on the bearer principal
  (`src/http/apps.ts:236-393`, `rbac: { permission: "app.use" | "app.manage" }`).

oauth2-proxy in front changes none of this; it only decides whether the
browser reaches Caddy's upstreams at all.

## 3. Redirect path and bypasses

- oauth2-proxy callback: `/oauth2/callback` (default; `oauth2-proxy.cfg`
  `redirect_url`, `self-hosted-sso.mdx:71`). Register
  `https://delegate-swarm.goodparty.org/oauth2/callback` in the Google OAuth client.
  Everything under `/oauth2/*` (`/oauth2/start`, `/oauth2/auth`,
  `/oauth2/sign_out`, `/oauth2/userinfo`) is proxied to oauth2-proxy itself.
- Agents never cross the proxy. Workers use `MCP_BASE_URL: http://api:3013`
  (docker-compose.yml x-worker-env) and the api healthcheck hits
  `localhost:3013` inside the container. So no bypass is needed for anything
  the swarm does internally.
- Paths that MUST bypass forward_auth because the caller has no browser cookie:
  - `/mcp` and `/mcp-user`: external MCP clients (Claude Code, Cursor) connect
    to `PUBLIC_MCP_BASE_URL=https://delegate-swarm.goodparty.org` with a bearer
    (`src/http/mcp.ts:158`, `src/http/mcp-user.ts:46`). Bearer auth still
    applies there.
  - `/health`, `/status`, `/ping` (`src/http/core.ts:416`, `status.ts:766`,
    `core.ts:356`) if any external monitor polls them. `/health` is public.
  - `/api/github/webhook`, `/api/gitlab/webhook`, `/api/azure-devops/webhook`,
    `/api/agentmail/webhook`, `/api/integrations/kapso/webhook`
    (`src/http/webhooks.ts:111-174`). Today `GITHUB_DISABLE=true` and Slack is
    socket mode, so none are live, but listing them costs nothing.
  - `/api/mcp-oauth/callback` (`src/http/mcp-oauth.ts:315`) and
    `/api/oauth/callback`, `/api/oauth/{provider}/callback`
    (`src/http/oauth-callback.ts:33`, `oauth-generic.ts:17`): the IdP
    redirects the operator's browser here. The browser normally has the
    oauth2-proxy cookie, but if it expired mid-flow the callback would bounce
    to Google and lose the state. Bypass them; they carry their own state.
  - `/p/*` and `/@swarm/*` only if you want public pages to be reachable by
    people outside goodparty.org. Default below keeps them behind SSO.
- Everything else (the SPA files, `/api/*`) sits behind forward_auth. Note the
  SPA still sends its own bearer on `/api/*`; the cookie and the bearer are
  checked independently.

## 4. Proposed topology: Caddy forward_auth -> oauth2-proxy, Caddy keeps serving

Caddy already terminates TLS and (per Caddyfile.proposed) serves the SPA and
proxies the API. Putting oauth2-proxy inline as an upstream would mean
oauth2-proxy proxying static files too. `forward_auth` keeps Caddy as the
only data path and uses oauth2-proxy's `/oauth2/auth` endpoint (202 = allowed,
401 = redirect to start). The docs only show the inline mode
(`self-hosted-sso.mdx:30-58`), but nothing in the API depends on which mode is
used, since it ignores the forwarded headers anyway.

### Compose service (add to docker-compose.yml)

```yaml
oauth2-proxy:
  image: quay.io/oauth2-proxy/oauth2-proxy:v7.14.2
  restart: unless-stopped
  environment:
    OAUTH2_PROXY_PROVIDER: google
    OAUTH2_PROXY_CLIENT_ID: ${OAUTH2_PROXY_CLIENT_ID}
    OAUTH2_PROXY_CLIENT_SECRET: ${OAUTH2_PROXY_CLIENT_SECRET}
    OAUTH2_PROXY_COOKIE_SECRET: ${OAUTH2_PROXY_COOKIE_SECRET} # openssl rand -base64 32 | tr -- '+/' '-_'
    OAUTH2_PROXY_EMAIL_DOMAINS: goodparty.org
    OAUTH2_PROXY_REDIRECT_URL: https://delegate-swarm.goodparty.org/oauth2/callback
    OAUTH2_PROXY_HTTP_ADDRESS: 0.0.0.0:4180
    OAUTH2_PROXY_REVERSE_PROXY: "true"
    OAUTH2_PROXY_UPSTREAMS: static://202
    OAUTH2_PROXY_COOKIE_SECURE: "true"
    OAUTH2_PROXY_COOKIE_SAMESITE: lax
    OAUTH2_PROXY_COOKIE_EXPIRE: 168h
    OAUTH2_PROXY_COOKIE_REFRESH: 1h
    OAUTH2_PROXY_SET_XAUTHREQUEST: "true"
    OAUTH2_PROXY_PASS_USER_HEADERS: "true"
    OAUTH2_PROXY_SKIP_PROVIDER_BUTTON: "true"
    OAUTH2_PROXY_WHITELIST_DOMAINS: delegate-swarm.goodparty.org
```

No `ports:`; only Caddy talks to it on the compose network. Add the three
`OAUTH2_PROXY_*` secrets to Secrets Manager `DELEGATE_SWARM` so render-env.sh
emits them (and add them to `REQUIRED_KEYS`). Pinned v7.14.2 is the current
release line; the docs' example pins v7.6.0 (`self-hosted-sso.mdx:33`), which
predates the Google provider's current `--email-domain` handling, so prefer
the newer one. `OAUTH2_PROXY_UPSTREAMS: static://202` makes oauth2-proxy
answer `/oauth2/auth` without needing a real upstream. `SET_XAUTHREQUEST` and
`PASS_USER_HEADERS` are included so `X-Auth-Request-Email` is forwarded and
ready for the day the API grows DES-445, per the doc's Mode 2.

### Caddyfile (replaces Caddyfile.proposed when SSO goes live)

```caddyfile
delegate-swarm.goodparty.org {
	encode zstd gzip

	# oauth2-proxy's own endpoints: login start, Google callback, sign out.
	handle /oauth2/* {
		reverse_proxy oauth2-proxy:4180 {
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-Uri {uri}
		}
	}

	# Machine callers with their own bearer or signature: no browser cookie.
	@noauth path /mcp /mcp-user /health /status /ping /api/github/webhook /api/gitlab/webhook /api/azure-devops/webhook /api/agentmail/webhook /api/integrations/kapso/webhook /api/mcp-oauth/callback /api/oauth/callback /api/oauth/*/callback
	handle @noauth {
		reverse_proxy api:3013
	}

	# Everything else: Google SSO first.
	handle {
		forward_auth oauth2-proxy:4180 {
			uri /oauth2/auth
			copy_headers X-Auth-Request-User X-Auth-Request-Email X-Auth-Request-Groups X-Forwarded-User X-Forwarded-Email

			# Browser navigations go to the login page; XHR/fetch from the
			# SPA just gets a 401 so the app surfaces it instead of following
			# a redirect into Google HTML.
			@error status 401 403
			handle_response @error {
				@navigation header Accept *text/html*
				redir @navigation /oauth2/start?rd={scheme}://{host}{uri} 302
				respond 401
			}
		}

		@api path /api/* /p/* /@swarm/* /docs /docs/* /openapi.json /x/* /close
		handle @api {
			reverse_proxy api:3013
		}

		handle {
			root * /srv/ui
			@nocache path / /index.html /version.json
			header @nocache Cache-Control "no-cache"
			@assets path /assets/*
			header @assets Cache-Control "public, max-age=31536000, immutable"
			try_files {path} /index.html
			file_server
		}
	}
}
```

The api container does nothing with the copied `X-Auth-Request-*` headers
today (section 1). They are forwarded so the SPA request logs and a future
API version can use them. If you would rather not forward unused identity,
drop the `copy_headers` line.

### What this gives you, and what it does not

- Gives: only goodparty.org Google accounts reach the dashboard, the API's
  REST surface, pages and apps. MCP and webhooks stay reachable with their
  own credentials.
- Does not give: per-user identity at the API from the SSO login. Each person
  still enters the shared `API_KEY` or an admin-minted `aswt_` token in the
  SPA (section 1). Pairing SSO with per-user `aswt_` tokens is the closest to
  real per-user access until DES-445 ships.

### Order of operations (none of this touches the running stack yet)

1. Create the Google OAuth client (Web application) with redirect URI
   `https://delegate-swarm.goodparty.org/oauth2/callback`; put client id, secret and a
   cookie secret in Secrets Manager `DELEGATE_SWARM`.
2. Add the `oauth2-proxy` service and the three keys to render-env.sh.
3. Swap the Caddyfile for the SSO version above and `docker compose --profile
tls up -d oauth2-proxy caddy`.
4. Confirm `curl -sI https://delegate-swarm.goodparty.org/health` is 200 without a
   cookie and `curl -sI https://delegate-swarm.goodparty.org/` is a 302 to
   `/oauth2/start`.
