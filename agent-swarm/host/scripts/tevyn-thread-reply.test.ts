import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { run, type Deps } from './tevyn-thread-reply'

const TOKEN = 'xoxb-secret-token'
const ARGS = {
  channel: 'C0TEVYN',
  ts: '1762600000.000100',
  text: 'Built for review',
}
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
const PNG_B64 = btoa(String.fromCharCode(...PNG))

type Call = { url: string; init?: RequestInit }

const harness = (
  responder: (url: string, init?: RequestInit) => Response = () =>
    new Response(JSON.stringify({ ok: true })),
  base64 = PNG_B64,
) => {
  const calls: Call[] = []
  const removed: string[] = []
  const deps: Deps = {
    token: TOKEN,
    readBase64: async () => base64,
    rm: async (p) => void removed.push(p),
    fetchFn: async (url, init) => {
      calls.push({ url, init })
      return responder(url, init)
    },
  }
  return { deps, calls, removed }
}

const fileFlow = (url: string): Response => {
  if (url.endsWith('files.getUploadURLExternal')) {
    return new Response(
      JSON.stringify({
        ok: true,
        upload_url: 'https://files.slack.com/upload/v1/abc',
        file_id: 'F123',
      }),
    )
  }
  if (url.startsWith('https://files.slack.com/')) return new Response('OK')
  return new Response(JSON.stringify({ ok: true }))
}

describe('tevyn-thread-reply', () => {
  it('posts a plain reply in the hand-off thread', async () => {
    const { deps, calls } = harness()
    assert.deepEqual(await run(ARGS, deps), { posted: true, withFile: false })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage')
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      channel: 'C0TEVYN',
      thread_ts: '1762600000.000100',
      text: 'Built for review',
    })
    assert.equal(
      (calls[0].init?.headers as Record<string, string>).authorization,
      `Bearer ${TOKEN}`,
    )
  })

  it('uploads a screenshot into the thread and deletes the local copy', async () => {
    const { deps, calls, removed } = harness(fileFlow)
    const path = '/afs/tevyn-handoffs/12345-step.png'

    assert.deepEqual(await run({ ...ARGS, filePath: path }, deps), {
      posted: true,
      withFile: true,
    })

    assert.deepEqual(
      calls.map((c) => c.url),
      [
        'https://slack.com/api/files.getUploadURLExternal',
        'https://files.slack.com/upload/v1/abc',
        'https://slack.com/api/files.completeUploadExternal',
      ],
    )
    const slot = new URLSearchParams(String(calls[0].init?.body))
    assert.equal(slot.get('filename'), '12345-step.png')
    assert.equal(slot.get('length'), String(PNG.length))
    assert.deepEqual([...(calls[1].init?.body as Uint8Array)], [...PNG])
    assert.deepEqual(JSON.parse(String(calls[2].init?.body)), {
      files: [{ id: 'F123', title: '12345-step.png' }],
      channel_id: 'C0TEVYN',
      thread_ts: '1762600000.000100',
      initial_comment: 'Built for review',
    })
    assert.deepEqual(removed, [path])
  })

  it('keeps the screenshot when the upload fails', async () => {
    const { deps, removed } = harness((url) =>
      url.startsWith('https://files.slack.com/')
        ? new Response('no', { status: 500 })
        : fileFlow(url),
    )
    await assert.rejects(
      run({ ...ARGS, filePath: '/afs/a.png' }, deps),
      /screenshot upload failed: 500/,
    )
    assert.deepEqual(removed, [])
  })

  it('refuses text that contains a phone number before any request', async () => {
    const { deps, calls } = harness()
    for (const text of [
      'Reply from (555) 123-4567',
      'call 555-123-4567',
      '+1 555 123 4567',
      '5551234567',
    ]) {
      await assert.rejects(run({ ...ARGS, text }, deps), /phone number/)
    }
    assert.equal(calls.length, 0)
  })

  it('accepts times and ids that look like numbers', async () => {
    const { deps } = harness()
    await run(
      {
        ...ARGS,
        text: 'Scheduled to start 2026-11-08 at 11:00 AM, campaign #12345',
      },
      deps,
    )
  })

  it('rejects file paths outside agent-fs, traversal and non-images', async () => {
    const { deps, calls } = harness()
    await assert.rejects(
      run({ ...ARGS, filePath: '/etc/passwd.png' }, deps),
      /under \/afs/,
    )
    await assert.rejects(
      run({ ...ARGS, filePath: '/afs/../etc/a.png' }, deps),
      /under \/afs/,
    )
    await assert.rejects(
      run({ ...ARGS, filePath: "/afs/a.png'; rm -rf x" }, deps),
      /under \/afs/,
    )
    await assert.rejects(
      run({ ...ARGS, filePath: '/afs/export.csv' }, deps),
      /png or jpg/,
    )
    assert.equal(calls.length, 0)
  })

  it('surfaces only the Slack error code, never the token or body', async () => {
    const { deps } = harness(
      () =>
        new Response(JSON.stringify({ ok: false, error: 'not_in_channel' })),
    )
    await assert.rejects(run(ARGS, deps), (e: Error) => {
      assert.equal(e.message, 'Slack chat.postMessage failed: not_in_channel')
      assert.ok(!e.message.includes(TOKEN))
      return true
    })
  })

  it('reports an HTTP failure by status only', async () => {
    const { deps } = harness(() => new Response('secret body', { status: 503 }))
    await assert.rejects(run(ARGS, deps), (e: Error) => {
      assert.equal(e.message, 'Slack chat.postMessage failed: 503')
      return true
    })
  })

  it('rejects an empty screenshot', async () => {
    const { deps } = harness(fileFlow, '')
    await assert.rejects(
      run({ ...ARGS, filePath: '/afs/a.png' }, deps),
      /empty/,
    )
  })
})
