import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import type { SubmitOptions } from './delegate.ts'
import { COMMENT_MARKER, handleGithubWebhook, verifySignature } from './github.ts'

const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

const comment = (login: string, body: string, association = 'MEMBER') =>
  JSON.stringify({
    action: 'created',
    repository: { full_name: 'thegoodparty/omni' },
    issue: { number: 12, pull_request: {} },
    comment: { id: 1, body, user: { login }, author_association: association },
  })

const deliver = async (body: string, signature: string) => {
  const submitted: { key: string; options: SubmitOptions }[] = []
  const result = await handleGithubWebhook({
    delegate: {
      submit: async (key, options) => {
        submitted.push({ key, options })
        return options.create ? ({} as never) : undefined
      },
    },
    secret: 'shh',
    botLogin: 'delegate-gp[bot]',
    mention: '@delegate-gp',
    event: 'issue_comment',
    signature,
    rawBody: Buffer.from(body),
  })
  return { result, submitted }
}

test('verifySignature accepts the right HMAC and rejects anything else', () => {
  const body = Buffer.from('{"a":1}')
  assert.equal(verifySignature('shh', body, sign('shh', '{"a":1}')), true)
  assert.equal(verifySignature('shh', body, sign('other', '{"a":1}')), false)
  assert.equal(verifySignature('shh', body, 'sha256=short'), false)
  assert.equal(verifySignature('shh', body, undefined), false)
  assert.equal(verifySignature('', body, sign('', '{"a":1}')), false)
})

test('a webhook with a bad signature is rejected before anything is submitted', async () => {
  const body = comment('swain', '@delegate-gp hi')
  const { result, submitted } = await deliver(body, sign('wrong', body))
  assert.equal(result.status, 401)
  assert.equal(submitted.length, 0)
})

test('a mention on an unlinked PR starts a conversation keyed to the PR', async () => {
  const body = comment('swain', '@delegate-gp can you look at this?')
  const { result, submitted } = await deliver(body, sign('shh', body))
  assert.deepEqual(result, { status: 202, body: { status: 'submitted' } })
  assert.equal(submitted[0].key, 'github:thegoodparty/omni:pr:12')
  assert.equal(submitted[0].options.create, true)
  assert.equal(submitted[0].options.requestId, 'github:comment:1')
})

test('comments from the bot itself are ignored', async () => {
  for (const body of [comment('delegate-gp[bot]', '@delegate-gp done'), comment('swain', `answer\n\n${COMMENT_MARKER}`)]) {
    const { result, submitted } = await deliver(body, sign('shh', body))
    assert.deepEqual(result, { status: 202, body: { status: 'ignored', reason: 'own comment' } })
    assert.equal(submitted.length, 0)
  }
})

test('comments from people outside the org are ignored', async () => {
  const body = comment('stranger', '@delegate-gp run this', 'NONE')
  const { result, submitted } = await deliver(body, sign('shh', body))
  assert.deepEqual(result, { status: 202, body: { status: 'ignored', reason: 'not an org member' } })
  assert.equal(submitted.length, 0)
})
