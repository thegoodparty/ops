import type { ScriptContext } from 'swarm-sdk'
import * as z from 'zod'

// Replies in a hand-off post's thread, optionally with a screenshot. Worker
// agents have no Slack tools of their own (posting and uploading are lead-only
// in agent-swarm), so the coder goes through this script. The Slack token stays
// here and errors are built from status codes and Slack's error code, never
// from a URL or response body. The text is refused when it looks like it holds
// a phone number, because the thread is a channel and replies carry
// constituent data. The screenshot is deleted from agent-fs once uploaded.

const SLACK_API = 'https://slack.com/api'
const TIMEOUT_MS = 20_000
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/

export const argsSchema = z.object({
  channel: z.string().regex(/^[A-Z0-9]+$/),
  ts: z.string().regex(/^\d+\.\d+$/),
  text: z.string().min(1).max(3000),
  filePath: z.string().optional(),
})

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export type Deps = {
  fetchFn: Fetch
  token: string
  readBase64: (path: string) => Promise<string>
  rm: (path: string) => Promise<void>
}

const slackOk = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  ts: z.string().optional(),
  upload_url: z.string().url().optional(),
  file_id: z.string().optional(),
})

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

const slackCall = async (
  deps: Deps,
  method: string,
  init: { body: string; contentType: string },
): Promise<z.infer<typeof slackOk>> => {
  const res = await timedFetch(
    deps.fetchFn,
    `${SLACK_API}/${method}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deps.token}`,
        'content-type': init.contentType,
      },
      body: init.body,
    },
    `Slack ${method}`,
  )
  if (!res.ok) throw new Error(`Slack ${method} failed: ${res.status}`)
  const parsed = slackOk.safeParse(await res.json())
  if (!parsed.success) throw new Error(`Slack ${method} response invalid`)
  if (!parsed.data.ok) {
    throw new Error(`Slack ${method} failed: ${parsed.data.error ?? 'unknown'}`)
  }
  return parsed.data
}

const json = (body: unknown) => ({
  body: JSON.stringify(body),
  contentType: 'application/json; charset=utf-8',
})

export const run = async (
  args: z.infer<typeof argsSchema>,
  deps: Deps,
): Promise<{ posted: true; withFile: boolean }> => {
  if (PHONE.test(args.text)) {
    throw new Error('text looks like it contains a phone number')
  }
  const { filePath } = args
  if (filePath === undefined) {
    await slackCall(
      deps,
      'chat.postMessage',
      json({ channel: args.channel, thread_ts: args.ts, text: args.text }),
    )
    return { posted: true, withFile: false }
  }

  if (
    !/^\/afs\/[\w./-]+$/.test(filePath) ||
    filePath.split('/').includes('..')
  ) {
    throw new Error('filePath must be under /afs')
  }
  if (!/\.(png|jpe?g)$/i.test(filePath)) {
    throw new Error('filePath must be a png or jpg')
  }
  const binary = atob(await deps.readBase64(filePath))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  if (bytes.length === 0) throw new Error('screenshot is empty')
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('screenshot is too large')
  const filename = filePath.split('/').pop() ?? 'screenshot.png'

  const slot = await slackCall(deps, 'files.getUploadURLExternal', {
    body: new URLSearchParams({
      filename,
      length: String(bytes.length),
    }).toString(),
    contentType: 'application/x-www-form-urlencoded',
  })
  if (!slot.upload_url || !slot.file_id) {
    throw new Error('Slack files.getUploadURLExternal response invalid')
  }
  const upload = await timedFetch(
    deps.fetchFn,
    slot.upload_url,
    { method: 'POST', body: bytes },
    'screenshot upload',
  )
  if (!upload.ok) throw new Error(`screenshot upload failed: ${upload.status}`)
  await slackCall(
    deps,
    'files.completeUploadExternal',
    json({
      files: [{ id: slot.file_id, title: filename }],
      channel_id: args.channel,
      thread_ts: args.ts,
      initial_comment: args.text,
    }),
  )
  await deps.rm(filePath)
  return { posted: true, withFile: true }
}

export default async function (
  args: z.infer<typeof argsSchema>,
  ctx: ScriptContext,
) {
  const raw = ctx.swarm.config.get('SLACK_BOT_TOKEN')
  if (raw === undefined) throw new Error('SLACK_BOT_TOKEN missing')
  return run(args, {
    fetchFn: (url, init) => fetch(url, init),
    token: ctx.stdlib.Redacted.value(raw),
    // The script filesystem is text only, so the image is read as base64
    // through the shell's base64 command.
    readBase64: async (path) => {
      const res = await ctx.sh(`base64 '${path}'`)
      if (res.exitCode !== 0) throw new Error('screenshot read failed')
      return res.stdout.replace(/\s+/g, '')
    },
    rm: (path) => ctx.fs.rm(path),
  })
}
