import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { run, signV4, argsSchema, type Deps } from './s2w-replies-upload'

const SESSION_TOKEN = 'SESSION-TOKEN-SECRET'
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
const EXPORT = '/afs/exports/12345.csv'
const BODY = 'phone,reply\n+15555550100,YES\n'

type Call = { url: string; method: string; headers: Record<string, string>; body?: string }

const harness = (put: (c: Call) => Response = () => new Response('', { status: 200 })) => {
  const calls: Call[] = []
  const files = new Map<string, string>([[EXPORT, BODY]])
  const deps: Deps = {
    bucket: 'gp-replies-dev',
    now: () => new Date('2026-11-02T12:00:00.000Z'),
    fs: {
      readFile: async (p) => {
        const v = files.get(p)
        if (v === undefined) throw new Error('ENOENT')
        return v
      },
      rm: async (p) => void files.delete(p),
    },
    fetchFn: async (url, init) => {
      const call: Call = {
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body as string | undefined,
      }
      calls.push(call)
      if (url.endsWith('/latest/api/token')) return new Response('imds-token')
      if (url.endsWith('/security-credentials/')) return new Response('host-role')
      if (url.endsWith('/security-credentials/host-role')) {
        return new Response(
          JSON.stringify({
            AccessKeyId: 'AKIDEXAMPLE',
            SecretAccessKey: SECRET,
            Token: SESSION_TOKEN,
          }),
        )
      }
      return put(call)
    },
  }
  return { deps, calls, files }
}

describe('signV4', () => {
  // AWS Signature Version 4 test suite, get-vanilla.
  it('matches the published get-vanilla vector', async () => {
    const auth = await signV4({
      method: 'GET',
      host: 'example.amazonaws.com',
      path: '/',
      headers: { 'x-amz-date': '20150830T123600Z' },
      body: '',
      region: 'us-east-1',
      service: 'service',
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: SECRET,
        sessionToken: '',
      },
      amzDate: '20150830T123600Z',
    })
    assert.equal(
      auth,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    )
  })
})

describe('s2w-replies-upload', () => {
  const args = { outreachId: '12345', exportPath: EXPORT }

  it('PUTs the export to agent-replies/<id>.csv, signed, then deletes it', async () => {
    const h = harness()
    const out = await run(args, h.deps)
    assert.deepEqual(out, {
      key: 'agent-replies/12345.csv',
      bytes: new TextEncoder().encode(BODY).length,
    })
    const put = h.calls.find((c) => c.method === 'PUT' && c.url.includes('s3.'))
    assert.ok(put)
    assert.equal(
      put.url,
      'https://gp-replies-dev.s3.us-west-2.amazonaws.com/agent-replies/12345.csv',
    )
    assert.equal(put.body, BODY)
    assert.equal(put.headers['x-amz-security-token'], SESSION_TOKEN)
    assert.match(
      put.headers.authorization,
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261102\/us-west-2\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    )
    assert.equal(h.files.has(EXPORT), false)
  })

  it('keeps the export and leaks nothing when S3 rejects the PUT', async () => {
    const h = harness(
      () => new Response('<Error><Code>AccessDenied</Code><Message>arn:secret</Message></Error>', { status: 403 }),
    )
    await assert.rejects(run(args, h.deps), (e: Error) => {
      assert.equal(e.message, 'S3 PUT failed: 403 AccessDenied')
      return true
    })
    assert.equal(h.files.has(EXPORT), true)
  })

  it('never returns the credentials or signature', async () => {
    const h = harness()
    const text = JSON.stringify(await run(args, h.deps))
    for (const secret of [SESSION_TOKEN, SECRET, 'AKIDEXAMPLE', 'AWS4-HMAC']) {
      assert.ok(!text.includes(secret))
    }
  })

  it('refuses a path outside agent-fs and an empty export', async () => {
    const h = harness()
    await assert.rejects(run({ ...args, exportPath: '/etc/passwd' }, h.deps), {
      message: 'exportPath must be under /afs',
    })
    await assert.rejects(run({ ...args, exportPath: '/afs/../etc/x' }, h.deps), {
      message: 'exportPath must be under /afs',
    })
    h.files.set(EXPORT, '')
    await assert.rejects(run(args, h.deps), { message: 'export is empty' })
    assert.equal(h.calls.length, 0)
  })

  it('accepts a numeric outreach id and rejects one that could shape the key', () => {
    assert.equal(argsSchema.parse({ outreachId: 12345, exportPath: EXPORT }).outreachId, '12345')
    assert.equal(argsSchema.safeParse({ outreachId: '1/../2', exportPath: EXPORT }).success, false)
  })
})
