# Installing the Agent Swarm Slack app

This is clickops. There is no API for it, and BugBoss's app cannot be reused:
a second system needs its own bot identity, its own signing secret and its own
token, or the two would answer each other's messages.

Takes about five minutes. Do this while the host is being built; nothing else
in this directory depends on it.

## 1. Create the app from the manifest

1. Open <https://api.slack.com/apps> and choose **Create New App**.
2. Choose **From an app manifest**, pick the GoodParty workspace, then **Next**.
3. Paste the contents of [`manifest.json`](./manifest.json) and choose **Next**,
   then **Create**.

The manifest sets Socket Mode, so the app needs no public request URL and the
host needs no inbound Slack route. Everything is an outbound websocket.

## 2. Create the app-level token

Socket Mode needs a second token that the bot token does not provide.

1. **Basic Information** → scroll to **App-Level Tokens** → **Generate Token
   and Scopes**.
2. Name it `socket`, add the scope **`connections:write`**, then **Generate**.
3. Copy the `xapp-...` value. This is `SLACK_APP_TOKEN`.

## 3. Install to the workspace

1. **Install App** → **Install to GoodParty** → **Allow**.
2. Copy the **Bot User OAuth Token**, `xoxb-...`. This is `SLACK_BOT_TOKEN`.

## 4. Make a channel for it

Create a channel for the swarm and keep it separate from BugBoss's channel, or
both systems will narrate into the same place. `#swarm-incidents` is the
suggested name, mirroring `#dev-alerts`.

In that channel run:

```
/invite @Agent Swarm
```

Then copy the channel ID: right-click the channel → **Copy link**. The ID is
the `C...` segment at the end of the URL. This is `SWARM_INCIDENT_CHANNEL`.

`chat:write.public` is in the manifest, so the bot can post without an invite,
but an invite is what lets it read replies and notices. Invite it.

## 5. Hand the three values over

| Value | Prefix | Where |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | `xoxb-` | step 3 |
| `SLACK_APP_TOKEN` | `xapp-` | step 2 |
| `SWARM_INCIDENT_CHANNEL` | `C` | step 4 |

These go into the `AGENT_SWARM` secret in Secrets Manager, never into `.env` on
disk and never into a commit.

## Renaming

The bot's display name comes from the manifest (`Agent Swarm`). Slack derives
the `@handle` from it. To rename, edit `display_information.name` and
`features.bot_user.display_name`, then **App Manifest** → paste → **Save**.

## What each scope is for

| Scope | Why |
| --- | --- |
| `chat:write`, `chat:write.customize`, `chat:write.public` | post incident threads and rewrite the bot's own messages |
| `channels:history`, `groups:history` | read replies in the incident thread |
| `app_mentions:read` | answer a mention |
| `reactions:write` | the acknowledging reaction, as BugBoss does |
| `files:read`, `files:write` | upload the closing post-mortem as a file |
| `users:read` | resolve who a reply came from |
| `commands` | the two `/agent-swarm-*` commands |
| `assistant:write`, `assistant_thread_started` | the Slack assistant surface |
| `im:*`, `mpim:*` | direct messages to the bot |

No `user` scopes are requested. BugBoss's app did not need any either, and a
user token would widen what a compromised agent could reach.
