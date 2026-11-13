import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { SetTimer } from '@earendil-works/pi-durable'
import { openDelegate } from './delegate.ts'
import { handleGithubWebhook } from './github.ts'

const context = BACKGROUND_CONTEXT
const roots: string[] = []
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

const setupData = () => {
  const root = mkdtempSync(join(tmpdir(), 'delegate-durable-'))
  roots.push(root)
  const origin = join(root, 'origin')
  mkdirSync(join(origin, '.claude', 'skills', 'demo'), { recursive: true })
  writeFileSync(join(origin, 'AGENTS.md'), '# omni\nRun tests with npm test.\n')
  writeFileSync(
    join(origin, '.claude', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: A demo skill\n---\nDo the demo.\n',
  )
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' })
  git(origin, ['init', '--quiet', '-b', 'main'])
  git(origin, ['add', '.'])
  git(origin, ['commit', '--quiet', '-m', 'init'])
  const dataDir = join(root, 'data')
  mkdirSync(dataDir)
  git(root, ['clone', '--quiet', origin, join(dataDir, 'omni')])
  return dataDir
}

const open = async (
  dataDir: string,
  faux: ReturnType<typeof fauxProvider>,
  clock?: { now: () => number; setTimer: SetTimer },
) => {
  const models = createModels()
  models.setProvider(faux.provider)
  const posts = {
    slack: [] as { channel: string; threadTs?: string; text: string }[],
    github: [] as { repo: string; number: number; text: string }[],
  }
  const delegate = await openDelegate({
    dataDir,
    models,
    model: { provider: 'faux', modelId: 'faux-1' },
    persona: 'You are a test agent. Memory: {{MEMORY_DIR}}',
    postSlack: async (post) => {
      posts.slack.push(post)
      return { ts: '999.1' }
    },
    postGithub: async (post) => {
      posts.github.push(post)
    },
    ...clock,
  })
  return { delegate, posts }
}

const slackInput = (thread: string, ts: string, content: string) => ({
  content,
  requestId: `slack:C1:${ts}`,
  origin: { slack: { channel: 'C1', threadTs: thread } },
})

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(check(), 'timed out waiting')
}

test('a repeated Slack requestId is admitted once and answered once', async () => {
  const faux = fauxProvider()
  let request = ''
  faux.setResponses([
    (transcript) => {
      request = JSON.stringify(transcript)
      return fauxAssistantMessage('Hello there.')
    },
    fauxAssistantMessage('Should not be used.'),
  ])
  const dataDir = setupData()
  const { delegate, posts } = await open(dataDir, faux)
  try {
    const first = await delegate.submit('slack:C1:1.0', slackInput('1.0', '1.0', 'hi'))
    const again = await delegate.submit('slack:C1:1.0', slackInput('1.0', '1.0', 'hi'))
    assert.equal(again!.id, first!.id)
    assert.equal((await first!.wait(context)).status, 'done')
    await delegate.harness.waitForIdle(context)
    assert.equal(faux.state.callCount, 1)
    assert.deepEqual(posts.slack, [{ channel: 'C1', threadTs: '1.0', text: 'Hello there.' }])
    const conversation = await delegate.route('slack:C1:1.0')
    assert.ok(existsSync(join(dataDir, 'worktrees', String(conversation), 'AGENTS.md')))
    assert.match(request, /You are a test agent/)
    assert.match(request, /Run tests with npm test/)
    assert.match(request, /- demo: A demo skill/)
  } finally {
    await delegate.close()
  }
})

test('a message sent while busy joins the running conversation', async () => {
  const faux = fauxProvider()
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let secondRequest = ''
  faux.setResponses([
    async () => {
      await held
      return fauxAssistantMessage(fauxToolCall('bash', { command: 'echo working' }), { stopReason: 'toolUse' })
    },
    (transcript) => {
      secondRequest = JSON.stringify(transcript.messages)
      return fauxAssistantMessage('Done, and I ran the tests too.')
    },
  ])
  const { delegate, posts } = await open(setupData(), faux)
  try {
    const first = await delegate.submit('slack:C1:2.0', slackInput('2.0', '2.0', 'start the work'))
    await until(() => faux.state.callCount === 1)
    const second = await delegate.submit('slack:C1:2.0', slackInput('2.0', '2.1', 'also run the tests'))
    release()
    const firstSettled = await first!.wait(context)
    const secondSettled = await second!.wait(context)
    await delegate.harness.waitForIdle(context)
    assert.equal(secondSettled.status, 'done')
    assert.equal(firstSettled.status === 'done' && firstSettled.answer, secondSettled.status === 'done' && secondSettled.answer)
    assert.match(secondRequest, /also run the tests/)
    assert.equal(faux.state.callCount, 2)
    assert.deepEqual(posts.slack, [{ channel: 'C1', threadTs: '2.0', text: 'Done, and I ran the tests too.' }])
  } finally {
    await delegate.close()
  }
})

test('the subagent tool runs a child conversation in the same worktree and returns its answer', async () => {
  const faux = fauxProvider()
  let parentSaw = ''
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('subagent', { task: 'run pwd' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('bash', { command: 'pwd' }), { stopReason: 'toolUse' }),
    (transcript) => fauxAssistantMessage(`child ran in ${JSON.stringify(transcript.messages.at(-1))}`),
    (transcript) => {
      parentSaw = JSON.stringify(transcript.messages.at(-1))
      return fauxAssistantMessage('The subagent is done.')
    },
  ])
  const dataDir = setupData()
  const { delegate, posts } = await open(dataDir, faux)
  try {
    await (await delegate.submit('slack:C1:5.0', slackInput('5.0', '5.0', 'delegate this')))!.wait(context)
    await delegate.harness.waitForIdle(context)
    const worktree = join(dataDir, 'worktrees', String(await delegate.route('slack:C1:5.0')))
    assert.match(parentSaw, /child ran in/)
    assert.ok(parentSaw.includes(realpathSync(worktree)))
    assert.deepEqual(posts.slack.map((post) => post.text), ['The subagent is done.'])
  } finally {
    await delegate.close()
  }
})

test('link_pr routes later PR comments to the same conversation', async () => {
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('link_pr', { repo: 'thegoodparty/omni', number: 7 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Opened and linked.'),
    fauxAssistantMessage('Fixed the typo.'),
  ])
  const { delegate, posts } = await open(setupData(), faux)
  try {
    await (await delegate.submit('slack:C1:3.0', slackInput('3.0', '3.0', 'open a PR')))!.wait(context)
    await delegate.harness.waitForIdle(context)
    const thread = await delegate.route('slack:C1:3.0')
    assert.equal(await delegate.route('github:thegoodparty/omni:pr:7'), thread)

    const body = JSON.stringify({
      action: 'created',
      repository: { full_name: 'thegoodparty/omni' },
      issue: { number: 7, pull_request: {} },
      comment: { id: 55, body: 'please fix the typo', user: { login: 'swain' }, author_association: 'MEMBER' },
    })
    const result = await handleGithubWebhook({
      delegate,
      secret: 'shh',
      botLogin: 'delegate-gp[bot]',
      mention: '@delegate-gp',
      event: 'issue_comment',
      signature: `sha256=${createHmac('sha256', 'shh').update(body).digest('hex')}`,
      rawBody: Buffer.from(body),
    })
    assert.deepEqual(result, { status: 202, body: { status: 'submitted' } })
    await until(() => posts.github.length === 1)
    assert.deepEqual(posts.github, [{ repo: 'thegoodparty/omni', number: 7, text: 'Fixed the typo.' }])
    assert.equal((await delegate.status()).conversations.length, 1)
  } finally {
    await delegate.close()
  }
})

test('a schedule fires after a fake-clock sleep across a close and reopen', async () => {
  let now = Date.parse('2026-01-05T15:00:00Z')
  const parked: (() => void)[] = []
  const setTimer: SetTimer = (callback, delayMs) => {
    if (delayMs > 60_000) {
      parked.push(callback)
      return () => {}
    }
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  }
  const clock = { now: () => now, setTimer }
  const dataDir = setupData()

  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('schedule_create', { at: '2026-01-05T16:00:00Z', prompt: 'Say good morning', slack_channel: 'C9' }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Scheduled.'),
  ])
  const first = await open(dataDir, faux, clock)
  try {
    await (await first.delegate.submit('slack:C1:4.0', slackInput('4.0', '4.0', 'remind C9 at 16:00')))!.wait(context)
    await first.delegate.harness.waitForIdle(context)
    const status = await first.delegate.status()
    assert.equal(status.schedules.length, 1)
    assert.equal(status.schedules[0].nextAt, '2026-01-05T16:00:00.000Z')
    assert.ok(status.tasks.some((task) => task.kind === 'delegate.schedule' && task.state === 'sleeping'))
    assert.deepEqual(first.posts.slack.map((post) => post.text), ['Scheduled.'])
  } finally {
    await first.delegate.close()
  }

  now = Date.parse('2026-01-05T16:30:00Z')
  const faux2 = fauxProvider()
  faux2.setResponses([fauxAssistantMessage('Good morning!')])
  const second = await open(dataDir, faux2, clock)
  try {
    second.delegate.harness.resume()
    await until(() => second.posts.slack.length === 1)
    assert.equal(second.posts.slack[0].channel, 'C9')
    assert.equal(second.posts.slack[0].threadTs, undefined)
    assert.equal(second.posts.slack[0].text, 'Good morning!')
    await second.delegate.harness.waitForIdle(context)
    const status = await second.delegate.status()
    assert.equal(status.schedules.length, 0)
    const scheduled = status.conversations.find((conversation) => conversation.keys.some((key) => key.startsWith('schedule:')))
    assert.ok(scheduled?.keys.includes('slack:C9:999.1'))
  } finally {
    await second.delegate.close()
  }
})
