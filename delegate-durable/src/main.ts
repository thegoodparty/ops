import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openDelegate } from './delegate.ts'
import { githubPoster } from './github.ts'
import { startHttp } from './http.ts'
import { createDelegateModels } from './models.ts'
import { createSlack, startSlack } from './slack.ts'

const required = (name: string) => {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

const dataDir = required('DELEGATE_DATA')
const slack = createSlack({ botToken: required('SLACK_BOT_TOKEN'), appToken: required('SLACK_APP_TOKEN') })

const delegate = await openDelegate({
  dataDir,
  omniRepo: process.env.OMNI_REPO,
  models: createDelegateModels(),
  model: {
    provider: process.env.DELEGATE_MODEL_PROVIDER ?? 'anthropic',
    modelId: process.env.DELEGATE_MODEL_ID ?? 'claude-sonnet-5-5',
  },
  persona: await readFile(join(import.meta.dirname, '..', 'prompts', 'delegate.md'), 'utf8'),
  postSlack: slack.postSlack,
  postGithub: githubPoster(required('GITHUB_TOKEN')),
  homeChannel: process.env.DELEGATE_HOME_CHANNEL,
  onReport: (report) => console.error(`report ${report.kind}`, report.error),
})
delegate.harness.resume()

const server = startHttp({
  port: Number(process.env.PORT ?? 3080),
  host: process.env.DELEGATE_HTTP_HOST ?? '127.0.0.1',
  delegate,
  webhookSecret: required('GITHUB_WEBHOOK_SECRET'),
  botLogin: process.env.GITHUB_BOT_LOGIN ?? 'delegate-gp[bot]',
  mention: process.env.GITHUB_MENTION ?? '@delegate-gp',
})

await startSlack({
  app: slack.app,
  delegate,
  allowedEmailDomains: (process.env.DELEGATE_ALLOWED_EMAIL_DOMAINS ?? 'goodparty.org')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain !== ''),
})
console.log('delegate-durable running')

delegate.harness.closed.then((end) => {
  if (end.kind === 'failed') {
    console.error('harness failed', end.error)
    process.exit(1)
  }
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    server.close()
    await slack.app.stop().catch(() => undefined)
    await delegate.close()
    process.exit(0)
  })
}
