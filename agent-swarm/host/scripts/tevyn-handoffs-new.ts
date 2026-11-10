import type { ScriptContext } from 'swarm-sdk'
import * as z from 'zod'

// Finds gp-api agent hand-off posts in #tevyn-api that this swarm has not
// returned before. The Slack token stays in this script; errors are built from
// status codes and Slack's error code, never from a URL or response body.
//
// A post that carries the handling note but cannot be read is not dropped: it
// is reported as unreadable, its thread gets one warning reply, and the cursor
// stops short of it so Slack history still covers it on the next run.

const SLACK_API = 'https://slack.com/api'
const TIMEOUT_MS = 10_000
const PAGE_SIZE = 200
const MAX_PAGES = 5
const FIRST_RUN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const CURSOR_KEY = 'tevyn:cursor'
const HANDLING_NOTE_MARKER = 'Delegate is handling this wave'
const UNPARSED_PREFIX = 'unparsed:'
const RELEASE_MS = 48 * 60 * 60 * 1000
const REPLY_SCRIPT = 'tevyn-thread-reply'
const UNREADABLE_REPLY =
  'Automated panel-wave dispatcher could not read this hand-off post, so ' +
  'nothing was scheduled from it. A person needs to check this post and ' +
  'handle the wave by hand.'

export const argsSchema = z.object({})

// A rich text element carries its text as a string, but an action button
// carries a plain_text object. Both shapes appear in a hand-off post (the
// "Upload results CSV" button), so accept either.
const elementTextSchema = z.union([
  z.string(),
  z.object({ text: z.string().optional() }),
])

const richElementSchema = z.object({
  type: z.string(),
  text: elementTextSchema.optional(),
  elements: z
    .array(z.object({ type: z.string(), text: elementTextSchema.optional() }))
    .optional(),
})

const blockSchema = z.object({
  type: z.string(),
  text: z.object({ text: z.string() }).optional(),
  elements: z.array(richElementSchema).optional(),
})

const messageSchema = z.object({
  ts: z.string(),
  blocks: z.array(blockSchema).optional().catch(undefined),
})

const historySchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  messages: z.array(messageSchema).optional(),
  response_metadata: z
    .object({ next_cursor: z.string().optional() })
    .optional(),
})

const replyRunSchema = z.object({
  data: z.object({ exitCode: z.number(), error: z.string().optional() }),
})

export const handoffBlockSchema = z.object({
  outreachId: z.string().regex(/^\d+$/),
  sendAt: z.string().datetime(),
  timeZone: z.string().min(1),
  mode: z.enum(['shadow', 'auto']),
  env: z.string().min(1),
  repliesKey: z.string().min(1),
})

export type Handoff = z.infer<typeof handoffBlockSchema> & {
  message: string
  recipientCount: number
  channel: string
  ts: string
}

type Block = z.infer<typeof blockSchema>
type Message = z.infer<typeof messageSchema>
type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export type Kv = {
  get: (key: string) => Promise<unknown | null>
  set: (key: string, value: unknown) => Promise<void>
}

export type Reply = (args: {
  channel: string
  ts: string
  text: string
}) => Promise<void>

export type Deps = {
  fetchFn: Fetch
  kv: Kv
  token: string
  channel: string
  env: string
  reply: Reply
  now?: () => number
}

const timedFetch = async (
  fetchFn: Fetch,
  url: string,
  init: RequestInit,
  what: string,
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetchFn(url, { ...init, signal: controller.signal })
  } catch {
    throw new Error(`${what} request failed`)
  } finally {
    clearTimeout(timer)
  }
}

const sectionTexts = (blocks: Block[]): string[] =>
  blocks.flatMap((b) => (b.type === 'section' && b.text ? [b.text.text] : []))

const parseMachineBlock = (texts: string[]): Record<string, string> | null => {
  const fenced = texts
    .map((t) => /^```\n?([\s\S]*?)\n?```$/.exec(t.trim())?.[1])
    .find((inner) => inner !== undefined && inner.includes('outreachId:'))
  if (fenced === undefined) return null
  const fields: Record<string, string> = {}
  for (const line of fenced.split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return fields
}

const textOf = (text: unknown): string =>
  typeof text === 'string'
    ? text
    : ((text as { text?: string } | undefined)?.text ?? '')

const quotedMessage = (blocks: Block[]): string =>
  blocks
    .flatMap((b) => b.elements ?? [])
    .filter((e) => e.type === 'rich_text_quote')
    .flatMap((e) => e.elements ?? [])
    .map((e) => textOf(e.text))
    .join('')

export type UnreadableReason =
  | 'no machine block'
  | 'invalid fields'
  | 'replies key mismatch'

type Classification =
  | { kind: 'handoff'; handoff: Handoff }
  | { kind: 'not-handoff' }
  | { kind: 'unreadable'; reason: UnreadableReason }

// Detection is separate from parsing. The handling note is what makes a post
// ours to act on, so once it is there a post that does not parse has to reach a
// person: dropping it loses the wave with no trace.
const classify = (message: Message, channel: string): Classification => {
  const blocks = message.blocks
  if (!blocks) return { kind: 'not-handoff' }
  const texts = sectionTexts(blocks)
  if (!texts.some((t) => t.includes(HANDLING_NOTE_MARKER))) {
    return { kind: 'not-handoff' }
  }
  const fields = parseMachineBlock(texts)
  if (!fields) return { kind: 'unreadable', reason: 'no machine block' }
  const block = handoffBlockSchema.safeParse(fields)
  if (!block.success) return { kind: 'unreadable', reason: 'invalid fields' }
  if (block.data.repliesKey !== `agent-replies/${block.data.outreachId}.csv`) {
    return { kind: 'unreadable', reason: 'replies key mismatch' }
  }
  const recipients = texts
    .map((t) => /^\*Recipients:\*\s*(\d+)\s*$/.exec(t.trim())?.[1])
    .find((n) => n !== undefined)
  return {
    kind: 'handoff',
    handoff: {
      ...block.data,
      message: quotedMessage(blocks),
      recipientCount: recipients === undefined ? 0 : Number(recipients),
      channel,
      ts: message.ts,
    },
  }
}

export const parseHandoff = (
  message: Message,
  channel: string,
): Handoff | null => {
  const classified = classify(message, channel)
  return classified.kind === 'handoff' ? classified.handoff : null
}

const compareTs = (a: string, b: string): number => Number(a) - Number(b)

const fetchHistory = async (
  deps: Deps,
  oldest: string,
): Promise<Message[]> => {
  const messages: Message[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      channel: deps.channel,
      oldest,
      limit: String(PAGE_SIZE),
    })
    if (cursor) params.set('cursor', cursor)
    const res = await timedFetch(
      deps.fetchFn,
      `${SLACK_API}/conversations.history?${params.toString()}`,
      { headers: { authorization: `Bearer ${deps.token}` } },
      'Slack history',
    )
    if (!res.ok) throw new Error(`Slack history failed: ${res.status}`)
    const parsed = historySchema.safeParse(await res.json())
    if (!parsed.success) throw new Error('Slack history response invalid')
    if (!parsed.data.ok) {
      throw new Error(`Slack history failed: ${parsed.data.error ?? 'unknown'}`)
    }
    messages.push(...(parsed.data.messages ?? []))
    cursor = parsed.data.response_metadata?.next_cursor || undefined
    if (!cursor) break
  }
  // Slack pages newest first, so leftover pages are the older posts; moving
  // the cursor past them would skip their hand-offs for good.
  if (cursor) throw new Error('Slack history exceeded the page limit')
  return messages
}

const unparsedKey = (ts: string): string => `${UNPARSED_PREFIX}${ts}`

const postedAtOf = (record: unknown): number | null => {
  const parsed = z.object({ postedAt: z.string() }).safeParse(record)
  if (!parsed.success) return null
  const at = Date.parse(parsed.data.postedAt)
  return Number.isNaN(at) ? null : at
}

export type Unreadable = {
  ts: string
  reason: UnreadableReason
  // True when the warning reply is in the thread, whether this run posted it or
  // an earlier one did.
  posted: boolean
  // Set once the post stops holding the cursor: after 48h a person has had the
  // warning, and a post that cannot be read must not stall discovery forever.
  released?: true
}

export type RunResult = { handoffs: Handoff[]; unreadable: Unreadable[] }

export const run = async (deps: Deps): Promise<RunResult> => {
  const stored = await deps.kv.get(CURSOR_KEY)
  const now = deps.now?.() ?? Date.now()
  const oldest =
    typeof stored === 'string'
      ? stored
      : ((now - FIRST_RUN_LOOKBACK_MS) / 1000).toFixed(6)

  const messages = (await fetchHistory(deps, oldest)).sort((a, b) =>
    compareTs(a.ts, b.ts),
  )
  if (messages.length === 0) return { handoffs: [], unreadable: [] }

  const fresh: Handoff[] = []
  const unreadable: Unreadable[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    const classified = classify(message, deps.channel)
    if (classified.kind === 'not-handoff') continue
    if (classified.kind === 'unreadable') {
      unreadable.push({
        ts: message.ts,
        reason: classified.reason,
        posted: false,
      })
      continue
    }
    const { handoff } = classified
    // A post from the other environment parses fine and belongs to that
    // environment's run, so it is a silent skip, never an unreadable one.
    if (handoff.env !== deps.env) continue
    if (seen.has(handoff.outreachId)) continue
    if ((await deps.kv.get(`handoff:${handoff.outreachId}`)) !== null) continue
    seen.add(handoff.outreachId)
    fresh.push(handoff)
  }

  // Claim after every Slack read has succeeded, so a failed fetch cannot
  // consume ids it never returned. The claim holds everything a later task
  // needs, so an id that is never returned again can still be handled from KV.
  // The cursor moves last.
  for (const handoff of fresh) {
    await deps.kv.set(`handoff:${handoff.outreachId}`, {
      state: 'new',
      slackTs: handoff.ts,
      channel: handoff.channel,
      sendAt: handoff.sendAt,
      timeZone: handoff.timeZone,
      mode: handoff.mode,
      message: handoff.message,
      recipientCount: handoff.recipientCount,
    })
  }

  for (const entry of unreadable) {
    const postedAt = postedAtOf(await deps.kv.get(unparsedKey(entry.ts)))
    if (postedAt !== null && now - postedAt > RELEASE_MS) entry.released = true
    if (postedAt !== null) {
      entry.posted = true
      continue
    }
    try {
      await deps.reply({
        channel: deps.channel,
        ts: entry.ts,
        text: UNREADABLE_REPLY,
      })
    } catch {
      // A warning that cannot be posted must not fail the run: the post stays
      // in the result with posted: false and the cursor holds for a retry.
      continue
    }
    // Written only after the reply lands, so a failed reply is retried and a
    // second run never posts a second warning.
    await deps.kv.set(unparsedKey(entry.ts), {
      postedAt: new Date(now).toISOString(),
      reason: entry.reason,
    })
    entry.posted = true
  }

  const blocking = unreadable.find((entry) => entry.released !== true)
  // Stop the cursor just before the oldest post a person still has to read, so
  // Slack history covers it next run. When that post is the first message in
  // the window there is nothing older to point at, so the stored cursor stays
  // where it is and its window is not narrowed away.
  const cursor =
    blocking === undefined
      ? messages[messages.length - 1].ts
      : messages.filter((m) => compareTs(m.ts, blocking.ts) < 0).at(-1)?.ts
  if (cursor !== undefined) await deps.kv.set(CURSOR_KEY, cursor)
  return { handoffs: fresh, unreadable }
}

export default async function (
  _args: z.infer<typeof argsSchema>,
  ctx: ScriptContext,
) {
  const need = (key: string): string => {
    const raw = ctx.swarm.config.get(key)
    if (raw === undefined) throw new Error(`${key} missing`)
    return ctx.stdlib.Redacted.value(raw)
  }
  const kv: Kv = {
    get: async (key) => (await ctx.swarm.kv_getOrNull({ key }))?.value ?? null,
    set: async (key, value) => {
      const res = await ctx.swarm.kv_set({ key, value })
      if (!res.success) throw new Error(`KV write failed: ${res.status}`)
    },
  }
  return run({
    fetchFn: (url, init) => fetch(url, init),
    kv,
    token: need('SLACK_BOT_TOKEN'),
    channel: need('TEVYN_API_CHANNEL_ID'),
    env: need('HANDOFF_ENV'),
    reply: async ({ channel, ts, text }) => {
      const res = replyRunSchema.parse(
        await ctx.swarm.script_run({
          name: REPLY_SCRIPT,
          args: { channel, ts, text },
        }),
      )
      if (res.data.exitCode !== 0) {
        throw new Error(
          `${REPLY_SCRIPT} failed: exit ${res.data.exitCode}${res.data.error ? ` ${res.data.error}` : ''}`,
        )
      }
    },
  })
}
