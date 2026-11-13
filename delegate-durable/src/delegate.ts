import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { Models } from '@earendil-works/pi-ai/models'
import {
  AssistantEntry,
  configure,
  type ConversationId,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type EntryId,
  type Extension,
  GenerationTask,
  Harness,
  hook,
  LiveDoc,
  type ModelRef,
  type Report,
  runEndTask,
  section,
  type SetTimer,
  type TaskId,
  type Tx,
  UsageDoc,
  type UsageState,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { Cron } from 'croner'

const context = BACKGROUND_CONTEXT
const run = promisify(execFile)

export type Origin = {
  slack?: { channel: string; threadTs?: string }
  github?: { repo: string; number: number }
}

export type PostSlack = (post: { channel: string; threadTs?: string; text: string }) => Promise<{ ts?: string }>
export type PostGithub = (post: { repo: string; number: number; text: string }) => Promise<void>

export type SubmitOptions = {
  content: string
  requestId: string
  origin?: Origin
  create?: boolean
}

type Schedule = {
  id: string
  cron?: string
  at?: string
  prompt: string
  slackChannel?: string
  slackThreadTs?: string
  taskId: number
  nextAt: number
}

const Routes = defineDoc<{ routes: Record<string, number> }>({
  kind: 'delegate.routes',
  version: 1,
  scope: 'session',
  initial: () => ({ routes: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 100,
})

const Schedules = defineDoc<{ items: Record<string, Schedule> }>({
  kind: 'delegate.schedules',
  version: 1,
  scope: 'session',
  initial: () => ({ items: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 100,
})

export const answerText = (message: Message | undefined) =>
  message?.role === 'assistant'
    ? (message as AssistantMessage).content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('').trim()
    : ''

const json = (value: unknown) => JSON.parse(JSON.stringify(value))

const costOf = (usage: Readonly<UsageState> | undefined) =>
  Object.values({ ...usage?.models, ...usage?.tools }).reduce((sum, item) => sum + (item.cost?.total ?? 0), 0)

const frontmatter = (text: string) => {
  const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
  const field = (name: string) => {
    const lines = block.split('\n')
    const start = lines.findIndex((line) => line.startsWith(`${name}:`))
    if (start === -1) return undefined
    const inline = lines[start].slice(name.length + 1).trim()
    if (inline !== '>' && inline !== '|' && inline !== '>-' && inline !== '|-') return inline.replace(/^["']|["']$/g, '')
    const rest = lines.slice(start + 1)
    const end = rest.findIndex((line) => !line.startsWith(' '))
    return (end === -1 ? rest : rest.slice(0, end)).map((line) => line.trim()).join(' ')
  }
  return { name: field('name'), description: field('description') }
}

const nextFire = (schedule: { cron?: string; at?: string }, after: number) => {
  if (schedule.at !== undefined) {
    const at = Date.parse(schedule.at)
    if (Number.isNaN(at)) throw new Error(`Invalid at time: ${schedule.at}`)
    return at > after ? at : undefined
  }
  return new Cron(schedule.cron ?? '', { timezone: 'UTC' }).nextRun(new Date(after))?.getTime()
}

const shellEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(SLACK_|ANTHROPIC_|DELEGATE_AUTH|GITHUB_WEBHOOK_SECRET)/.test(key),
    ),
  )

export const openDelegate = async (options: {
  dataDir: string
  omniRepo?: string
  models: Models
  model: ModelRef
  persona: string
  postSlack: PostSlack
  postGithub: PostGithub
  homeChannel?: string
  now?: () => number
  setTimer?: SetTimer
  onReport?: (report: Report) => void
}) => {
  const { dataDir, models, model, postSlack, postGithub, homeChannel } = options
  const omniRepo = options.omniRepo ?? join(dataDir, 'omni')
  const worktreesDir = join(dataDir, 'worktrees')
  const memoryDir = join(dataDir, 'memory')
  await mkdir(worktreesDir, { recursive: true })
  await mkdir(memoryDir, { recursive: true })

  const lockFile = join(dataDir, 'agent.lock')
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, 'utf8'))
    const alive = (() => {
      try {
        return process.kill(pid, 0)
      } catch {
        return false
      }
    })()
    if (alive && pid !== process.pid) throw new Error(`${dataDir} is in use by process ${pid}`)
  }
  writeFileSync(lockFile, String(process.pid))

  const worktrees = new Map<string, Promise<void>>()
  let gitQueue = Promise.resolve()
  const ensureWorktree = (dir: string) => {
    const known = worktrees.get(dir)
    if (known !== undefined) return known
    const created = (gitQueue = gitQueue.then(async () => {
      if (existsSync(join(dir, '.git'))) return
      if (!existsSync(join(omniRepo, '.git'))) throw new Error(`No omni clone at ${omniRepo}`)
      await run('git', ['-C', omniRepo, 'fetch', '--quiet', 'origin', 'main']).catch(() => undefined)
      await run('git', ['-C', omniRepo, 'worktree', 'add', '--detach', dir, 'origin/main'])
    }))
    gitQueue = created.catch(() => undefined)
    worktrees.set(dir, created)
    created.catch(() => worktrees.delete(dir))
    return created
  }

  const ensureConversation = async (tx: Tx, key: string) => {
    const routes = await tx.doc(Routes)
    const existing = routes.routes[key]
    if (existing !== undefined) return existing as ConversationId
    const created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, created.id, { model, cwd: join(worktreesDir, String(created.id)) })
    routes.routes[key] = created.id
    return created.id
  }

  let harness: Harness | undefined

  const PostAnswer = defineTask<{ origin: Origin; text: string }, { phase: 'post' }, null>({
    name: 'delegate.post-answer',
    version: 1,
    initial: () => ({ phase: 'post' }),
    phases: {
      post: async (task, runtime, taskContext) => {
        const { origin, text } = task.input
        if (origin.slack !== undefined) {
          const { channel, threadTs } = origin.slack
          const { ts } = await postSlack({ channel, threadTs, text })
          if (threadTs === undefined && ts !== undefined) {
            await runtime.commit(async (tx) => {
              ;(await tx.doc(Routes)).routes[`slack:${channel}:${ts}`] = runtime.conversationId
              return undefined
            }, taskContext)
          }
        }
        if (origin.github !== undefined) await postGithub({ ...origin.github, text })
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), taskContext)
      },
    },
    abort: (_task, runtime, taskContext) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), taskContext),
  })

  const ScheduleTask = defineTask<
    { scheduleId: string; firstAt: number },
    { phase: 'sleep'; until: number } | { phase: 'fire'; at: number },
    null
  >({
    name: 'delegate.schedule',
    version: 1,
    initial: (input) => ({ phase: 'sleep', until: input.firstAt }),
    phases: {
      sleep: (task, runtime, taskContext) =>
        runtime.sleepUntil(task.state.checkpoint.until, { phase: 'fire', at: task.state.checkpoint.until }, taskContext),
      fire: async (task, runtime, taskContext) => {
        const { scheduleId } = task.input
        const at = task.state.checkpoint.at
        const schedule = (await runtime.snapshot(Schedules, taskContext))?.items[scheduleId]
        if (schedule === undefined) {
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), taskContext)
          return
        }
        const { slackChannel, slackThreadTs } = schedule
        const key =
          slackChannel !== undefined && slackThreadTs !== undefined
            ? `slack:${slackChannel}:${slackThreadTs}`
            : `schedule:${scheduleId}`
        let conversationId: ConversationId | undefined
        await runtime.commit(async (tx) => {
          conversationId = await ensureConversation(tx, key)
          return undefined
        }, taskContext)
        const handle = (await runtime.conversation(conversationId!, taskContext))!
        const channel = slackChannel ?? homeChannel
        const origin: Origin =
          channel === undefined ? {} : { slack: slackThreadTs === undefined ? { channel } : { channel, threadTs: slackThreadTs } }
        const next = schedule.cron === undefined ? undefined : nextFire(schedule, Math.max(at, runtime.now()))
        await runtime.commit(async (tx) => {
          await handle.submit(tx, {
            type: 'input',
            content: `Scheduled job ${scheduleId} fired at ${new Date(at).toISOString()}:\n\n${schedule.prompt}`,
            requestId: `schedule:${scheduleId}:${at}`,
            entry: { kind: 'delegate.input', data: { origin: json(origin) } },
          })
          const schedules = await tx.doc(Schedules)
          if (next === undefined) {
            delete schedules.items[scheduleId]
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }
          const item = schedules.items[scheduleId]
          if (item !== undefined) item.nextAt = next
          return { status: 'sleeping', until: next, checkpoint: { phase: 'fire', at: next } }
        }, taskContext)
      },
    },
    abort: (_task, runtime, taskContext) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), taskContext),
  })

  const persona = options.persona.replaceAll('{{MEMORY_DIR}}', memoryDir)

  const Delegate = defineExtension({
    name: 'delegate',
    tasks: [PostAnswer, ScheduleTask],
    sections: [
      section('persona', () => persona, { tag: false }),
      section('omni_agents_md', async (input) => {
        const cwd = input.agent.cwd
        if (cwd === undefined) return undefined
        await ensureWorktree(cwd)
        return readFile(join(cwd, 'AGENTS.md'), 'utf8').catch(() => undefined)
      }),
      section('omni_skills', async (input) => {
        const cwd = input.agent.cwd
        if (cwd === undefined) return undefined
        await ensureWorktree(cwd)
        const skillsDir = join(cwd, '.claude', 'skills')
        const names = await readdir(skillsDir).catch(() => [] as string[])
        const lines = await Promise.all(
          names.sort().map(async (dir) => {
            const path = join(skillsDir, dir, 'SKILL.md')
            const text = await readFile(path, 'utf8').catch(() => undefined)
            if (text === undefined) return undefined
            const { name, description } = frontmatter(text)
            return `- ${name ?? dir}: ${description ?? ''} (${path})`
          }),
        )
        const found = lines.filter((line) => line !== undefined)
        return found.length === 0 ? undefined : found.join('\n')
      }),
      section('workspace', (input) => `Working directory: ${input.agent.cwd}\nMemory directory: ${memoryDir}`),
    ],
    hooks: [
      hook(GenerationTask, {
        afterRun: async (summary, api, hookContext) => {
          const range = { minEntryId: summary.first, maxEntryId: summary.last, order: 'ascending' } as const
          const { items } = await api.entries(range, 1000, undefined, hookContext)
          const origins = new Map<string, Origin>()
          for (const entry of items) {
            if (entry.kind !== 'delegate.input') continue
            const origin = (entry.data as { origin: Origin }).origin
            if (origin.slack !== undefined || origin.github !== undefined) origins.set(JSON.stringify(origin), origin)
          }
          if (origins.size === 0) return undefined
          const answer = await api.entry(AssistantEntry, summary.answer, hookContext)
          const text = answerText(answer?.model?.[0])
          if (text === '') return undefined
          return { tasks: [...origins.values()].map((origin) => runEndTask(PostAnswer, { origin: json(origin), text })) }
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'link_pr',
        description:
          'Link a pull request to this conversation, so later comments on it come back here. Call it right after you open a PR.',
        parameters: obj({
          repo: str({ description: 'owner/name, for example thegoodparty/omni' }),
          number: int({ description: 'Pull request number' }),
        }),
        execute: async (args, api, callContext) => {
          const key = `github:${args.repo}:pr:${args.number}`
          await api.commit(async (tx) => {
            let id = api.conversationId
            for (let record = await tx.conversation(id); record?.owner !== undefined; record = await tx.conversation(id)) {
              id = record.owner.conversationId
            }
            ;(await tx.doc(Routes)).routes[key] = id
          }, callContext)
          return { output: [{ type: 'text', text: `Linked ${key} to this conversation.` }] }
        },
      }),
      defineTool({
        name: 'schedule_create',
        description:
          'Create a scheduled job. Give exactly one of cron (5 fields, UTC) or at (ISO 8601 time). When it fires, prompt runs as a new message and the answer is posted to slack_channel (and slack_thread_ts, when given).',
        parameters: obj({
          cron: opt(str({ description: 'Cron expression in UTC, for example "0 16 * * 1-5"' })),
          at: opt(str({ description: 'One-off time, ISO 8601, for example 2026-01-05T16:00:00Z' })),
          prompt: str({ description: 'What to do when the job fires' }),
          slack_channel: opt(str({ description: 'Slack channel id to post the answer to' })),
          slack_thread_ts: opt(str({ description: 'Slack thread ts to post into and continue' })),
        }),
        execute: async (args, api, callContext) => {
          if ((args.cron === undefined) === (args.at === undefined)) throw new Error('Give exactly one of cron or at')
          const firstAt = nextFire(args, api.now())
          if (firstAt === undefined) throw new Error('That time is in the past')
          const id = randomUUID().slice(0, 8)
          await api.commit(async (tx) => {
            const taskId = await tx.createTask(
              ScheduleTask,
              { scheduleId: id, firstAt },
              { ownership: { kind: 'conversation' }, background: true },
            )
            const schedule: Schedule = { id, prompt: args.prompt, taskId, nextAt: firstAt }
            if (args.cron !== undefined) schedule.cron = args.cron
            if (args.at !== undefined) schedule.at = args.at
            if (args.slack_channel !== undefined) schedule.slackChannel = args.slack_channel
            if (args.slack_thread_ts !== undefined) schedule.slackThreadTs = args.slack_thread_ts
            ;(await tx.doc(Schedules)).items[id] = schedule
          }, callContext)
          return {
            output: [{ type: 'text', text: `Created schedule ${id}; first run ${new Date(firstAt).toISOString()}.` }],
          }
        },
      }),
      defineTool({
        name: 'schedule_list',
        description: 'List scheduled jobs.',
        parameters: obj({}),
        execute: async (_args, api, callContext) => {
          const items = Object.values((await api.snapshot(Schedules, callContext))?.items ?? {})
          const text = items.map((item) => JSON.stringify({ ...item, nextAt: new Date(item.nextAt).toISOString() }))
          return { output: [{ type: 'text', text: text.length === 0 ? 'No schedules.' : text.join('\n') }] }
        },
      }),
      defineTool({
        name: 'schedule_delete',
        description: 'Delete a scheduled job by id.',
        parameters: obj({ id: str() }),
        execute: async (args, api, callContext) => {
          const taskId = await api.commit(async (tx) => {
            const schedules = await tx.doc(Schedules)
            const item = schedules.items[args.id]
            if (item === undefined) return undefined
            delete schedules.items[args.id]
            return item.taskId
          }, callContext)
          if (taskId === undefined) throw new Error(`No schedule ${args.id}`)
          await harness?.abortTask(taskId as TaskId, callContext)
          return { output: [{ type: 'text', text: `Deleted schedule ${args.id}.` }] }
        },
      }),
    ],
  })

  const Subagent: Extension = defineExtension({
    name: 'subagent',
    tools: [
      defineTool({
        name: 'subagent',
        description:
          'Hand a self-contained task to a subagent that works in the same worktree, and get its answer back. Give it all the context it needs.',
        parameters: obj({ task: str({ description: 'What the subagent should do' }) }),
        replay: 'safe',
        execute: async (args, api, callContext) => {
          const child = await api.commit(async (tx) => {
            const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0]
            if (existing !== undefined) return existing.id
            const created = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } })
            await configure(tx, created.id, { extensions: { remove: [Subagent] } })
            return created.id
          }, callContext)
          await api.details({ conversationId: child }, callContext)
          const handle = (await api.conversation(child, callContext))!
          const request = { type: 'input', content: args.task, requestId: `subagent:${api.taskId}` } as const
          const settled = await (await handle.submit(request, callContext)).wait(callContext)
          if (settled.status !== 'done' || settled.type !== 'input') throw new Error(`Subagent ended ${settled.status}`)
          const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), callContext)
          return { output: [{ type: 'text', text: answerText(entry?.model?.[0]) }], details: { conversationId: child } }
        },
      }),
    ],
  })

  const registry = createRegistry()
  registry.install(CodingTools)
  registry.install(Delegate)
  registry.install(Subagent)

  harness = await Harness.open(
    await openNodeSqliteStorage(join(dataDir, 'agent.sqlite')),
    {
      models,
      registry,
      settings: { toolExecution: 'parallel', afterFailedRun: 'continue' },
      env: async ({ cwd }) => {
        if (cwd === undefined) return undefined
        await ensureWorktree(cwd)
        return new NodeExecutionEnv({ cwd, shellEnv: shellEnv() })
      },
      now: options.now,
      setTimer: options.setTimer,
      onReport: options.onReport,
    },
    context,
  )
  const opened = harness

  const route = async (key: string) => (await opened.snapshot(Routes, context))?.routes[key] as ConversationId | undefined

  const submit = async (key: string, submission: SubmitOptions) => {
    const id =
      submission.create === false ? await route(key) : await opened.commit((tx) => ensureConversation(tx, key), context)
    if (id === undefined) return undefined
    const conversation = (await opened.conversation(id, context))!
    return conversation.submit(
      {
        type: 'input',
        content: submission.content,
        requestId: submission.requestId,
        whenBusy: 'steer',
        entry: { kind: 'delegate.input', data: { origin: json(submission.origin ?? {}) } },
      },
      context,
    )
  }

  const answer = async (entryId: EntryId) => {
    const entry = await opened.commit((tx) => tx.entry(AssistantEntry, entryId), context)
    return answerText(entry?.model?.[0])
  }

  const status = async () => {
    const routes = (await opened.snapshot(Routes, context))?.routes ?? {}
    const keysById = new Map<number, string[]>()
    for (const [key, id] of Object.entries(routes)) keysById.set(id, [...(keysById.get(id) ?? []), key])
    const conversations = await Promise.all(
      [...keysById].map(async ([id, keys]) => {
        const live = await opened.snapshot(LiveDoc, id as ConversationId, context)
        const usage = await opened.snapshot(UsageDoc, id as ConversationId, context)
        return { id, keys, busy: live?.run !== undefined, cost: costOf(usage) }
      }),
    )
    const inspection = await opened.inspect(context)
    const schedules = Object.values((await opened.snapshot(Schedules, context))?.items ?? {})
    return {
      conversations,
      busy: conversations.filter((conversation) => conversation.busy).map((conversation) => conversation.id),
      tasks: inspection.tasks.map((task) => ({
        id: task.record.id,
        kind: task.record.kind,
        conversationId: task.record.conversationId,
        state: task.state.kind,
        ...(task.state.kind === 'sleeping' ? { until: new Date(task.state.until).toISOString() } : {}),
      })),
      schedules: schedules.map((schedule) => ({ ...schedule, nextAt: new Date(schedule.nextAt).toISOString() })),
      cost: { total: costOf(await opened.usage(context)), currency: 'USD' },
    }
  }

  const close = async () => {
    await opened.close(context)
    if (existsSync(lockFile) && readFileSync(lockFile, 'utf8') === String(process.pid)) unlinkSync(lockFile)
  }

  return { harness: opened, submit, route, answer, status, close }
}

export type Delegate = Awaited<ReturnType<typeof openDelegate>>
