import { App, LogLevel } from '@slack/bolt'
import type { Delegate, PostSlack } from './delegate.ts'

type SlackMessage = {
  channel: string
  ts: string
  thread_ts?: string
  user?: string
  text?: string
  channel_type?: string
  subtype?: string
  bot_id?: string
}

export const createSlack = (options: { botToken: string; appToken: string }) => {
  const app = new App({ token: options.botToken, appToken: options.appToken, socketMode: true, logLevel: LogLevel.INFO })
  const postSlack: PostSlack = async ({ channel, threadTs, text }) => {
    const posted = await app.client.chat.postMessage({ channel, thread_ts: threadTs, text: text.slice(0, 39000) })
    return { ts: posted.ts }
  }
  return { app, postSlack }
}

export const startSlack = async (options: { app: App; delegate: Delegate; allowedEmailDomains: string[] }) => {
  const { app, delegate, allowedEmailDomains } = options
  const botUserId = (await app.client.auth.test()).user_id ?? ''
  const allowed = new Map<string, boolean>()

  const isAllowed = async (user: string) => {
    if (allowedEmailDomains.length === 0) return true
    const known = allowed.get(user)
    if (known !== undefined) return known
    const info = await app.client.users.info({ user })
    const domain = info.user?.profile?.email?.split('@')[1]?.toLowerCase()
    const result = domain !== undefined && allowedEmailDomains.includes(domain) && !info.user?.is_bot
    allowed.set(user, result)
    return result
  }

  const accept = async (message: SlackMessage, create: boolean) => {
    if (message.user === undefined || message.user === botUserId) return
    if (!(await isAllowed(message.user))) return
    const threadTs = message.thread_ts ?? message.ts
    const text = (message.text ?? '').replaceAll(`<@${botUserId}>`, '').trim()
    const submission = await delegate.submit(`slack:${message.channel}:${threadTs}`, {
      content: `Slack message from <@${message.user}> in channel ${message.channel}, thread_ts ${threadTs}:\n\n${text}`,
      requestId: `slack:${message.channel}:${message.ts}`,
      origin: { slack: { channel: message.channel, threadTs } },
      create,
    })
    if (submission === undefined) return
    await app.client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'eyes' }).catch(() => undefined)
  }

  app.event('app_mention', async ({ event }) => {
    await accept(event as SlackMessage, true)
  })

  app.message(async ({ message }) => {
    const event = message as SlackMessage
    if (event.subtype !== undefined || event.bot_id !== undefined) return
    if (event.channel_type === 'im') return accept(event, true)
    if (event.thread_ts === undefined || event.text?.includes(`<@${botUserId}>`)) return
    await accept(event, false)
  })

  await app.start()
}
