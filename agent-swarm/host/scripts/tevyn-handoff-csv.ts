import type { ScriptContext } from 'swarm-sdk'
import * as z from 'zod'

// Saves a hand-off post's recipient CSV to agent-fs and returns only the local
// path. The Slack file URL and the bot token never leave this script, and the
// CSV holds constituent data, so no error message includes its content.

const SLACK_API = 'https://slack.com/api'
const TIMEOUT_MS = 20_000
const WORK_DIR = '/afs/tevyn-handoffs'

export const argsSchema = z.object({
  channel: z.string().regex(/^[A-Z0-9]+$/),
  ts: z.string().regex(/^\d+\.\d+$/),
})

const historySchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  messages: z
    .array(
      z.object({
        ts: z.string(),
        files: z
          .array(
            z.object({
              name: z.string().optional(),
              url_private_download: z.string().url().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
})

type Fetch = (url: string, init?: RequestInit) => Promise<Response>
type FsLike = Pick<ScriptContext['fs'], 'writeFile' | 'mkdir'>

export type Deps = {
  fetchFn: Fetch
  fs: FsLike
  token: string
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

export const run = async (
  args: z.infer<typeof argsSchema>,
  deps: Deps,
): Promise<{ path: string }> => {
  const headers = { authorization: `Bearer ${deps.token}` }
  const params = new URLSearchParams({
    channel: args.channel,
    oldest: args.ts,
    latest: args.ts,
    inclusive: 'true',
    limit: '1',
  })
  const historyRes = await timedFetch(
    deps.fetchFn,
    `${SLACK_API}/conversations.history?${params.toString()}`,
    { headers },
    'Slack history',
  )
  if (!historyRes.ok) {
    throw new Error(`Slack history failed: ${historyRes.status}`)
  }
  const history = historySchema.safeParse(await historyRes.json())
  if (!history.success) throw new Error('Slack history response invalid')
  if (!history.data.ok) {
    throw new Error(`Slack history failed: ${history.data.error ?? 'unknown'}`)
  }
  const message = history.data.messages?.find((m) => m.ts === args.ts)
  if (!message) throw new Error('post not found')
  const file = message.files?.find(
    (f) => f.url_private_download && f.name?.toLowerCase().endsWith('.csv'),
  )
  if (!file?.url_private_download) throw new Error('post has no CSV file')

  const csvRes = await timedFetch(
    deps.fetchFn,
    file.url_private_download,
    { headers },
    'recipient CSV download',
  )
  if (!csvRes.ok) {
    throw new Error(`recipient CSV download failed: ${csvRes.status}`)
  }
  // A lost token makes Slack answer 200 with its sign-in page.
  if (csvRes.headers.get('content-type')?.includes('text/html')) {
    throw new Error('recipient CSV download returned a web page')
  }
  const csv = await csvRes.text()
  const path = `${WORK_DIR}/${args.channel}-${args.ts}.csv`
  await deps.fs.mkdir(WORK_DIR, { recursive: true })
  await deps.fs.writeFile(path, csv)
  return { path }
}

export default async function (
  args: z.infer<typeof argsSchema>,
  ctx: ScriptContext,
) {
  const raw = ctx.swarm.config.get('SLACK_BOT_TOKEN')
  if (raw === undefined) throw new Error('SLACK_BOT_TOKEN missing')
  return run(args, {
    fetchFn: (url, init) => fetch(url, init),
    fs: ctx.fs,
    token: ctx.stdlib.Redacted.value(raw),
  })
}
