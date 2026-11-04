import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { run, argsSchema, type Deps } from './tevyn-handoff-csv'

const TOKEN = 'xoxb-secret-token'
const FILE_URL = 'https://files.slack.com/files-pri/T1-F1/download/recipients.csv'
const ARGS = { channel: 'C0TEVYN', ts: '1762560000.000100' }
const CSV = 'phone,name\n+15555550100,Pat\n'

const harness = (download: Response = new Response(CSV)) => {
  const calls: { url: string; auth?: string }[] = []
  const files = new Map<string, string>()
  const deps: Deps = {
    token: TOKEN,
    fs: {
      mkdir: async () => {},
      writeFile: async (p, c) => void files.set(p, c),
    },
    fetchFn: async (url, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)
        ?.authorization
      calls.push({ url, auth })
      if (url.startsWith('https://slack.com/api/conversations.history')) {
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              {
                ts: ARGS.ts,
                files: [{ name: 'recipients.csv', url_private_download: FILE_URL }],
              },
            ],
          }),
        )
      }
      return download
    },
  }
  return { deps, calls, files }
}

describe('tevyn-handoff-csv', () => {
  it('saves the CSV to agent-fs and returns only the path', async () => {
    const h = harness()
    const out = await run(ARGS, h.deps)
    assert.deepEqual(out, { path: `/afs/tevyn-handoffs/C0TEVYN-${ARGS.ts}.csv` })
    assert.equal(h.files.get(out.path), CSV)
    const text = JSON.stringify(out)
    assert.ok(!text.includes('slack.com') && !text.includes(TOKEN))
    assert.ok(h.calls.every((c) => c.auth === `Bearer ${TOKEN}`))
  })

  it('does not leak the file URL or CSV when the download fails', async () => {
    const h = harness(new Response('denied +15555550100', { status: 403 }))
    await assert.rejects(run(ARGS, h.deps), (e: Error) => {
      assert.equal(e.message, 'recipient CSV download failed: 403')
      return true
    })
    const bad = harness()
    const inner = bad.deps.fetchFn
    bad.deps.fetchFn = async (url, init) => {
      if (url === FILE_URL) throw new Error(`network ${FILE_URL}`)
      return inner(url, init)
    }
    await assert.rejects(run(ARGS, bad.deps), (e: Error) => {
      assert.equal(e.message, 'recipient CSV download request failed')
      return true
    })
  })

  it('refuses a sign-in page served in place of the file', async () => {
    const h = harness(
      new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    )
    await assert.rejects(run(ARGS, h.deps), {
      message: 'recipient CSV download returned a web page',
    })
    assert.equal(h.files.size, 0)
  })

  it('rejects a channel or ts that could shape the path', () => {
    assert.equal(argsSchema.safeParse({ channel: '../x', ts: ARGS.ts }).success, false)
    assert.equal(argsSchema.safeParse({ channel: 'C1', ts: '1/../2' }).success, false)
  })
})
