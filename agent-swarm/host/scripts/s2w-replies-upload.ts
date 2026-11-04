import type { ScriptContext } from 'swarm-sdk'
import * as z from 'zod'

// Puts an agent's replies export in the replies bucket. The instance role's
// credentials stay inside this script, and every error message below is built
// from status codes and fixed text, never from a header, signature or
// response body. The export holds constituent data, so it is deleted from
// agent-fs once the PUT lands.

const IMDS = 'http://169.254.169.254'
const TIMEOUT_MS = 10_000
const PUT_TIMEOUT_MS = 20_000
const DEFAULT_REGION = 'us-west-2'
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

export const argsSchema = z.object({
  outreachId: z.coerce.string().regex(/^\d+$/),
  exportPath: z.string(),
})

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

type AwsCredentials = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
}

const timedFetch = async (
  fetchFn: Fetch,
  url: string,
  init: RequestInit,
  what: string,
  timeoutMs: number = TIMEOUT_MS,
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchFn(url, { ...init, signal: controller.signal })
  } catch {
    throw new Error(`${what} request failed`)
  } finally {
    clearTimeout(timer)
  }
}

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

const sha256Hex = async (text: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

const hmac = async (
  key: ArrayBuffer | Uint8Array,
  data: string,
): Promise<ArrayBuffer> => {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
}

export type SignInput = {
  method: string
  host: string
  path: string
  headers: Record<string, string>
  body: string
  region: string
  service: string
  credentials: AwsCredentials
  amzDate: string
}

// AWS Signature Version 4 for a request with no query string. Returns the
// Authorization header value; `headers` must already hold every header to sign
// except host, which is added here.
export const signV4 = async (input: SignInput): Promise<string> => {
  const { method, host, path, headers, body, region, service, credentials } =
    input
  const dateStamp = input.amzDate.slice(0, 8)
  const all: Record<string, string> = { ...headers, host }
  const names = Object.keys(all)
    .map((n) => n.toLowerCase())
    .sort()
  const lowered = Object.fromEntries(
    Object.entries(all).map(([k, v]) => [k.toLowerCase(), v.trim()]),
  )
  const canonicalHeaders = names.map((n) => `${n}:${lowered[n]}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalRequest = [
    method,
    path,
    '',
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(body),
  ].join('\n')
  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    input.amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n')
  const kDate = await hmac(
    new TextEncoder().encode(`AWS4${credentials.secretAccessKey}`),
    dateStamp,
  )
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, service)
  const kSigning = await hmac(kService, 'aws4_request')
  const signature = hex(await hmac(kSigning, stringToSign))
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

// The IMDS hop limit is 2, so the swarm API container can reach it; the
// instance role is the same identity as the `host` AWS profile.
export const instanceCredentials = async (
  fetchFn: Fetch,
): Promise<AwsCredentials> => {
  const tokenRes = await timedFetch(
    fetchFn,
    `${IMDS}/latest/api/token`,
    {
      method: 'PUT',
      headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '60' },
    },
    'IMDS token',
  )
  if (!tokenRes.ok) throw new Error(`IMDS token failed: ${tokenRes.status}`)
  const imdsHeaders = { 'x-aws-ec2-metadata-token': await tokenRes.text() }
  const roleRes = await timedFetch(
    fetchFn,
    `${IMDS}/latest/meta-data/iam/security-credentials/`,
    { headers: imdsHeaders },
    'IMDS role',
  )
  if (!roleRes.ok) throw new Error(`IMDS role failed: ${roleRes.status}`)
  const role = (await roleRes.text()).split('\n')[0].trim()
  if (!role) throw new Error('IMDS role missing')
  const credRes = await timedFetch(
    fetchFn,
    `${IMDS}/latest/meta-data/iam/security-credentials/${role}`,
    { headers: imdsHeaders },
    'IMDS credentials',
  )
  if (!credRes.ok) throw new Error(`IMDS credentials failed: ${credRes.status}`)
  const parsed = z
    .object({
      AccessKeyId: z.string(),
      SecretAccessKey: z.string(),
      Token: z.string(),
    })
    .safeParse(await credRes.json())
  if (!parsed.success) throw new Error('IMDS credentials invalid')
  return {
    accessKeyId: parsed.data.AccessKeyId,
    secretAccessKey: parsed.data.SecretAccessKey,
    sessionToken: parsed.data.Token,
  }
}

const amzDateOf = (now: Date): string =>
  now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

type FsLike = Pick<ScriptContext['fs'], 'readFile' | 'rm'>

export type Deps = {
  fetchFn: Fetch
  fs: FsLike
  bucket: string
  region?: string
  now?: () => Date
}

export const run = async (
  args: z.infer<typeof argsSchema>,
  deps: Deps,
): Promise<{ key: string; bytes: number }> => {
  const { exportPath } = args
  if (!exportPath.startsWith('/afs/') || exportPath.split('/').includes('..')) {
    throw new Error('exportPath must be under /afs')
  }
  if (!BUCKET_PATTERN.test(deps.bucket)) throw new Error('REPLIES_BUCKET invalid')
  const region = deps.region ?? DEFAULT_REGION
  const body = await deps.fs.readFile(exportPath)
  if (body.length === 0) throw new Error('export is empty')

  const key = `agent-replies/${args.outreachId}.csv`
  const host = `${deps.bucket}.s3.${region}.amazonaws.com`
  const credentials = await instanceCredentials(deps.fetchFn)
  const amzDate = amzDateOf(deps.now?.() ?? new Date())
  const headers = {
    'content-type': 'text/csv',
    'x-amz-content-sha256': await sha256Hex(body),
    'x-amz-date': amzDate,
    'x-amz-security-token': credentials.sessionToken,
  }
  const authorization = await signV4({
    method: 'PUT',
    host,
    path: `/${key}`,
    headers,
    body,
    region,
    service: 's3',
    credentials,
    amzDate,
  })
  const res = await timedFetch(
    deps.fetchFn,
    `https://${host}/${key}`,
    { method: 'PUT', headers: { ...headers, authorization }, body },
    'S3',
    PUT_TIMEOUT_MS,
  )
  if (!res.ok) {
    const code =
      /<Code>([A-Za-z0-9.]+)<\/Code>/.exec(await res.text())?.[1] ?? 'unknown'
    throw new Error(`S3 PUT failed: ${res.status} ${code}`)
  }
  await deps.fs.rm(exportPath)
  return { key, bytes: new TextEncoder().encode(body).length }
}

export default async function (
  args: z.infer<typeof argsSchema>,
  ctx: ScriptContext,
) {
  const bucket = ctx.swarm.config.get('REPLIES_BUCKET')
  if (bucket === undefined) throw new Error('REPLIES_BUCKET missing')
  const region = ctx.swarm.config.get('REPLIES_BUCKET_REGION')
  return run(args, {
    fetchFn: (url, init) => fetch(url, init),
    fs: ctx.fs,
    bucket: ctx.stdlib.Redacted.value(bucket),
    region: region === undefined ? undefined : ctx.stdlib.Redacted.value(region),
  })
}
