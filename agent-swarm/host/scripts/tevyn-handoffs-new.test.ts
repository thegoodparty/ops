import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseHandoff, run, type Deps, type Kv } from './tevyn-handoffs-new'

const CHANNEL = 'C0TEVYN'
const TOKEN = 'xoxb-secret-token'
const NOTE =
  '*Delegate is handling this wave.* Do not schedule it by hand unless it posts that it needs help.'

const machine = (over: Record<string, string> = {}) => {
  const f = {
    outreachId: '12345',
    sendAt: '2026-11-08T16:00:00.000Z',
    timeZone: 'US/Eastern',
    mode: 'shadow',
    env: 'dev',
    repliesKey: 'agent-replies/12345.csv',
    ...over,
  }
  return ['```', ...Object.entries(f).map(([k, v]) => `${k}: ${v}`), '```'].join(
    '\n',
  )
}

const post = (
  ts: string,
  opts: { note?: boolean; block?: string; text?: string } = {},
) => ({
  ts,
  blocks: [
    { type: 'header', text: { type: 'plain_text', text: 'Text Send Recipients' } },
    ...(opts.note === false
      ? []
      : [{ type: 'section', text: { type: 'mrkdwn', text: NOTE } }]),
    { type: 'section', text: { type: 'mrkdwn', text: opts.block ?? machine() } },
    { type: 'section', text: { type: 'mrkdwn', text: '*Outreach ID:* `12345`' } },
    {
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [{ type: 'text', text: ' Message:' }],
        },
        {
          type: 'rich_text_quote',
          elements: [{ type: 'text', text: opts.text ?? 'Town hall Saturday' }],
        },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: '*Recipients:* 42' } },
  ],
})

const memoryKv = (): Kv & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
  }
}

const harness = (messages: unknown[]) => {
  const urls: string[] = []
  const kv = memoryKv()
  const replies: { channel: string; ts: string; text: string }[] = []
  const deps: Deps = {
    kv,
    token: TOKEN,
    channel: CHANNEL,
    env: 'dev',
    now: () => Date.parse('2026-11-03T00:00:00Z'),
    fetchFn: async (url) => {
      urls.push(url)
      return new Response(JSON.stringify({ ok: true, messages }))
    },
    reply: async (args) => {
      replies.push(args)
    },
  }
  return { deps, kv, urls, replies }
}

const UNREADABLE_TEXT =
  'Automated panel-wave dispatcher could not read this hand-off post, so ' +
  'nothing was scheduled from it. A person needs to check this post and ' +
  'handle the wave by hand.'

describe('parseHandoff', () => {
  it('reads the machine block, message and recipient count', () => {
    const parsed = parseHandoff(post('1762560000.000100'), CHANNEL)
    assert.deepEqual(parsed, {
      outreachId: '12345',
      sendAt: '2026-11-08T16:00:00.000Z',
      timeZone: 'US/Eastern',
      mode: 'shadow',
      env: 'dev',
      repliesKey: 'agent-replies/12345.csv',
      message: 'Town hall Saturday',
      recipientCount: 42,
      channel: CHANNEL,
      ts: '1762560000.000100',
    })
  })

  it('reads a post that carries the Upload results CSV button', () => {
    const withButton = (ts: string) => {
      const base = post(ts)
      return {
        ...base,
        blocks: [
          ...base.blocks,
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Upload results CSV', emoji: true },
                action_id: 'upload_csv',
              },
            ],
          },
        ],
      }
    }
    const parsed = parseHandoff(withButton('1762560000.000100'), CHANNEL)
    assert.equal(parsed?.outreachId, '12345')
    assert.equal(parsed?.recipientCount, 42)
  })

  it('skips a post without the handling note', () => {
    assert.equal(parseHandoff(post('1.1', { note: false }), CHANNEL), null)
  })

  it('skips a post whose block fails validation', () => {
    for (const block of [
      machine({ mode: 'manual' }),
      machine({ sendAt: 'tomorrow' }),
      machine({ outreachId: 'abc' }),
      machine({ repliesKey: 'agent-replies/999.csv' }),
      'no block here',
    ]) {
      assert.equal(parseHandoff(post('1.1', { block }), CHANNEL), null)
    }
  })
})

describe('run', () => {
  it('returns a post once and not on the next run', async () => {
    const h = harness([post('1762560000.000100')])
    const first = await run(h.deps)
    assert.equal(first.handoffs.length, 1)
    assert.equal(first.handoffs[0].outreachId, '12345')
    assert.deepEqual(first.unreadable, [])
    assert.deepEqual(h.kv.data.get('handoff:12345'), {
      state: 'new',
      slackTs: '1762560000.000100',
      channel: CHANNEL,
      sendAt: '2026-11-08T16:00:00.000Z',
      timeZone: 'US/Eastern',
      mode: 'shadow',
      message: 'Town hall Saturday',
      recipientCount: 42,
    })
    assert.equal(h.kv.data.get('tevyn:cursor'), '1762560000.000100')

    const second = await run(h.deps)
    assert.deepEqual(second, { handoffs: [], unreadable: [] })
  })

  it('asks Slack only for messages after the stored cursor', async () => {
    const h = harness([])
    h.kv.data.set('tevyn:cursor', '1762560000.000100')
    await run(h.deps)
    const url = new URL(h.urls[0])
    assert.equal(url.searchParams.get('oldest'), '1762560000.000100')
    assert.equal(url.searchParams.get('channel'), CHANNEL)
  })

  it('skips other environments, reports nothing unreadable and leaves their ids unclaimed', async () => {
    const h = harness([
      post('1762560000.000100', {
        block: machine({ env: 'prod', outreachId: '7', repliesKey: 'agent-replies/7.csv' }),
      }),
    ])
    assert.deepEqual(await run(h.deps), { handoffs: [], unreadable: [] })
    assert.equal(h.kv.data.has('handoff:7'), false)
    assert.equal(h.replies.length, 0)
  })

  it('skips an id already in KV and returns oldest first', async () => {
    const other = machine({ outreachId: '8', repliesKey: 'agent-replies/8.csv' })
    const h = harness([
      post('1762560000.000300', { block: other }),
      post('1762560000.000200'),
    ])
    h.kv.data.set('handoff:8', { state: 'done' })
    const out = await run(h.deps)
    assert.deepEqual(
      out.handoffs.map((o) => o.outreachId),
      ['12345'],
    )
  })

  it('claims nothing and keeps the cursor when Slack fails', async () => {
    const h = harness([])
    h.deps.fetchFn = async () =>
      new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }))
    await assert.rejects(run(h.deps), {
      message: 'Slack history failed: invalid_auth',
    })
    assert.equal(h.kv.data.size, 0)
  })

  it('claims nothing and keeps the cursor when pages remain past the cap', async () => {
    const h = harness([])
    h.deps.fetchFn = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          messages: [post('1762560000.000100')],
          response_metadata: { next_cursor: 'more' },
        }),
      )
    await assert.rejects(run(h.deps), {
      message: 'Slack history exceeded the page limit',
    })
    assert.equal(h.kv.data.size, 0)
  })

  it('never puts the token in a result or an error', async () => {
    const h = harness([post('1762560000.000100')])
    assert.ok(!JSON.stringify(await run(h.deps)).includes(TOKEN))
    h.deps.fetchFn = async () => {
      throw new Error(`boom ${TOKEN}`)
    }
    await assert.rejects(run(h.deps), (e: Error) => {
      assert.equal(e.message, 'Slack history request failed')
      return true
    })
  })

  it('reports an unreadable post, claims nothing, and warns once across two runs', async () => {
    const ts = '1762560000.000100'
    const h = harness([post(ts, { block: 'no block here' })])

    const first = await run(h.deps)

    assert.deepEqual(first.handoffs, [])
    assert.deepEqual(first.unreadable, [
      { ts, reason: 'no machine block', posted: true },
    ])
    assert.equal(h.kv.data.has('handoff:12345'), false)
    assert.equal(h.replies.length, 1)
    assert.deepEqual(h.replies[0], {
      channel: CHANNEL,
      ts,
      text: UNREADABLE_TEXT,
    })
    assert.deepEqual(h.kv.data.get(`unparsed:${ts}`), {
      postedAt: '2026-11-03T00:00:00.000Z',
      reason: 'no machine block',
    })
    // The post is the first message in the window, so there is nothing older
    // to point the cursor at and the stored one stays untouched.
    assert.equal(h.kv.data.has('tevyn:cursor'), false)

    const second = await run(h.deps)
    assert.deepEqual(second.unreadable, [
      { ts, reason: 'no machine block', posted: true },
    ])
    assert.equal(h.replies.length, 1)
  })

  it('reports why a post could not be read', async () => {
    const h = harness([
      post('1762560000.000100', { block: 'no block here' }),
      post('1762560000.000200', { block: machine({ mode: 'manual' }) }),
      post('1762560000.000300', {
        block: machine({ repliesKey: 'agent-replies/999.csv' }),
      }),
    ])

    const res = await run(h.deps)

    assert.deepEqual(
      res.unreadable.map((u) => [u.ts, u.reason]),
      [
        ['1762560000.000100', 'no machine block'],
        ['1762560000.000200', 'invalid fields'],
        ['1762560000.000300', 'replies key mismatch'],
      ],
    )
    assert.equal(h.replies.length, 3)
    // The second post carries outreach id 12345, and an unreadable post is
    // never claimed.
    assert.equal(h.kv.data.has('handoff:12345'), false)
  })

  it('stops the cursor just before an unreadable post', async () => {
    const blocked = '1762560000.000200'
    const h = harness([
      post('1762560000.000100'),
      post(blocked, { block: 'no block here' }),
      post('1762560000.000300', {
        block: machine({ outreachId: '9', repliesKey: 'agent-replies/9.csv' }),
      }),
    ])

    const first = await run(h.deps)

    assert.equal(h.kv.data.get('tevyn:cursor'), '1762560000.000100')
    // A post after the unreadable one is still claimed: the hold is on the
    // cursor, not on discovery.
    assert.deepEqual(
      first.handoffs.map((o) => o.outreachId),
      ['12345', '9'],
    )

    await run(h.deps)

    const asked = new URL(h.urls[1])
    assert.equal(asked.searchParams.get('oldest'), '1762560000.000100')
  })

  it('keeps the cursor before a post whose warning is under 48h old', async () => {
    const blocked = '1762560000.000200'
    const h = harness([
      post('1762560000.000100'),
      post(blocked, { block: 'no block here' }),
    ])
    h.kv.data.set('tevyn:cursor', '1762560000.000050')
    h.kv.data.set(`unparsed:${blocked}`, {
      postedAt: '2026-11-01T01:00:00.000Z',
      reason: 'no machine block',
    })

    const res = await run(h.deps)

    assert.equal(res.unreadable[0].released, undefined)
    assert.equal(h.kv.data.get('tevyn:cursor'), '1762560000.000100')
    assert.equal(h.replies.length, 0)
  })

  it('releases a post after 48h: the cursor advances and it is still reported', async () => {
    const blocked = '1762560000.000200'
    const h = harness([post(blocked, { block: 'no block here' })])
    h.kv.data.set('tevyn:cursor', '1762560000.000100')
    h.kv.data.set(`unparsed:${blocked}`, {
      postedAt: '2026-10-31T23:00:00.000Z',
      reason: 'no machine block',
    })

    const res = await run(h.deps)

    assert.deepEqual(res.unreadable, [
      { ts: blocked, reason: 'no machine block', posted: true, released: true },
    ])
    assert.equal(h.kv.data.get('tevyn:cursor'), blocked)
    assert.equal(h.replies.length, 0)
  })

  it('does not throw when the warning cannot be posted, and retries it next run', async () => {
    const ts = '1762560000.000100'
    const h = harness([post(ts, { block: 'no block here' })])
    h.deps.reply = async () => {
      throw new Error('Slack chat.postMessage failed: not_in_channel')
    }

    const first = await run(h.deps)

    assert.deepEqual(first.unreadable, [
      { ts, reason: 'no machine block', posted: false },
    ])
    assert.equal(h.kv.data.has(`unparsed:${ts}`), false)

    h.deps.reply = async (args) => {
      h.replies.push(args)
    }
    const second = await run(h.deps)

    assert.deepEqual(second.unreadable, [
      { ts, reason: 'no machine block', posted: true },
    ])
    assert.equal(h.kv.data.has(`unparsed:${ts}`), true)
  })
})
