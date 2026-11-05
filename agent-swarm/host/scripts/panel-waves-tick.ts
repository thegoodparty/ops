import type { ScriptContext } from 'swarm-sdk'
import * as z from 'zod'

// Run on a schedule. Turns panel hand-offs into one coder task each: a new
// hand-off becomes a "schedule" task, and a scheduled wave whose replies are
// due becomes an "export_replies" task. A KV lease per outreach keeps a slow
// task from being started twice. No Slack token or constituent data is read
// here; the hand-off fields come from tevyn-handoffs-new, which this script
// runs through script_run (catalog scripts cannot import each other).

const LEASE_SECONDS = 60 * 60
const REPLIES_DELAY_MS = 48 * 60 * 60 * 1000
const MAX_ATTEMPTS = 5
const PAGE_SIZE = 1000
const HANDOFF_PREFIX = 'handoff:'
const NEW_HANDOFFS_SCRIPT = 'tevyn-handoffs-new'

export const argsSchema = z.object({})

const newHandoffSchema = z.object({
  outreachId: z.string().regex(/^\d+$/),
  sendAt: z.string().datetime(),
  timeZone: z.string().min(1),
  mode: z.enum(['shadow', 'auto']),
  message: z.string(),
  recipientCount: z.number(),
  channel: z.string().min(1),
  ts: z.string().min(1),
})

const scriptRunSchema = z.object({
  data: z.object({
    exitCode: z.number(),
    error: z.string().optional(),
    result: z.unknown().optional(),
  }),
})

const recordSchema = z.object({
  state: z.string(),
  slackTs: z.string().optional(),
  channel: z.string().optional(),
  sendAt: z.string().optional(),
  repliesDueAt: z.string().optional(),
  timeZone: z.string().optional(),
  mode: z.string().optional(),
  message: z.string().optional(),
  recipientCount: z.number().optional(),
  attempts: z.number().optional(),
})

const leaseSchema = z.object({ expiresAt: z.number() })

export type Action = 'schedule' | 'export_replies'

export type Kv = {
  get: (key: string) => Promise<unknown | null>
  set: (key: string, value: unknown, ttlSeconds?: number) => Promise<void>
  delete: (key: string) => Promise<void>
  list: (
    prefix: string,
    offset: number,
  ) => Promise<{ key: string; value: unknown }[]>
}

export type Deps = {
  kv: Kv
  runNewHandoffs: () => Promise<unknown>
  sendTask: (args: { task: string; tags: string[] }) => Promise<string | null>
  now?: () => number
}

export type TickResult = {
  dispatched: { outreachId: string; action: Action; taskId: string }[]
  skipped: { outreachId: string; reason: string }[]
  failed: { outreachId: string; action: Action }[]
}

export const repliesDueAtOf = (sendAt: string): string =>
  new Date(Date.parse(sendAt) + REPLIES_DELAY_MS).toISOString()

export const taskTextFor = (
  action: Action,
  outreachId: string,
  fields: Record<string, unknown>,
): string =>
  `Handle ${outreachId} (${action}) following the scale-to-win-panel-wave skill.\n\n` +
  `handoff: ${JSON.stringify({ action, outreachId, ...fields })}`

const pickAction = (
  record: z.infer<typeof recordSchema>,
  now: number,
  leaseLive: boolean,
): Action | string => {
  if (record.state === 'new' || record.state === 'building') {
    if (record.sendAt === undefined) return 'no hand-off details stored'
    if ((record.attempts ?? 0) >= MAX_ATTEMPTS) return 'attempts exhausted'
    // A building record without a live lease is a task that died mid-run;
    // the skill resumes from the stored state.
    return leaseLive ? 'lease live' : 'schedule'
  }
  if (record.state === 'scheduled') {
    const due =
      record.repliesDueAt ?? (record.sendAt && repliesDueAtOf(record.sendAt))
    if (due === undefined) return 'no hand-off details stored'
    if (now < Date.parse(due)) return 'replies not due'
    if ((record.attempts ?? 0) >= MAX_ATTEMPTS) return 'attempts exhausted'
    return leaseLive ? 'lease live' : 'export_replies'
  }
  return `state ${record.state}`
}

export const run = async (deps: Deps): Promise<TickResult> => {
  const now = deps.now?.() ?? Date.now()
  const result: TickResult = { dispatched: [], skipped: [], failed: [] }

  // tevyn-handoffs-new claims each id as {state:'new', slackTs} before it
  // returns, and never returns it again. Store everything the task needs on
  // that record first, so a tick that dies before sending can be recovered
  // from KV on the next run.
  const fresh = z.array(newHandoffSchema).parse(await deps.runNewHandoffs())
  for (const h of fresh) {
    const existing = await deps.kv.get(`${HANDOFF_PREFIX}${h.outreachId}`)
    await deps.kv.set(`${HANDOFF_PREFIX}${h.outreachId}`, {
      ...(typeof existing === 'object' && existing !== null ? existing : {}),
      state: 'new',
      slackTs: h.ts,
      channel: h.channel,
      sendAt: h.sendAt,
      repliesDueAt: repliesDueAtOf(h.sendAt),
      timeZone: h.timeZone,
      mode: h.mode,
      message: h.message,
      recipientCount: h.recipientCount,
      attempts: 0,
    })
  }

  const entries: { key: string; value: unknown }[] = []
  for (;;) {
    const page = await deps.kv.list(HANDOFF_PREFIX, entries.length)
    entries.push(...page)
    if (page.length < PAGE_SIZE) break
  }

  for (const entry of entries) {
    const outreachId = entry.key.slice(HANDOFF_PREFIX.length)
    const record = recordSchema.safeParse(entry.value)
    if (!record.success) {
      result.skipped.push({ outreachId, reason: 'unreadable record' })
      continue
    }
    const lease = leaseSchema.safeParse(
      await deps.kv.get(`lease:${outreachId}`),
    )
    const leaseLive = lease.success && lease.data.expiresAt > now
    const action = pickAction(record.data, now, leaseLive)
    if (action !== 'schedule' && action !== 'export_replies') {
      // Terminal and waiting states are the normal case; only surface the ones
      // a person has to look at.
      if (
        action === 'attempts exhausted' ||
        action === 'no hand-off details stored'
      ) {
        result.skipped.push({ outreachId, reason: action })
      }
      continue
    }

    await deps.kv.set(
      `lease:${outreachId}`,
      { expiresAt: now + LEASE_SECONDS * 1000 },
      LEASE_SECONDS,
    )
    await deps.kv.set(entry.key, {
      ...(entry.value as object),
      attempts: (record.data.attempts ?? 0) + 1,
    })
    const fields: Record<string, unknown> = {
      sendAt: record.data.sendAt,
      repliesDueAt: record.data.repliesDueAt,
      timeZone: record.data.timeZone,
      mode: record.data.mode,
      channel: record.data.channel,
      ts: record.data.slackTs,
      recipientCount: record.data.recipientCount,
      ...(action === 'schedule' ? { message: record.data.message } : {}),
    }
    const taskId = await deps.sendTask({
      task: taskTextFor(action, outreachId, fields),
      tags: ['panel-wave', action, `outreach-${outreachId}`],
    })
    if (taskId === null) {
      await deps.kv.delete(`lease:${outreachId}`)
      result.failed.push({ outreachId, action })
    } else {
      result.dispatched.push({ outreachId, action, taskId })
    }
  }
  return result
}

const taskIdOf = (sent: unknown): string | null => {
  const parsed = z
    .object({
      id: z.string().optional(),
      task: z.object({ id: z.string() }).optional(),
      data: z
        .object({
          id: z.string().optional(),
          task: z.object({ id: z.string() }).optional(),
        })
        .optional(),
    })
    .safeParse(sent)
  if (!parsed.success) return null
  const d = parsed.data
  return d.data?.task?.id ?? d.data?.id ?? d.task?.id ?? d.id ?? null
}

export default async function (
  _args: z.infer<typeof argsSchema>,
  ctx: ScriptContext,
) {
  const rawAgent = ctx.swarm.config.get('PANEL_WAVE_AGENT_ID')
  if (rawAgent === undefined) throw new Error('PANEL_WAVE_AGENT_ID missing')
  const agentId = ctx.stdlib.Redacted.value(rawAgent)

  const kv: Kv = {
    get: async (key) => (await ctx.swarm.kv_getOrNull({ key }))?.value ?? null,
    set: async (key, value, ttlSeconds) => {
      const res = await ctx.swarm.kv_set({ key, value, ttlSeconds })
      if (!res.success) throw new Error(`KV write failed: ${res.status}`)
    },
    delete: async (key) => {
      await ctx.swarm.kv_delete({ key })
    },
    list: async (prefix, offset) => {
      const res = await ctx.swarm.kv_list({ prefix, offset, limit: PAGE_SIZE })
      if (!res.success) throw new Error(`KV list failed: ${res.status}`)
      return res.data.entries.map((e) => ({ key: e.key, value: e.value }))
    },
  }

  return run({
    kv,
    runNewHandoffs: async () => {
      const res = scriptRunSchema.parse(
        await ctx.swarm.script_run({ name: NEW_HANDOFFS_SCRIPT, args: {} }),
      )
      if (res.data.exitCode !== 0) {
        throw new Error(
          `${NEW_HANDOFFS_SCRIPT} failed: exit ${res.data.exitCode}${res.data.error ? ` ${res.data.error}` : ''}`,
        )
      }
      return res.data.result
    },
    sendTask: async ({ task, tags }) => {
      // allowDuplicate: two waves posted close together read as near-copies
      // to the duplicate check; the lease is what prevents a double start.
      const sent = await ctx.swarm.task_send({
        agentId,
        routingReason: 'skill',
        routingNote:
          'Panel wave hand-off for the scale-to-win-panel-wave skill',
        task,
        modelTier: 'regular',
        tags,
        allowDuplicate: true,
      })
      return taskIdOf(sent)
    },
  })
}
