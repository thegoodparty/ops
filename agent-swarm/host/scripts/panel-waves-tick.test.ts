import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  repliesDueAtOf,
  run,
  taskTextFor,
  unreadableOf,
  type Deps,
  type Kv,
  type UnreadablePost,
} from './panel-waves-tick'

const NOW = Date.parse('2026-11-08T12:00:00Z')
const SEND_AT = '2026-11-08T16:00:00.000Z'

const memoryKv = (): Kv & {
  data: Map<string, unknown>
  ttls: Map<string, number | undefined>
} => {
  const data = new Map<string, unknown>()
  const ttls = new Map<string, number | undefined>()
  return {
    data,
    ttls,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v, ttl) => {
      data.set(k, v)
      ttls.set(k, ttl)
    },
    delete: async (k) => void data.delete(k),
    list: async (prefix, offset) =>
      [...data.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(offset)
        .map(([key, value]) => ({ key, value })),
  }
}

const claim = (over: Record<string, unknown> = {}) => ({
  state: 'new',
  slackTs: '1762600000.000100',
  channel: 'C0TEVYN',
  sendAt: SEND_AT,
  timeZone: 'US/Eastern',
  mode: 'auto',
  message: 'Town hall Saturday, {{first_name}}',
  recipientCount: 42,
  ...over,
})

const harness = (
  records: Record<string, unknown> = {},
  unreadable: UnreadablePost[] = [],
) => {
  const kv = memoryKv()
  for (const [id, record] of Object.entries(records)) {
    kv.data.set(`handoff:${id}`, record)
  }
  const sent: { task: string; tags: string[] }[] = []
  let triggers = 0
  const deps: Deps = {
    kv,
    now: () => NOW,
    runNewHandoffs: async () => {
      triggers += 1
      return unreadable
    },
    sendTask: async (args) => {
      sent.push(args)
      return `task-${sent.length}`
    },
  }
  return { deps, kv, sent, triggers: () => triggers }
}

describe('panel-waves-tick', () => {
  it('sends one schedule task from a claim record', async () => {
    const { deps, kv, sent, triggers } = harness({ '12345': claim() })

    const res = await run(deps)

    assert.equal(triggers(), 1)
    assert.deepEqual(res.dispatched, [
      { outreachId: '12345', action: 'schedule', taskId: 'task-1' },
    ])
    assert.equal(sent.length, 1)
    assert.match(
      sent[0].task,
      /^Handle 12345 \(schedule\) following the scale-to-win-panel-wave skill\./,
    )
    const fields = JSON.parse(sent[0].task.split('handoff: ')[1])
    assert.equal(fields.sendAt, SEND_AT)
    assert.equal(fields.timeZone, 'US/Eastern')
    assert.equal(fields.mode, 'auto')
    assert.equal(fields.channel, 'C0TEVYN')
    assert.equal(fields.ts, '1762600000.000100')
    assert.equal(fields.message, 'Town hall Saturday, {{first_name}}')
    const record = kv.data.get('handoff:12345') as Record<string, unknown>
    assert.equal(record.state, 'new')
    assert.equal(record.slackTs, '1762600000.000100')
    assert.equal(fields.repliesDueAt, '2026-11-10T16:00:00.000Z')
    assert.equal(record.attempts, 1)
    assert.equal(record.attemptsFor, 'schedule')
  })

  it('writes the lease before sending, with a one hour expiry', async () => {
    const { deps, kv } = harness({ '12345': claim() })
    let leaseAtSend: unknown = null
    deps.sendTask = async () => {
      leaseAtSend = kv.data.get('lease:12345')
      return 'task-1'
    }

    await run(deps)

    assert.deepEqual(leaseAtSend, { expiresAt: NOW + 3_600_000 })
    assert.equal(kv.ttls.get('lease:12345'), 3600)
  })

  it('does not start a task whose lease is live, and does after it expires', async () => {
    const { deps, kv, sent } = harness()
    kv.data.set('handoff:12345', {
      state: 'building',
      slackTs: '1',
      channel: 'C0TEVYN',
      sendAt: SEND_AT,
      attempts: 1,
    })
    kv.data.set('lease:12345', { expiresAt: NOW + 1000 })

    assert.deepEqual((await run(deps)).dispatched, [])
    assert.equal(sent.length, 0)

    kv.data.set('lease:12345', { expiresAt: NOW - 1 })
    const res = await run(deps)
    assert.equal(res.dispatched[0].action, 'schedule')
    assert.equal(sent.length, 1)
  })

  it('sends an export task for a scheduled wave only once replies are due', async () => {
    const { deps, kv, sent } = harness()
    kv.data.set('handoff:12345', {
      state: 'scheduled',
      slackTs: '1762600000.000100',
      channel: 'C0TEVYN',
      sendAt: SEND_AT,
      repliesDueAt: '2026-11-10T16:00:00.000Z',
      attempts: 1,
    })

    assert.deepEqual((await run(deps)).dispatched, [])

    deps.now = () => Date.parse('2026-11-10T16:00:00Z')
    const res = await run(deps)
    assert.deepEqual(res.dispatched, [
      { outreachId: '12345', action: 'export_replies', taskId: 'task-1' },
    ])
    assert.match(sent[0].task, /\(export_replies\)/)
    assert.equal(
      JSON.parse(sent[0].task.split('handoff: ')[1]).message,
      undefined,
    )
  })

  it('computes repliesDueAt from sendAt when a scheduled record has none', async () => {
    const { deps, kv } = harness()
    kv.data.set('handoff:12345', {
      state: 'scheduled',
      slackTs: '1',
      channel: 'C0TEVYN',
      sendAt: SEND_AT,
    })
    deps.now = () => Date.parse('2026-11-10T16:00:01Z')
    assert.equal((await run(deps)).dispatched.length, 1)
  })

  it('sends an export task for a shadow (built) wave once replies are due', async () => {
    const { deps, kv, sent } = harness()
    kv.data.set('handoff:12345', {
      state: 'built',
      slackTs: '1',
      channel: 'C0TEVYN',
      sendAt: SEND_AT,
      mode: 'shadow',
    })

    const early = await run(deps)
    assert.deepEqual(early.dispatched, [])
    assert.deepEqual(early.skipped, [])

    deps.now = () => Date.parse('2026-11-10T16:00:01Z')
    const res = await run(deps)
    assert.deepEqual(res.dispatched, [
      { outreachId: '12345', action: 'export_replies', taskId: 'task-1' },
    ])
    assert.equal(JSON.parse(sent[0].task.split('handoff: ')[1]).mode, 'shadow')
  })

  it('stops exporting a built wave after its export attempts run out', async () => {
    const { deps, kv, sent } = harness()
    kv.data.set('handoff:12345', {
      state: 'built',
      slackTs: '1',
      sendAt: SEND_AT,
      attempts: 5,
      attemptsFor: 'export_replies',
    })
    deps.now = () => Date.parse('2026-11-10T16:00:01Z')

    const res = await run(deps)

    assert.equal(sent.length, 0)
    assert.deepEqual(res.skipped, [
      { outreachId: '12345', reason: 'attempts exhausted' },
    ])
  })

  it('leaves needs_human, replies_uploaded and pre-due records alone', async () => {
    const { deps, kv, sent } = harness()
    for (const [id, state] of [
      ['1', 'needs_human'],
      ['3', 'replies_uploaded'],
    ]) {
      kv.data.set(`handoff:${id}`, { state, sendAt: SEND_AT, slackTs: 's' })
    }
    kv.data.set('handoff:4', {
      state: 'scheduled',
      sendAt: '2026-11-20T00:00:00Z',
      slackTs: 's',
    })

    const res = await run(deps)

    assert.equal(sent.length, 0)
    assert.deepEqual(res.skipped, [])
  })

  it('reports records it cannot act on instead of dropping them silently', async () => {
    const { deps, kv, sent } = harness()
    kv.data.set('handoff:1', { state: 'new', slackTs: 's' })
    kv.data.set('handoff:2', {
      state: 'building',
      sendAt: SEND_AT,
      slackTs: 's',
      attempts: 5,
      attemptsFor: 'schedule',
    })
    kv.data.set('handoff:3', 'garbage')

    const res = await run(deps)

    assert.equal(sent.length, 0)
    assert.deepEqual(res.skipped, [
      { outreachId: '1', reason: 'no hand-off details stored' },
      { outreachId: '2', reason: 'attempts exhausted' },
      { outreachId: '3', reason: 'unreadable record' },
    ])
  })

  it('drops the lease when the task cannot be created, so the next tick retries', async () => {
    const { deps, kv } = harness({ '12345': claim() })
    deps.sendTask = async () => null

    const res = await run(deps)

    assert.deepEqual(res.failed, [{ outreachId: '12345', action: 'schedule' }])
    assert.equal(kv.data.has('lease:12345'), false)
    assert.equal(
      (kv.data.get('handoff:12345') as { attempts: number }).attempts,
      1,
    )
  })

  it('handles two waves in one tick with one task each', async () => {
    const { deps, sent } = harness({
      '12345': claim(),
      '67890': claim({ slackTs: '1762600001.000100' }),
    })
    const res = await run(deps)
    assert.deepEqual(
      res.dispatched.map((d) => d.outreachId),
      ['12345', '67890'],
    )
    assert.equal(sent.length, 2)
  })

  it('still scans KV when the new hand-offs script fails', async () => {
    const { deps, sent } = harness({ '12345': claim() })
    deps.runNewHandoffs = async () => {
      throw new Error('boom')
    }
    const res = await run(deps)
    assert.equal(res.triggerFailed, true)
    assert.equal(sent.length, 1)
  })

  it('counts attempts per action, so a wave that used its building attempts still exports', async () => {
    const { deps, kv, sent } = harness({
      '12345': claim({
        state: 'scheduled',
        attempts: 5,
        attemptsFor: 'schedule',
      }),
    })
    deps.now = () => Date.parse('2026-11-10T16:00:00Z')

    const res = await run(deps)

    assert.deepEqual(res.dispatched, [
      { outreachId: '12345', action: 'export_replies', taskId: 'task-1' },
    ])
    assert.equal(sent.length, 1)
    const record = kv.data.get('handoff:12345') as Record<string, unknown>
    assert.equal(record.attempts, 1)
    assert.equal(record.attemptsFor, 'export_replies')
  })

  it('carries unreadable hand-off posts into the result', async () => {
    const unreadable: UnreadablePost[] = [
      { ts: '1762560000.000100', reason: 'no machine block', posted: true },
      { ts: '1762560000.000200', reason: 'invalid fields', posted: false },
    ]
    const { deps } = harness({}, unreadable)

    const res = await run(deps)

    assert.deepEqual(res.unreadable, unreadable)
  })

  it('reports no unreadable posts when the new hand-offs script fails', async () => {
    const { deps } = harness()
    deps.runNewHandoffs = async () => {
      throw new Error('boom')
    }

    const res = await run(deps)

    assert.equal(res.triggerFailed, true)
    assert.deepEqual(res.unreadable, [])
  })

  it('reads the unreadable list out of the nested result, or nothing when absent', () => {
    assert.deepEqual(
      unreadableOf({
        handoffs: [],
        unreadable: [{ ts: '1.1', reason: 'invalid fields' }],
      }),
      [{ ts: '1.1', reason: 'invalid fields' }],
    )
    assert.deepEqual(unreadableOf({ handoffs: [] }), [])
    assert.deepEqual(unreadableOf({ unreadable: 'garbage' }), [])
    assert.deepEqual(unreadableOf(undefined), [])
  })

  it('exposes the helpers the skill relies on', () => {
    assert.equal(repliesDueAtOf(SEND_AT), '2026-11-10T16:00:00.000Z')
    assert.match(
      taskTextFor('schedule', '9', { a: 1 }),
      /\{"action":"schedule","outreachId":"9","a":1\}/,
    )
  })
})
