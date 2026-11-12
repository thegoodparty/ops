import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Delegate, PostGithub } from './delegate.ts'

export const COMMENT_MARKER = '<!-- delegate-durable -->'

export const verifySignature = (secret: string, rawBody: Buffer, header: string | undefined) => {
  if (secret === '' || header === undefined || !header.startsWith('sha256=')) return false
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`)
  const given = Buffer.from(header)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

type CommentPayload = {
  action?: string
  repository?: { full_name: string }
  issue?: { number: number; pull_request?: unknown }
  pull_request?: { number: number }
  comment?: {
    id: number
    body?: string
    user?: { login: string }
    author_association?: string
    path?: string
    line?: number | null
  }
}

export const handleGithubWebhook = async (options: {
  delegate: Pick<Delegate, 'submit'>
  secret: string
  botLogin: string
  mention: string
  event: string | undefined
  signature: string | undefined
  rawBody: Buffer
}) => {
  if (!verifySignature(options.secret, options.rawBody, options.signature)) {
    return { status: 401, body: { error: 'invalid signature' } }
  }
  const ignored = (reason: string) => ({ status: 202, body: { status: 'ignored', reason } })
  const payload = JSON.parse(options.rawBody.toString('utf8')) as CommentPayload
  const { comment, repository } = payload
  if (payload.action !== 'created' || comment === undefined || repository === undefined) return ignored('not a new comment')
  const number =
    options.event === 'issue_comment' && payload.issue?.pull_request !== undefined
      ? payload.issue.number
      : options.event === 'pull_request_review_comment'
        ? payload.pull_request?.number
        : undefined
  if (number === undefined) return ignored('not a pull request comment')
  const body = comment.body ?? ''
  const login = comment.user?.login ?? 'unknown'
  if (login === options.botLogin || body.includes(COMMENT_MARKER)) return ignored('own comment')
  if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.author_association ?? '')) return ignored('not an org member')
  const repo = repository.full_name
  const where = comment.path === undefined ? '' : ` on ${comment.path}${comment.line ? `:${comment.line}` : ''}`
  const submission = await options.delegate.submit(`github:${repo}:pr:${number}`, {
    content: `GitHub comment from @${login} on ${repo}#${number}${where}:\n\n${body}`,
    requestId: `github:comment:${comment.id}`,
    origin: { github: { repo, number } },
    create: body.includes(options.mention),
  })
  if (submission === undefined) return ignored('pull request not linked and no mention')
  return { status: 202, body: { status: 'submitted' } }
}

export const githubPoster =
  (token: string): PostGithub =>
  async ({ repo, number, text }) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'delegate-durable',
      },
      body: JSON.stringify({ body: `${text}\n\n${COMMENT_MARKER}` }),
    })
    if (!response.ok) throw new Error(`GitHub comment on ${repo}#${number} failed: ${response.status}`)
  }
