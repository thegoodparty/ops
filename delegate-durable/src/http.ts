import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Delegate } from './delegate.ts'
import { handleGithubWebhook } from './github.ts'

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > 5_000_000) throw new Error('Body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

const send = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

export const startHttp = (options: {
  port: number
  host: string
  delegate: Delegate
  webhookSecret: string
  botLogin: string
  mention: string
}) =>
  createServer(async (request, response) => {
    try {
      const path = request.url?.split('?')[0]
      if (request.method === 'GET' && path === '/healthz') return send(response, 200, { ok: true })
      if (request.method === 'GET' && path === '/status') return send(response, 200, await options.delegate.status())
      if (request.method === 'POST' && path === '/webhooks/github') {
        const result = await handleGithubWebhook({
          delegate: options.delegate,
          secret: options.webhookSecret,
          botLogin: options.botLogin,
          mention: options.mention,
          event: request.headers['x-github-event'] as string | undefined,
          signature: request.headers['x-hub-signature-256'] as string | undefined,
          rawBody: await readBody(request),
        })
        return send(response, result.status, result.body)
      }
      send(response, 404, { error: 'not found' })
    } catch (error) {
      console.error('http error', error)
      send(response, 500, { error: 'internal error' })
    }
  }).listen(options.port, options.host)
